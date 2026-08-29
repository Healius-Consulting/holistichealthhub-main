import type { PatientOrder, UnresolvedOrderReason } from '../context/AppContext';

export type OrderStage =
  | 'awaiting-payment'
  | 'paid'
  | 'curaleaf-pending'
  | 'curaleaf-approved'
  | 'dispatched'
  | 'delivered'
  | 'ready'
  | 'collected'
  | 'rejected'
  | 'archived'
  | 'cancelled';

export type StageFilter = 'current' | 'all' | 'awaiting-payment' | 'awaiting-fulfilment' | 'ready' | 'rejected' | 'archived' | 'completed' | 'cancelled';

export type CancellationResolution = 'none' | 'needs-action' | 'resolved' | 'refunded';

/**
 * The pharmacy's direct cancellation action is strictly a pre-payment action.
 * Check both fields so a live record fails closed while payment updates settle.
 */
export function orderPaymentAllowsManualCancellation(order: Pick<PatientOrder, 'payment'>) {
  return !order.payment.paidAt && (order.payment.status === 'none' || order.payment.status === 'sent');
}

export function unpaidCancellationConfirmation(route: PatientOrder['payment']['route']) {
  return route === 'worldpay'
    ? 'Order cancelled and its payment link retired in the platform.'
    : 'Order cancelled. No patient payment was recorded.';
}

export function hasDispatchedRemainder(line: { ordered: number; shipped: number }) {
  return line.shipped > 0 && line.shipped < line.ordered;
}

type OrderPrescription = PatientOrder['prescriptions'][number];

export function prescriptionIsCancelled(prescription: OrderPrescription) {
  return prescription.status === 'cancelled' || prescription.purchaseOrderState === 'CANCELLED';
}

function prescriptionUsesPackProgress(prescription: OrderPrescription) {
  return (prescription.fulfilmentLines ?? []).length > 0;
}

export function prescriptionPackTotals(prescription: OrderPrescription) {
  const lines = prescription.fulfilmentLines ?? [];
  return lines.reduce((totals, line) => ({
    ordered: totals.ordered + line.ordered,
    shipped: totals.shipped + line.shipped,
    received: totals.received + line.received,
    collected: totals.collected + line.collected,
    remaining: totals.remaining + line.remaining,
  }), { ordered: 0, shipped: 0, received: 0, collected: 0, remaining: 0 });
}

/**
 * Supply is incomplete while the supplier still owes packs or goods-in has not
 * verified everything dispatched. Collection is deliberately excluded: packs
 * sitting on the dispensary shelf are ready to hand out, not outstanding stock.
 */
export function prescriptionSupplyIncomplete(prescription: OrderPrescription) {
  return (prescription.fulfilmentLines ?? []).some(line => line.remaining > 0 || line.received < line.ordered);
}

export function orderSupplyIncomplete(order: PatientOrder) {
  return order.prescriptions.some(prescription =>
    !prescriptionIsCancelled(prescription) && prescriptionSupplyIncomplete(prescription),
  );
}

/** Packs verified into the dispensary that the patient has not collected yet. */
export function prescriptionUncollectedReadyPacks(prescription: OrderPrescription) {
  return (prescription.fulfilmentLines ?? []).reduce((sum, line) => sum + Math.max(0, line.received - line.collected), 0);
}

export function orderUncollectedReadyPacks(order: PatientOrder) {
  return order.prescriptions.reduce((sum, prescription) =>
    prescriptionIsCancelled(prescription) ? sum : sum + prescriptionUncollectedReadyPacks(prescription), 0);
}

export function orderPackTotals(order: PatientOrder) {
  return order.prescriptions.reduce((totals, prescription) => {
    const packs = prescriptionPackTotals(prescription);
    return {
      ordered: totals.ordered + packs.ordered,
      shipped: totals.shipped + packs.shipped,
      received: totals.received + packs.received,
      collected: totals.collected + packs.collected,
      remaining: totals.remaining + packs.remaining,
    };
  }, { ordered: 0, shipped: 0, received: 0, collected: 0, remaining: 0 });
}

export function orderAllocatedPacks(order: PatientOrder) {
  return order.prescriptions.reduce((sum, prescription) => {
    const lines = prescription.fulfilmentLines ?? [];
    if (lines.length) return sum + lines.reduce((lineSum, line) => lineSum + (line.allocated ?? 0), 0);
    return sum + (prescription.supplierItems ?? []).reduce((itemSum, item) => itemSum + (item.packsAllocatedCount ?? 0), 0);
  }, 0);
}

export function orderSplitPackSnapshot(order: PatientOrder) {
  const totals = orderPackTotals(order);
  const allocated = orderAllocatedPacks(order);
  const shipped = totals.shipped;
  return {
    total: totals.ordered,
    collected: totals.collected,
    atPharmacy: Math.max(0, totals.received - totals.collected),
    inTransit: Math.max(0, shipped - totals.received),
    dispensedAtCuraleaf: Math.max(0, Math.min(allocated, totals.ordered) - shipped),
    awaitingDispense: Math.max(0, totals.ordered - allocated),
    withCuraleaf: Math.max(0, totals.ordered - shipped),
  };
}

export function orderHasPartialCuraleafDispense(order: PatientOrder) {
  const snapshot = orderSplitPackSnapshot(order);
  return snapshot.total > 0 && snapshot.dispensedAtCuraleaf > 0 && snapshot.awaitingDispense > 0;
}

export function orderIsSplitFulfilment(order: PatientOrder) {
  const snapshot = orderSplitPackSnapshot(order);
  if (snapshot.total <= 0) return false;
  if (orderHasPartialCuraleafDispense(order)) return true;
  if (order.prescriptions.some(prescription => prescription.dispatchStatus === 'partial')) return true;
  if (snapshot.withCuraleaf > 0 && (snapshot.inTransit > 0 || snapshot.atPharmacy > 0 || snapshot.collected > 0)) return true;
  if (snapshot.collected > 0 && snapshot.collected < snapshot.total) return true;
  if (snapshot.atPharmacy > 0 && snapshot.atPharmacy + snapshot.collected < snapshot.total) return true;
  return snapshot.inTransit > 0 && snapshot.inTransit < snapshot.total;
}

export function orderHasInTransitPacks(order: PatientOrder) {
  return order.prescriptions.some(prescription => prescriptionHasInTransitPacks(prescription));
}

export function orderHasUncollectedReceivedPacks(order: PatientOrder) {
  return order.prescriptions.some(prescription => {
    if (prescriptionUsesPackProgress(prescription)) {
      const { received, collected } = prescriptionPackTotals(prescription);
      return received > collected;
    }
    return prescription.status === 'ready';
  });
}

export function orderHasPartialCollection(order: PatientOrder) {
  return order.prescriptions.some(prescription => {
    const { ordered, collected } = prescriptionPackTotals(prescription);
    return collected > 0 && collected < ordered;
  });
}

export function orderAwaitingSupplierShipmentProductNames(order: PatientOrder) {
  const names = order.prescriptions.flatMap(prescription => (prescription.fulfilmentLines ?? []).flatMap(line => {
    const awaitingShipment = line.ordered > line.shipped;
    const inTransit = line.shipped > line.received;
    if (!awaitingShipment || inTransit) return [];
    const product = prescription.items.find(item => item.productId === line.productId);
    return product?.name ? [product.name] : [];
  }));
  return [...new Set(names)];
}

export function orderInTransitProductNames(order: PatientOrder) {
  const names = order.prescriptions.flatMap(prescription => (prescription.fulfilmentLines ?? []).flatMap(line => {
    if (line.shipped <= line.received) return [];
    const product = prescription.items.find(item => item.productId === line.productId);
    return product?.name ? [product.name] : [];
  }));
  return [...new Set(names)];
}

export function prescriptionStatusLabel(prescription: OrderPrescription) {
  if (prescriptionIsCancelled(prescription)) return 'Cancelled Purchase Order';
  const totals = prescriptionPackTotals(prescription);
  const remainingOpen = (prescription.fulfilmentLines ?? []).some(line =>
    line.remaining > 0 || line.received < line.ordered || line.collected < line.ordered,
  );
  const hasCheckedInPacks = totals.received > 0
    || ['received', 'partially-received', 'ready', 'collected'].includes(prescription.status);

  if (prescription.status === 'collected' && !remainingOpen) return 'Collected';
  if (totals.collected > 0 && remainingOpen) return 'Part Collected';
  if (hasCheckedInPacks && totals.received >= totals.collected && totals.collected > 0 && remainingOpen) {
    return 'Part Collected';
  }
  if (prescription.status === 'partially-received' && !hasCheckedInPacks && totals.shipped > 0) {
    return prescription.dispatchStatus === 'partial' ? 'Part In Transit' : 'In Transit';
  }
  if (!prescription.placed && ['draft', 'awaiting-approval'].includes(prescription.status)) {
    return 'Waiting for Curaleaf';
  }
  if (hasCheckedInPacks && totals.received > totals.collected) {
    return totals.received < totals.ordered ? 'Part Ready to Collect' : 'Ready to Collect';
  }

  return ({
    draft: 'Draft',
    'awaiting-approval': 'Waiting for Curaleaf',
    processing: 'Curaleaf Dispensing',
    approved: 'Curaleaf Dispensing',
    dispatched: prescription.dispatchStatus === 'partial' ? 'Part In Transit' : 'In Transit',
    'partially-received': 'Part Checked In',
    received: 'Checked In',
    ready: 'Ready to Collect',
    collected: 'Collected',
    cancelled: 'Cancelled Purchase Order',
  } as const)[prescription.status];
}

export type OrderFulfilmentHeadline = {
  label: string;
  prescriptionSummaries: string[];
  mixedPrescriptions: boolean;
};

/**
 * Stable, pharmacy-facing status for the order-record header. Pack fractions are
 * deliberately excluded: the header sits beside a prescription count, so a
 * fraction there can otherwise be mistaken for prescriptions completed.
 */
export function orderFulfilmentHeadline(order: PatientOrder): OrderFulfilmentHeadline | null {
  const prescriptions = order.prescriptions
    .map((prescription, index) => ({ prescription, number: index + 1 }))
    .filter(({ prescription }) => !prescriptionIsCancelled(prescription));
  if (!prescriptions.length) return null;

  const displayLabel = (prescription: OrderPrescription) => {
    const label = prescriptionStatusLabel(prescription);
    return ({
      'Part In Transit': 'In transit',
      'In Transit': 'In transit',
      'Part Checked In': 'Checked in',
      'Checked In': 'Checked in',
      'Part Ready to Collect': 'Ready',
      'Ready to Collect': 'Ready',
    } as Record<string, string>)[label] ?? label;
  };

  const summaryLabel = (prescription: OrderPrescription) => {
    const label = displayLabel(prescription);
    return label === 'Curaleaf Dispensing' ? 'Being prepared' : label;
  };

  const prescriptionSummaries = prescriptions.map(({ prescription, number }) =>
    `Prescription ${number}: ${summaryLabel(prescription)}`,
  );
  const labels = prescriptions.map(({ prescription }) => displayLabel(prescription));
  const mixedPrescriptions = new Set(labels).size > 1;

  if (labels.every(label => label === 'Collected')) {
    return { label: 'Collected', prescriptionSummaries, mixedPrescriptions: false };
  }
  if (mixedPrescriptions) {
    return { label: 'Split fulfilment', prescriptionSummaries, mixedPrescriptions: true };
  }
  if (orderIsSplitFulfilment(order)) {
    return { label: 'Split delivery', prescriptionSummaries, mixedPrescriptions: false };
  }
  return { label: labels[0]!, prescriptionSummaries, mixedPrescriptions: false };
}

export function prescriptionStatusChipTone(prescription: OrderPrescription) {
  if (prescriptionIsCancelled(prescription)) return 'cancelled';
  const totals = prescriptionPackTotals(prescription);
  const remainingOpen = (prescription.fulfilmentLines ?? []).some(line =>
    line.remaining > 0 || line.received < line.ordered || line.collected < line.ordered,
  );

  if (prescription.dispatchStatus === 'partial') return 'partial';
  if (prescription.status === 'partially-received') return 'partial';
  if (totals.collected > 0 && totals.collected < totals.ordered) return 'partial';
  if (totals.received > 0 && totals.received < totals.ordered) return 'partial';
  if (totals.shipped > 0 && totals.shipped < totals.ordered && remainingOpen) return 'partial';

  return prescription.status;
}

function prescriptionHasCheckedInPacks(prescription: OrderPrescription) {
  if (prescriptionUsesPackProgress(prescription)) {
    return prescriptionPackTotals(prescription).received > 0;
  }
  return ['received', 'partially-received', 'ready', 'collected'].includes(prescription.status);
}

function prescriptionHasInTransitPacks(prescription: OrderPrescription) {
  if (prescriptionUsesPackProgress(prescription)) {
    const { shipped, received } = prescriptionPackTotals(prescription);
    return shipped > received;
  }
  if (prescription.status === 'dispatched') return true;
  return Boolean(prescription.shipmentIds?.length)
    && !['received', 'partially-received', 'ready', 'collected'].includes(prescription.status);
}

function prescriptionReadyForCollection(prescription: OrderPrescription) {
  if (!prescriptionHasCheckedInPacks(prescription)) return false;
  // In this pharmacy workflow physical check-in is the ready decision. Keep
  // legacy `received` records collectable too so they cannot become shelf stock
  // stranded between two UI stages after this rule changes.
  return ['received', 'partially-received', 'ready'].includes(prescription.status)
    || Object.values(prescription.shipmentStates ?? {}).some(state =>
      state === 'received' || state === 'partially_received' || state === 'ready_for_collection',
    );
}

function prescriptionDeliveredAtPharmacy(prescription: OrderPrescription) {
  if (!prescriptionHasCheckedInPacks(prescription)) return false;
  if (prescriptionReadyForCollection(prescription)) return false;
  return prescription.status === 'received'
    || prescription.status === 'partially-received'
    || Object.values(prescription.shipmentStates ?? {}).some(state =>
      state === 'received' || state === 'partially_received',
    );
}

function orderHasOpenRemainder(order: PatientOrder) {
  return order.prescriptions.some(prescription =>
    (prescription.fulfilmentLines ?? []).some(line => line.remaining > 0 || line.received < line.ordered || line.collected < line.ordered),
  );
}

/** Partial split: some packs checked in at pharmacy while supplier remainder is still open. */
export function orderHasPartialPharmacyReceipt(order: PatientOrder) {
  if (!orderHasOpenRemainder(order)) return false;
  return order.prescriptions.some(prescription => {
    if (!prescriptionHasCheckedInPacks(prescription)) return false;
    if (!prescriptionUsesPackProgress(prescription)) return prescription.status === 'partially-received';
    const { ordered, received } = prescriptionPackTotals(prescription);
    return received > 0 && received < ordered;
  });
}

function orderAllOrderedPacksReceived(order: PatientOrder) {
  return order.prescriptions.every(prescription => {
    if (!prescriptionUsesPackProgress(prescription)) {
      return ['received', 'ready', 'collected'].includes(prescription.status);
    }
    const { ordered, received } = prescriptionPackTotals(prescription);
    return received >= ordered;
  });
}

/**
 * Pharmacy can cancel in HHH only before/during the second quote check.
 * After Prescriber → Prescription → Purchase starts, Curaleaf owns cancellation.
 */
export function orderRequiresCuraleafCancel(order: PatientOrder): boolean {
  if (order.curaleafCancellation?.status === 'confirmed') return false;
  const livePurchaseOrder = order.prescriptions.some(prescription =>
    Boolean(prescription.purchaseOrderState)
    && prescription.purchaseOrderState !== 'CANCELLED'
  );
  const livePrescription = order.prescriptions.some(prescription =>
    prescription.curaleafPrescriptionState === 'PENDING'
    || prescription.curaleafPrescriptionState === 'ACTIVE'
    || prescription.curaleafPrescriptionState === 'FULFILLED'
    || Boolean(prescription.curaleafPrescriptionId)
  );
  if (livePurchaseOrder || livePrescription) return true;
  if (order.prescriptions.some(prescription =>
    prescription.purchaseOrderState === 'CANCELLED'
    || prescription.curaleafPrescriptionState === 'CANCELLED'
  )) {
    return false;
  }
  return order.prescriptions.some(prescription => prescription.placed);
}

/** HHH started cancel/refund while Rocky still has a live PO or accepted prescription. */
export function orderAwaitingCuraleafCancel(order: PatientOrder): boolean {
  if (!orderRequiresCuraleafCancel(order)) return false;
  return order.lifecycleStatus === 'cancelled'
    || Boolean(order.cancellation)
    || Boolean(order.curaleafCancellation)
    || Boolean(order.refund)
    || order.payment.status === 'refunded'
    || order.payment.status === 'refund_required';
}

/**
 * Cancellation is an order outcome, not a patient status. Keep unfinished
 * supplier/refund work operational while demoting closed cancellations.
 */
function supplierCancelled(order: PatientOrder) {
  return order.unresolvedReason === 'cancelled'
    || order.cancellation?.status === 'refund_required'
    || order.curaleafCancellation?.status === 'confirmed'
    || order.prescriptions.some(rx => rx.status === 'cancelled' || rx.purchaseOrderState === 'CANCELLED');
}

export function orderCancellationResolution(order: PatientOrder): CancellationResolution {
  if (order.resolution?.status === 'REFUNDED') return 'refunded';
  if (order.resolution && ['REPLACED', 'SPLIT_RESOLVED'].includes(order.resolution.status)) return 'resolved';
  if (order.resolution && ['REPLACEMENT_PENDING', 'REFUND_REQUIRED', 'REFUND_VERIFYING', 'RECONCILIATION_REQUIRED'].includes(order.resolution.status)) return 'needs-action';
  if (!order.cancellation && order.lifecycleStatus !== 'cancelled' && !supplierCancelled(order)) return 'none';
  if (orderRequiresCuraleafCancel(order)) return 'needs-action';
  if (order.redoneByOrderId) return order.refund?.status === 'completed' ? 'refunded' : 'resolved';
  if (order.refund?.status === 'completed') return 'refunded';

  const supplierActionOutstanding = ['contact_required', 'awaiting_confirmation'].includes(order.curaleafCancellation?.status ?? '')
    || ['curaleaf_contact_required', 'awaiting_curaleaf_confirmation'].includes(order.cancellation?.status ?? '');
  const refundActionOutstanding = order.cancellation?.status === 'refund_required'
    || Boolean(order.refund)
    || order.payment.status === 'paid';

  if (supplierActionOutstanding || refundActionOutstanding) return 'needs-action';
  return 'resolved';
}

function unresolvedOrderReason(order: PatientOrder, now: Date): UnresolvedOrderReason | null {
  if (order.payment.status === 'none') return null;
  if (order.prescriptions.length > 0 && order.prescriptions.every(prescription => prescription.status === 'collected')) return null;
  if (order.redoneByOrderId) return null;
  if (supplierCancelled(order)) return 'cancelled';
  if (order.unresolvedReason === 'expired' || order.unresolvedReason === 'rejected') return order.unresolvedReason;
  if (order.redoEligible === false) return null;
  if (order.quoteReview?.status === 'recreate_required') return 'rejected';
  if (order.lifecycleStatus === 'archived' || order.isExpired) return 'expired';
  const entryDate = new Date(order.date);
  const expiryDate = order.cycleExpiresAt ? new Date(order.cycleExpiresAt) : (() => {
    const value = new Date(entryDate);
    value.setDate(value.getDate() + 28);
    return value;
  })();
  return now > expiryDate ? 'expired' : null;
}

export function orderStage(order: PatientOrder, now = new Date()): { stage: OrderStage; unresolvedReason: UnresolvedOrderReason | null } {
  const unresolvedReason = unresolvedOrderReason(order, now);
  if (order.lifecycleStatus === 'cancelled' || unresolvedReason === 'cancelled') return { stage: 'cancelled', unresolvedReason };
  if (unresolvedReason === 'expired' || order.unresolvedReason === 'expired' || order.lifecycleStatus === 'archived' || order.isExpired) return { stage: 'archived', unresolvedReason };
  if (unresolvedReason === 'rejected' || order.unresolvedReason === 'rejected') return { stage: 'rejected', unresolvedReason };
  if (order.payment.status === 'sent') return { stage: 'awaiting-payment', unresolvedReason };

  const statuses = order.prescriptions.map(prescription => prescription.status);
  const remainingOpen = orderHasOpenRemainder(order);
  const hasInTransitPacks = order.prescriptions.some(prescription => prescriptionHasInTransitPacks(prescription));
  const readyForCollection = order.prescriptions.some(prescription => prescriptionReadyForCollection(prescription));
  const deliveredAtPharmacy = !hasInTransitPacks
    && order.prescriptions.some(prescription => prescriptionDeliveredAtPharmacy(prescription));
  if (statuses.length && statuses.every(status => status === 'cancelled')) return { stage: 'cancelled', unresolvedReason };
  if (statuses.length && statuses.every(status => status === 'collected') && !remainingOpen) return { stage: 'collected', unresolvedReason };
  // Ready packs are the pharmacy's next action even if a later consignment is
  // still in transit. The remaining quantities stay visible as split fulfilment.
  if (readyForCollection) return { stage: 'ready', unresolvedReason };
  if (hasInTransitPacks) return { stage: 'dispatched', unresolvedReason };
  if (orderHasPartialPharmacyReceipt(order)) return { stage: 'dispatched', unresolvedReason };
  const usesPackProgress = order.prescriptions.some(prescriptionUsesPackProgress);
  if (deliveredAtPharmacy || (!usesPackProgress && statuses.some(status => status === 'received' || status === 'partially-received'))) {
    if (!usesPackProgress && statuses.some(status => status === 'partially-received') && remainingOpen) {
      return { stage: 'dispatched', unresolvedReason };
    }
    if (usesPackProgress && remainingOpen && !orderAllOrderedPacksReceived(order)) {
      return { stage: 'dispatched', unresolvedReason };
    }
    return { stage: 'delivered', unresolvedReason };
  }
  if (statuses.some(status => status === 'dispatched')) return { stage: 'dispatched', unresolvedReason };
  if (statuses.length && statuses.every(status => ['processing', 'approved', 'dispatched', 'partially-received', 'received', 'ready', 'collected', 'cancelled'].includes(status))) return { stage: 'curaleaf-approved', unresolvedReason };
  if (order.prescriptions.some(prescription => prescription.placed || prescription.status === 'awaiting-approval')) return { stage: 'curaleaf-pending', unresolvedReason };
  return { stage: 'paid', unresolvedReason };
}

export function stageMatchesFilter(stage: OrderStage, filter: StageFilter) {
  if (filter === 'current') return !['archived', 'collected', 'cancelled'].includes(stage);
  if (filter === 'all') return true;
  if (filter === 'awaiting-fulfilment') return ['paid', 'curaleaf-pending', 'curaleaf-approved', 'dispatched', 'delivered'].includes(stage);
  if (filter === 'archived') return stage === 'archived';
  if (filter === 'cancelled') return stage === 'cancelled';
  if (filter === 'completed') return stage === 'collected';
  return stage === filter;
}
