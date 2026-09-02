import type { PatientOrder, Prescription } from '../context/AppContext';

export type OrderTimelineEvent = {
  label: string;
  detail: string;
  date: Date | string | null;
  source: 'Pharmacy' | 'HHH automation' | 'Worldpay' | 'Curaleaf' | 'Dispensary';
};

function shortConsignmentId(id: string) {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function shipmentPackCount(shipment: NonNullable<Prescription['shipments']>[number]) {
  return (shipment.items ?? []).reduce((sum, item) => sum + Number(item.packCount || 0), 0);
}

function prescriptionPackTotals(prescription: Prescription) {
  const lines = prescription.fulfilmentLines ?? [];
  const fromLines = {
    ordered: lines.reduce((sum, line) => sum + (line.ordered ?? 0), 0),
    shipped: lines.reduce((sum, line) => sum + (line.shipped ?? 0), 0),
    received: lines.reduce((sum, line) => sum + (line.received ?? 0), 0),
    collected: lines.reduce((sum, line) => sum + (line.collected ?? 0), 0),
    remaining: lines.reduce((sum, line) => sum + (line.remaining ?? 0), 0),
  };
  if (fromLines.ordered > 0) return fromLines;
  const ordered = prescription.items.reduce((sum, item) => sum + item.qty, 0);
  return { ...fromLines, ordered };
}

/**
 * How many packs are actually ready for the patient to collect.
 *
 * Readiness is recorded per consignment, so it is summed from the consignments
 * that reached `ready_for_collection` (or were collected from) rather than
 * inferred from any one of them. A prescription whose own status is ready but
 * which has no per-consignment record falls back to its full ordered count,
 * which is the pre-split behaviour and correct for a single-consignment order.
 */
export function readyPackCountForPrescription(prescription: Prescription): number {
  const states = prescription.shipmentStates ?? {};
  const shipments = prescription.shipments ?? [];
  const readyIds = Object.entries(states)
    .filter(([, state]) => state === 'received' || state === 'partially_received' || state === 'ready_for_collection' || state === 'collected')
    .map(([id]) => id);

  if (readyIds.length && shipments.length) {
    const counted = shipments
      .filter(shipment => readyIds.includes(shipment.id))
      .reduce((packs, shipment) => packs + (shipment.items ?? []).reduce((n, item) => n + (item.packCount ?? 0), 0), 0);
    if (counted > 0) return counted;
  }

  const totals = prescriptionPackTotals(prescription);
  if (readyIds.length || ['received', 'partially-received', 'ready', 'collected'].includes(prescription.status)) {
    return Math.max(totals.ordered, totals.collected);
  }
  return totals.collected;
}

function readyPackCount(order: { prescriptions: Prescription[] }): number {
  return order.prescriptions.reduce((sum, prescription) => sum + readyPackCountForPrescription(prescription), 0);
}

function shipmentIdsFor(prescription: Prescription) {
  return prescription.shipmentIds?.length
    ? prescription.shipmentIds
    : prescription.shipmentId
      ? [prescription.shipmentId]
      : [];
}

export function buildPrescriptionTimelineEvents(
  prescription: Prescription,
  rxIndex: number,
  handoutAt?: Date | string | null,
): OrderTimelineEvent[] {
  const events: OrderTimelineEvent[] = [];
  const rxLabel = `Rx ${rxIndex + 1}`;
  const totals = prescriptionPackTotals(prescription);
  const shipmentIds = shipmentIdsFor(prescription);

  if (prescription.placed) {
    events.push({
      label: `${rxLabel} sent to Curaleaf`,
      detail: prescription.purchaseOrderId ? `PO ${prescription.purchaseOrderId}` : 'Awaiting supplier reference',
      date: prescription.placedAt ?? null,
      source: 'HHH automation',
    });
  }

  if (totals.shipped > 0) {
    if (shipmentIds.length) {
      for (const shipmentId of shipmentIds) {
        const shipment = prescription.shipments?.find(item => item.id === shipmentId);
        const packs = shipment ? shipmentPackCount(shipment) : 0;
        const state = prescription.shipmentStates?.[shipmentId];
        const dispatched = packs > 0
          || ['dispatched_to_pharmacy', 'partially_dispatched_to_pharmacy', 'partially_received', 'received', 'ready_for_collection', 'collected'].includes(String(state || ''));
        if (!dispatched) continue;
        events.push({
          label: totals.shipped < totals.ordered ? `${rxLabel} partial consignment dispatched` : `${rxLabel} consignment dispatched`,
          detail: `Consignment ${shortConsignmentId(shipmentId)} · ${packs || totals.shipped} pack${(packs || totals.shipped) === 1 ? '' : 's'}`,
          date: shipment?.createdAt ?? prescription.latestShipmentAt ?? null,
          source: 'Curaleaf',
        });
      }
    } else {
      events.push({
        label: totals.shipped < totals.ordered ? `${rxLabel} partial consignment dispatched` : `${rxLabel} consignment dispatched`,
        detail: `${totals.shipped} of ${totals.ordered} pack${totals.ordered === 1 ? '' : 's'} in transit`,
        date: prescription.latestShipmentAt ?? null,
        source: 'Curaleaf',
      });
    }
  }

  if (totals.received > 0) {
    const partialReceipt = totals.received < totals.ordered || totals.remaining > 0;
    const awaitingAtCuraleaf = totals.remaining > 0
      ? totals.remaining
      : Math.max(0, totals.ordered - totals.received);
    events.push({
      label: partialReceipt ? `${rxLabel} partially checked in` : `${rxLabel} delivered & checked in`,
      detail: partialReceipt
        ? `${totals.received} pack${totals.received === 1 ? '' : 's'} checked in; ${awaitingAtCuraleaf} remain with Curaleaf`
        : prescription.goodsInBy
          ? `Checked in by ${prescription.goodsInBy}`
          : 'Checked in at dispensary',
      date: prescription.goodsInAt ?? null,
      source: 'Dispensary',
    });
  }

  for (const shipmentId of shipmentIds) {
    const state = prescription.shipmentStates?.[shipmentId];
    if (state !== 'ready_for_collection' && state !== 'collected') continue;
    const shipment = prescription.shipments?.find(item => item.id === shipmentId);
    const packs = shipment ? shipmentPackCount(shipment) : totals.received;
    events.push({
      label: `${rxLabel} ready to collect`,
      detail: `Consignment ${shortConsignmentId(shipmentId)} · ${packs} pack${packs === 1 ? '' : 's'} · collection email queued`,
      date: prescription.readyAt ?? null,
      source: 'Dispensary',
    });
  }

  if (totals.collected > 0) {
    const partialHandout = totals.collected < totals.ordered;
    events.push({
      label: partialHandout ? `${rxLabel} partially handed to patient` : `${rxLabel} handed to patient`,
      detail: partialHandout
        ? `${totals.collected} of ${totals.ordered} pack${totals.ordered === 1 ? '' : 's'} collected; ${totals.ordered - totals.collected} remain on order`
        : handoutAt
          ? 'Dispensed and collected'
          : 'Dispensed and collected',
      date: handoutAt ?? prescription.readyAt ?? null,
      source: 'Dispensary',
    });
  } else if (prescription.status === 'collected') {
    events.push({
      label: `${rxLabel} handed to patient`,
      detail: 'Dispensed and collected',
      date: handoutAt ?? prescription.readyAt ?? null,
      source: 'Dispensary',
    });
  }

  return events;
}

export function buildOrderTimelineEvents(order: PatientOrder & { handoutAt?: Date | string | null }): OrderTimelineEvent[] {
  const events: OrderTimelineEvent[] = [
    {
      label: 'Order created',
      detail: `${order.prescriptions.length} prescription${order.prescriptions.length === 1 ? '' : 's'} prepared`,
      date: order.date,
      source: 'HHH automation',
    },
  ];

  if (order.payment.sentAt) {
    events.push({
      label: order.payment.route === 'worldpay' ? 'Payment link sent' : 'Payment method set',
      detail: order.payment.route === 'worldpay' ? 'Worldpay payment link created' : 'Pharmacy-managed payment route stored with the order',
      date: order.payment.sentAt,
      source: 'HHH automation',
    });
  }
  if (order.payment.paidAt) {
    events.push({
      label: order.payment.route === 'worldpay' ? 'Payment received' : 'Payment recorded',
      detail: Number.isFinite(order.payment.amount)
        ? `£${order.payment.amount.toFixed(2)} received`
        : 'Payment received',
      date: order.payment.paidAt,
      source: order.payment.route === 'worldpay' ? 'Worldpay' : 'Pharmacy',
    });
  }
  if (order.curaleafApprovedAt) {
    events.push({
      label: 'Curaleaf processing started',
      detail: 'Purchase orders accepted; delivery estimate started',
      date: order.curaleafApprovedAt,
      source: 'Curaleaf',
    });
  }
  for (const audit of order.auditEvents ?? []) {
    events.push({
      label: audit.label,
      detail: audit.reference ? `${audit.detail} · ${audit.reference}` : audit.detail,
      date: audit.occurredAt,
      source: 'HHH automation',
    });
  }
  if (order.cancellation) {
    events.push({
      label: 'Cancellation requested',
      detail: order.curaleafCancellation ? 'Curaleaf cancellation workflow opened' : 'Order cancellation recorded',
      date: order.cancellation.requestedAt,
      source: 'Pharmacy',
    });
  }
  if (order.curaleafCancellation?.contactedAt) {
    events.push({
      label: 'Curaleaf contacted',
      detail: `Reference ${order.curaleafCancellation.contactReference ?? 'recorded'}`,
      date: order.curaleafCancellation.contactedAt,
      source: 'Pharmacy',
    });
  }
  if (order.curaleafCancellation?.confirmedAt) {
    events.push({
      label: 'Curaleaf cancellation confirmed',
      detail: `Confirmation ${order.curaleafCancellation.confirmationReference ?? 'recorded'}`,
      date: order.curaleafCancellation.confirmedAt,
      source: 'Pharmacy',
    });
  }

  order.prescriptions.forEach((prescription, index) => {
    events.push(...buildPrescriptionTimelineEvents(prescription, index, order.handoutAt));
  });

  if (order.handoutAt && !order.prescriptions.some(prescription => (prescription.fulfilmentLines ?? []).some(line => line.collected > 0))) {
    events.push({
      label: 'Medicine handed over',
      detail: 'Collected by patient',
      date: order.handoutAt,
      source: 'Dispensary',
    });
  }

  const latestMatched = [...(order.quoteChecks ?? [])]
    .filter(check => check.status === 'MATCHED' && Number.isFinite(new Date(check.checkedAt).getTime()))
    .sort((left, right) => new Date(right.checkedAt).getTime() - new Date(left.checkedAt).getTime())[0];
  if (latestMatched) {
    events.push({
      label: 'Price and stock rechecked',
      detail: Number.isFinite(latestMatched.patientTotalPence)
        ? `£${(latestMatched.patientTotalPence / 100).toFixed(2)} confirmed before Curaleaf submission`
        : 'Order confirmed before Curaleaf submission',
      date: latestMatched.checkedAt,
      source: 'HHH automation',
    });
  }

  const seen = new Set<string>();
  return events
    .filter(event => event.date && Number.isFinite(new Date(event.date).getTime()))
    .filter(event => {
      const key = `${event.label}|${new Date(event.date!).toISOString()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => new Date(right.date!).getTime() - new Date(left.date!).getTime());
}

/* ---- Fixed stage rail ----
 *
 * The activity log answers "what happened and when"; the rail answers "where is
 * this order now". Because the rail is fixed, a stage that has not happened is
 * still shown as an outstanding step rather than being absent from the list.
 *
 * Placement boundary per .agents/rules/curaleaf-rocky.md: the clinic lane runs
 * until a purchase order exists, and only then does the dispensing lane apply.
 * Goods-in stages are always derived from the dispensary's own records, never
 * from Curaleaf, which cannot report delivery.
 */

export type OrderStageState = 'complete' | 'active' | 'partial' | 'pending';

export interface OrderStageStep {
  key: string;
  label: string;
  detail: string;
  state: OrderStageState;
}

export interface OrderStageRail {
  /** What the pharmacy does to get the order accepted by Curaleaf. */
  pharmacyPlacement: OrderStageStep[];
  /** What Curaleaf does once it holds the order. Null until a purchase order exists. */
  curaleafPlacement: OrderStageStep[] | null;
  /** Which route the prescription took, so the rail can be labelled honestly. */
  route: PlacementRoute;
}

function step(key: string, label: string, detail: string, state: OrderStageState): OrderStageStep {
  return { key, label, detail, state };
}

/**
 * How the prescription reached Curaleaf, which decides what the rail can claim.
 *
 * A QR order was scanned at the clinic, so Curaleaf already holds the
 * prescription and has already verified the prescriber — those steps are done
 * before the pharmacy touches the order. A manual order was typed here, so both
 * are genuine outstanding checks with Curaleaf.
 *
 * The two used to be conflated by a single `clinicRoute` flag that also read
 * `prescriptions.every(...)`, which returns true for an order with no
 * prescriptions at all — an empty order was therefore reported as having a
 * verified prescriber. The recorded placement route is authoritative when there
 * is one, and the entry modes are only a fallback for orders placed before the
 * route was recorded.
 */
export type PlacementRoute = 'clinic_barcode' | 'manual';

export function placementRoute(order: PatientOrder): PlacementRoute {
  const recorded = order.curaleafPlacement?.route;
  if (recorded === 'CLINIC_BARCODE') return 'clinic_barcode';
  if (recorded) return 'manual';
  const modes = new Set(order.prescriptions.map(prescription => prescription.entryMode));
  // No prescription yet is not a clinic scan; and one manually typed
  // prescription makes the whole placement a manual one.
  if (modes.size === 1 && modes.has('clinic')) return 'clinic_barcode';
  return 'manual';
}

export function prescriptionPlacementRoute(prescription: Pick<Prescription, 'entryMode' | 'clinicScanId'>): PlacementRoute {
  if (prescription.entryMode === 'clinic' || Boolean(prescription.clinicScanId)) return 'clinic_barcode';
  return 'manual';
}

function pharmacyPlacementSteps(order: PatientOrder, everyPrescriptionHasPurchaseOrder: boolean): OrderStageStep[] {
  const placement = order.curaleafPlacement;
  const route = placementRoute(order);
  const scanned = route === 'clinic_barcode';
  const prescriberComplete = everyPrescriptionHasPurchaseOrder || scanned || placement?.prescriberState === 'VERIFIED'
    || ['CREATING_PRESCRIPTION', 'UPLOADING_PRESCRIPTION_IMAGE', 'AWAITING_PRESCRIPTION_ACTIVATION', 'CREATING_PURCHASE_ORDER', 'PLACED'].includes(placement?.stage ?? '');
  const prescriptionComplete = everyPrescriptionHasPurchaseOrder || scanned || placement?.prescriptionState === 'ACTIVE'
    || ['CREATING_PURCHASE_ORDER', 'PLACED'].includes(placement?.stage ?? '');
  const paid = order.payment.status === 'paid';
  const paymentRequested = paid || order.payment.status === 'sent';

  return [
    // Payment leads the rail because nothing else can move until it clears: a
    // purchase order is never sent to Curaleaf on an unpaid order, so showing
    // prescriber checks first put the outstanding work in the wrong place.
    // Status only — the amount belongs to the order summary, not the rail.
    step('payment', 'Payment', paid ? 'Paid' : order.payment.status === 'sent' ? 'Awaiting patient' : 'Not requested',
      paid ? 'complete' : paymentRequested ? 'active' : 'pending'),
    step('prescriber', 'Prescriber',
      scanned ? 'Verified at clinic scan' : prescriberComplete ? 'Verified' : placement?.prescriberState === 'UNVERIFIED' ? 'Awaiting Curaleaf' : 'Checking',
      prescriberComplete ? 'complete' : paid ? 'active' : 'pending'),
    step('prescription', 'Prescription',
      scanned ? 'Held by Curaleaf from the clinic QR' : prescriptionComplete ? 'Active' : placement?.prescriptionState === 'PENDING' ? 'Awaiting Curaleaf' : 'Pending',
      prescriptionComplete ? 'complete' : prescriberComplete ? 'active' : 'pending'),
    step('purchase-order', 'PO sent', everyPrescriptionHasPurchaseOrder ? 'All prescriptions placed' : 'Waiting for remaining prescriptions',
      everyPrescriptionHasPurchaseOrder ? 'complete' : prescriptionComplete && paid ? 'active' : 'pending'),
  ];
}

function dispensingStepsForPrescription(prescription: Prescription): OrderStageStep[] {
  const totals = prescriptionPackTotals(prescription);
  const allocated = (prescription.fulfilmentLines ?? []).reduce((sum, line) => sum + (line.allocated ?? 0), 0);

  const packLabel = (count: number) => `${count} pack${count === 1 ? '' : 's'}`;
  const partOf = (done: number) => `${done} of ${totals.ordered} ${totals.ordered === 1 ? 'pack' : 'packs'}`;

  const dispensedComplete = totals.ordered > 0 && allocated >= totals.ordered;
  const inTransit = Math.max(0, totals.shipped - totals.received);
  const shippedComplete = totals.ordered > 0 && totals.shipped >= totals.ordered;
  const receivedComplete = totals.ordered > 0 && totals.received >= totals.ordered;
  const collectedComplete = totals.ordered > 0 && totals.collected >= totals.ordered;
  const readyPacks = readyPackCountForPrescription(prescription);
  const readyComplete = totals.ordered > 0 && readyPacks >= totals.ordered;
  const readySome = readyPacks > 0;

  const state = (complete: boolean, some: boolean, active: boolean): OrderStageState =>
    complete ? 'complete' : some ? 'partial' : active ? 'active' : 'pending';

  return [
    step('ordered', 'Ordered', 'PO sent', 'complete'),
    step('dispensed', 'Dispensed', dispensedComplete ? 'Allocated by Curaleaf' : allocated > 0 ? partOf(allocated) : 'Awaiting Curaleaf allocation',
      state(dispensedComplete, allocated > 0, true)),
    step('in-transit', 'In transit', shippedComplete ? 'Dispatched' : totals.shipped > 0 ? partOf(totals.shipped) : 'Awaiting dispatch',
      state(shippedComplete, totals.shipped > 0, dispensedComplete)),
    step('checked-in', 'Checked in', receivedComplete ? 'Verified at dispensary' : totals.received > 0 ? partOf(totals.received) : inTransit > 0 ? `${packLabel(inTransit)} arriving` : 'Awaiting delivery',
      state(receivedComplete, totals.received > 0, totals.shipped > 0)),
    step('ready', 'Ready',
      readyComplete
        ? 'Patient notified'
        : readySome
          ? `${partOf(readyPacks)} ready · patient notified for those`
          : 'Awaiting goods-in',
      readyComplete ? 'complete' : readySome ? 'partial' : receivedComplete ? 'active' : 'pending'),
    step('collected', 'Collected', collectedComplete ? 'Handed to patient' : totals.collected > 0 ? partOf(totals.collected) : 'Awaiting collection',
      state(collectedComplete, totals.collected > 0, readyComplete)),
  ];
}

function dispensingSteps(order: PatientOrder): OrderStageStep[] {
  const totals = order.prescriptions.reduce((sum, prescription) => {
    const packs = prescriptionPackTotals(prescription);
    return {
      ordered: sum.ordered + packs.ordered,
      shipped: sum.shipped + packs.shipped,
      received: sum.received + packs.received,
      collected: sum.collected + packs.collected,
    };
  }, { ordered: 0, shipped: 0, received: 0, collected: 0 });
  const allocated = order.prescriptions.reduce((sum, prescription) => (
    sum + (prescription.fulfilmentLines ?? []).reduce((lineSum, line) => lineSum + (line.allocated ?? 0), 0)
  ), 0);

  const packLabel = (count: number) => `${count} pack${count === 1 ? '' : 's'}`;
  const partOf = (done: number) => `${done} of ${totals.ordered} ${totals.ordered === 1 ? 'pack' : 'packs'}`;

  const dispensedComplete = totals.ordered > 0 && allocated >= totals.ordered;
  const inTransit = Math.max(0, totals.shipped - totals.received);
  const shippedComplete = totals.ordered > 0 && totals.shipped >= totals.ordered;
  const receivedComplete = totals.ordered > 0 && totals.received >= totals.ordered;
  const collectedComplete = totals.ordered > 0 && totals.collected >= totals.ordered;
  const readyPacks = readyPackCount(order);
  const readyComplete = totals.ordered > 0 && readyPacks >= totals.ordered;
  const readySome = readyPacks > 0;

  const state = (complete: boolean, some: boolean, active: boolean): OrderStageState =>
    complete ? 'complete' : some ? 'partial' : active ? 'active' : 'pending';

  return [
    step('ordered', 'Ordered', 'PO sent', 'complete'),
    step('dispensed', 'Dispensed', dispensedComplete ? 'Allocated by Curaleaf' : allocated > 0 ? partOf(allocated) : 'Awaiting Curaleaf allocation',
      state(dispensedComplete, allocated > 0, true)),
    step('in-transit', 'In transit', shippedComplete ? 'Dispatched' : totals.shipped > 0 ? partOf(totals.shipped) : 'Awaiting dispatch',
      state(shippedComplete, totals.shipped > 0, dispensedComplete)),
    // Goods-in is the dispensary's record; Curaleaf cannot report arrival.
    step('checked-in', 'Checked in', receivedComplete ? 'Verified at dispensary' : totals.received > 0 ? partOf(totals.received) : inTransit > 0 ? `${packLabel(inTransit)} arriving` : 'Awaiting delivery',
      state(receivedComplete, totals.received > 0, totals.shipped > 0)),
    step('ready', 'Ready',
      readyComplete
        ? 'Patient notified'
        : readySome
          ? `${partOf(readyPacks)} ready · patient notified for those`
          : 'Awaiting goods-in',
      readyComplete ? 'complete' : readySome ? 'partial' : receivedComplete ? 'active' : 'pending'),
    step('collected', 'Collected', collectedComplete ? 'Handed to patient' : totals.collected > 0 ? partOf(totals.collected) : 'Awaiting collection',
      state(collectedComplete, totals.collected > 0, readyComplete)),
  ];
}

export interface PrescriptionStageRail {
  /** Ordered → Collected for this Rx only. Null until this Rx has a purchase order. */
  dispensing: OrderStageStep[] | null;
  route: PlacementRoute;
}

export function buildPrescriptionStageRail(_order: PatientOrder, prescription: Prescription): PrescriptionStageRail {
  const purchaseOrderExists = Boolean(prescription.purchaseOrderId);
  return {
    dispensing: purchaseOrderExists ? dispensingStepsForPrescription(prescription) : null,
    route: prescriptionPlacementRoute(prescription),
  };
}

export function buildOrderStageRail(order: PatientOrder): OrderStageRail {
  const purchaseOrderExists = order.prescriptions.some(prescription => Boolean(prescription.purchaseOrderId));
  const everyPrescriptionHasPurchaseOrder = order.prescriptions.length > 0
    && order.prescriptions.every(prescription => Boolean(prescription.purchaseOrderId));
  return {
    pharmacyPlacement: pharmacyPlacementSteps(order, everyPrescriptionHasPurchaseOrder),
    curaleafPlacement: purchaseOrderExists ? dispensingSteps(order) : null,
    route: placementRoute(order),
  };
}
