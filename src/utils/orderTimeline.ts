import type { PatientOrder, Prescription } from '../context/AppContext';

export type OrderTimelineEvent = {
  label: string;
  detail: string;
  date: Date | string | null;
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
      detail: prescription.poRef ? `PO ${prescription.poRef}` : 'Awaiting supplier reference',
      date: prescription.placedAt ?? null,
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
          date: shipment?.createdAt ?? prescription.latestShipmentAt ?? prescription.placedAt ?? null,
        });
      }
    } else {
      events.push({
        label: totals.shipped < totals.ordered ? `${rxLabel} partial consignment dispatched` : `${rxLabel} consignment dispatched`,
        detail: `${totals.shipped} of ${totals.ordered} pack${totals.ordered === 1 ? '' : 's'} in transit`,
        date: prescription.latestShipmentAt ?? prescription.placedAt ?? null,
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
      date: prescription.goodsInAt ?? prescription.latestShipmentAt ?? null,
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
      date: prescription.readyAt ?? prescription.goodsInAt ?? shipment?.createdAt ?? null,
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
    });
  } else if (prescription.status === 'collected') {
    events.push({
      label: `${rxLabel} handed to patient`,
      detail: 'Dispensed and collected',
      date: handoutAt ?? prescription.readyAt ?? null,
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
    },
  ];

  if (order.payment.sentAt) {
    events.push({
      label: 'Payment requested',
      detail: order.payment.route === 'worldpay' ? 'Worldpay payment link created' : 'Pharmacy payment selected',
      date: order.payment.sentAt,
    });
  }
  if (order.payment.paidAt) {
    events.push({
      label: 'Payment cleared',
      detail: `£${order.payment.amount.toFixed(2)} received`,
      date: order.payment.paidAt,
    });
  }
  if (order.curaleafApprovedAt) {
    events.push({
      label: 'Curaleaf approved',
      detail: 'Delivery service window started',
      date: order.curaleafApprovedAt,
    });
  }
  if (order.cancellation) {
    events.push({
      label: 'Cancellation requested',
      detail: order.curaleafCancellation ? 'Curaleaf cancellation workflow opened' : 'Order cancellation recorded',
      date: order.cancellation.requestedAt,
    });
  }
  if (order.curaleafCancellation?.contactedAt) {
    events.push({
      label: 'Curaleaf contacted',
      detail: `Reference ${order.curaleafCancellation.contactReference ?? 'recorded'}`,
      date: order.curaleafCancellation.contactedAt,
    });
  }
  if (order.curaleafCancellation?.confirmedAt) {
    events.push({
      label: 'Curaleaf cancellation confirmed',
      detail: `Confirmation ${order.curaleafCancellation.confirmationReference ?? 'recorded'}`,
      date: order.curaleafCancellation.confirmedAt,
    });
  }

  order.prescriptions.forEach((prescription, index) => {
    events.push(...buildPrescriptionTimelineEvents(prescription, index, order.handoutAt));
  });

  if (order.handoutAt && !order.prescriptions.some(prescription => (prescription.fulfilmentLines ?? []).some(line => line.collected > 0))) {
    events.push({
      label: 'Medication handed out',
      detail: 'Collected by patient',
      date: order.handoutAt,
    });
  }

  return events.sort(
    (left, right) => new Date(right.date ?? 0).getTime() - new Date(left.date ?? 0).getTime(),
  );
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
  clinic: OrderStageStep[];
  /** Null until a purchase order exists — dispensing has not begun. */
  dispensing: OrderStageStep[] | null;
}

function step(key: string, label: string, detail: string, state: OrderStageState): OrderStageStep {
  return { key, label, detail, state };
}

function clinicSteps(order: PatientOrder, purchaseOrderExists: boolean): OrderStageStep[] {
  const placement = order.curaleafPlacement;
  const clinicRoute = placement?.route === 'CLINIC_BARCODE'
    || order.prescriptions.every(prescription => prescription.entryMode === 'clinic');
  const prescriberComplete = purchaseOrderExists || clinicRoute || placement?.prescriberState === 'VERIFIED'
    || ['CREATING_PRESCRIPTION', 'UPLOADING_PRESCRIPTION_IMAGE', 'AWAITING_PRESCRIPTION_ACTIVATION', 'CREATING_PURCHASE_ORDER', 'PLACED'].includes(placement?.stage ?? '');
  const prescriptionComplete = purchaseOrderExists || placement?.prescriptionState === 'ACTIVE'
    || ['CREATING_PURCHASE_ORDER', 'PLACED'].includes(placement?.stage ?? '');
  const paid = order.payment.status === 'paid';
  const paymentRequested = paid || order.payment.status === 'sent';

  return [
    step('prescriber', 'Prescriber', clinicRoute ? 'Clinic scan' : prescriberComplete ? 'Verified' : placement?.prescriberState === 'UNVERIFIED' ? 'Awaiting Curaleaf' : 'Checking',
      prescriberComplete ? 'complete' : 'active'),
    step('prescription', 'Prescription', prescriptionComplete ? 'Active' : placement?.prescriptionState === 'PENDING' ? 'Awaiting Curaleaf' : 'Pending',
      prescriptionComplete ? 'complete' : prescriberComplete ? 'active' : 'pending'),
    // Status only. The amount belongs to the order summary, not the rail.
    step('payment', 'Payment', paid ? 'Paid' : order.payment.status === 'sent' ? 'Awaiting patient' : 'Not requested',
      paid ? 'complete' : paymentRequested ? 'active' : 'pending'),
    step('purchase-order', 'PO sent', purchaseOrderExists ? 'Sent to Curaleaf' : 'Pending',
      purchaseOrderExists ? 'complete' : prescriptionComplete && paid ? 'active' : 'pending'),
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
  const readyComplete = order.prescriptions.some(prescription => prescription.status === 'ready' || prescription.status === 'collected')
    || Object.values(Object.assign({}, ...order.prescriptions.map(prescription => prescription.shipmentStates ?? {})))
      .some(state => state === 'ready_for_collection' || state === 'collected');

  const state = (complete: boolean, some: boolean, active: boolean): OrderStageState =>
    complete ? 'complete' : some ? 'partial' : active ? 'active' : 'pending';

  return [
    step('ordered', 'Ordered', 'PO sent', 'complete'),
    step('dispensed', 'Dispensed', dispensedComplete ? 'Allocated by Curaleaf' : allocated > 0 ? partOf(allocated) : 'Awaiting Curaleaf',
      state(dispensedComplete, allocated > 0, true)),
    step('in-transit', 'In transit', shippedComplete ? 'Dispatched' : totals.shipped > 0 ? partOf(totals.shipped) : 'Awaiting dispatch',
      state(shippedComplete, totals.shipped > 0, dispensedComplete)),
    // Goods-in is the dispensary's record; Curaleaf cannot report arrival.
    step('checked-in', 'Checked in', receivedComplete ? 'Verified at dispensary' : totals.received > 0 ? partOf(totals.received) : inTransit > 0 ? `${packLabel(inTransit)} arriving` : 'Awaiting delivery',
      state(receivedComplete, totals.received > 0, totals.shipped > 0)),
    step('ready', 'Ready', readyComplete ? 'Patient notified' : 'Pending pharmacy checks',
      readyComplete ? 'complete' : receivedComplete ? 'active' : 'pending'),
    step('collected', 'Collected', collectedComplete ? 'Handed to patient' : totals.collected > 0 ? partOf(totals.collected) : 'Awaiting collection',
      state(collectedComplete, totals.collected > 0, readyComplete)),
  ];
}

export function buildOrderStageRail(order: PatientOrder): OrderStageRail {
  const purchaseOrderExists = order.prescriptions.some(prescription => Boolean(prescription.poRef || prescription.placed));
  return {
    clinic: clinicSteps(order, purchaseOrderExists),
    dispensing: purchaseOrderExists ? dispensingSteps(order) : null,
  };
}
