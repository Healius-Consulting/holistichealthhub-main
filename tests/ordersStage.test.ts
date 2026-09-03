import assert from 'node:assert/strict';
import test from 'node:test';
import { hasDispatchedRemainder, orderAwaitingSupplierShipmentProductNames, orderAwaitingCuraleafCancel, orderCancellationResolution, orderFulfilmentHeadline, orderHasInTransitPacks, orderHasPartialCollection, orderHasPartialCuraleafDispense, orderHasPartialPharmacyReceipt, orderHasUncollectedReceivedPacks, orderIsSplitFulfilment, orderPaymentAllowsManualCancellation, orderRequiresCuraleafCancel, orderSplitPackSnapshot, orderStage, prescriptionStatusChipTone, prescriptionStatusLabel, stageMatchesFilter, unpaidCancellationConfirmation, type OrderStage, type StageFilter } from '../src/utils/orderStage.ts';
import type { PatientOrder } from '../src/context/AppContext.tsx';

const taxonomy: Array<[OrderStage, StageFilter]> = [
  ['awaiting-payment', 'awaiting-payment'],
  ['paid', 'awaiting-fulfilment'],
  ['curaleaf-pending', 'awaiting-fulfilment'],
  ['curaleaf-approved', 'awaiting-fulfilment'],
  ['dispatched', 'awaiting-fulfilment'],
  ['delivered', 'awaiting-fulfilment'],
  ['ready', 'ready'],
  ['rejected', 'rejected'],
  ['archived', 'archived'],
  ['cancelled', 'cancelled'],
  ['collected', 'completed'],
];

test('every internal stage belongs to exactly one consolidated non-All filter', () => {
  const filters: StageFilter[] = ['awaiting-payment', 'awaiting-fulfilment', 'ready', 'rejected', 'archived', 'completed', 'cancelled'];
  taxonomy.forEach(([stage, expected]) => {
    const matches = filters.filter(filter => stageMatchesFilter(stage, filter));
    assert.deepEqual(matches, [expected]);
  });
});

test('current filter keeps operational stages and excludes terminal history', () => {
  assert.equal(stageMatchesFilter('paid', 'current'), true);
  assert.equal(stageMatchesFilter('rejected', 'current'), true);
  assert.equal(stageMatchesFilter('cancelled', 'current'), false);
  assert.equal(stageMatchesFilter('archived', 'current'), false);
  assert.equal(stageMatchesFilter('collected', 'current'), false);
});

test('manual pharmacy cancellation closes as soon as payment settles', () => {
  assert.equal(orderPaymentAllowsManualCancellation({ payment: { status: 'none', paidAt: null } } as PatientOrder), true);
  assert.equal(orderPaymentAllowsManualCancellation({ payment: { status: 'sent', paidAt: null } } as PatientOrder), true);
  assert.equal(orderPaymentAllowsManualCancellation({ payment: { status: 'paid', paidAt: new Date() } } as PatientOrder), false);
  assert.equal(orderPaymentAllowsManualCancellation({ payment: { status: 'sent', paidAt: new Date() } } as PatientOrder), false);
  assert.equal(orderPaymentAllowsManualCancellation({ payment: { status: 'refund_required', paidAt: new Date() } } as PatientOrder), false);
});

test('unpaid cancellation confirmation mentions a link only for Worldpay', () => {
  assert.equal(unpaidCancellationConfirmation('worldpay'), 'Order cancelled and its payment link retired in the platform.');
  assert.equal(unpaidCancellationConfirmation('pharmacy'), 'Order cancelled. No patient payment was recorded.');
});

test('cancelled orders distinguish outstanding work from closed outcomes', () => {
  const base = {
    lifecycleStatus: 'cancelled',
    date: new Date(),
    prescriptions: [],
    payment: { status: 'cancelled' },
  } as PatientOrder;

  assert.equal(orderCancellationResolution({ ...base, cancellation: { status: 'cancelled' } } as PatientOrder), 'resolved');
  assert.equal(orderCancellationResolution({ ...base, payment: { status: 'cancelled', paidAt: null }, cancellation: { status: 'cancelled' }, refund: undefined } as PatientOrder), 'resolved');
  assert.equal(orderCancellationResolution({ ...base, payment: { status: 'paid' }, cancellation: { status: 'refund_required' } } as PatientOrder), 'needs-action');
  assert.equal(orderCancellationResolution({ ...base, payment: { status: 'paid' }, cancellation: { status: 'refund_required' }, refund: { status: 'completed' } } as PatientOrder), 'refunded');
  assert.equal(orderCancellationResolution({
    ...base,
    payment: { status: 'paid' },
    cancellation: { status: 'cancelled' },
    redoneByOrderId: 'training-order-136',
  } as PatientOrder), 'resolved');
});

test('pharmacy cancel is local only before Curaleaf prescriber, prescription, or purchase-order work starts', () => {
  const pending = {
    payment: { status: 'paid' },
    prescriptions: [{ curaleafPrescriptionId: 'rx-1', curaleafPrescriptionState: 'PENDING', placed: false, purchaseOrderId: 'ORD-1', purchaseOrderState: null }],
  } as PatientOrder;
  const accepted = {
    payment: { status: 'paid' },
    prescriptions: [{ curaleafPrescriptionId: 'rx-1', curaleafPrescriptionState: 'ACTIVE', placed: false, purchaseOrderId: 'ORD-1' }],
  } as PatientOrder;
  const withPo = {
    payment: { status: 'paid' },
    prescriptions: [{ curaleafPrescriptionId: 'rx-1', curaleafPrescriptionState: 'ACTIVE', placed: true, purchaseOrderId: 'ORD-1', purchaseOrderState: 'CREATED' }],
  } as PatientOrder;
  assert.equal(orderRequiresCuraleafCancel(pending), true);
  assert.equal(orderRequiresCuraleafCancel(accepted), true);
  assert.equal(orderRequiresCuraleafCancel(withPo), true);
  const refundedWithLivePo = {
    payment: { status: 'paid' },
    refund: { status: 'completed' },
    lifecycleStatus: 'cancelled',
    prescriptions: [{ status: 'cancelled', curaleafPrescriptionState: 'ACTIVE', placed: true, purchaseOrderState: 'CREATED' }],
  } as PatientOrder;
  assert.equal(orderRequiresCuraleafCancel(refundedWithLivePo), true);
  assert.equal(orderAwaitingCuraleafCancel(refundedWithLivePo), true);
  assert.equal(orderCancellationResolution(refundedWithLivePo), 'needs-action');
  assert.equal(orderAwaitingCuraleafCancel(withPo), false);
});

test('mixed ready and in-flight prescriptions prioritise collectable packs', () => {
  const order = {
    date: new Date(),
    payment: { status: 'paid' },
    prescriptions: [
      {
        status: 'processing',
        fulfilmentLines: [{ productId: 'p0', ordered: 1, shipped: 0, received: 0, remaining: 1, collected: 0, requested: 1, sent: null, supplierReportedOrdered: 1, allocated: 0, returned: 0, backordered: false, quantityMismatch: false }],
      },
      {
        status: 'ready',
        fulfilmentLines: [{ productId: 'p1', ordered: 2, shipped: 2, received: 2, remaining: 0, collected: 0, requested: 2, sent: null, supplierReportedOrdered: 2, allocated: 2, returned: 0, backordered: false, quantityMismatch: false }],
      },
      {
        status: 'dispatched',
        fulfilmentLines: [{ productId: 'p2', ordered: 2, shipped: 1, received: 0, remaining: 1, collected: 0, requested: 2, sent: null, supplierReportedOrdered: 2, allocated: 1, returned: 0, backordered: false, quantityMismatch: false }],
      },
    ],
  } as PatientOrder;
  assert.equal(orderStage(order).stage, 'ready');
  assert.deepEqual(orderFulfilmentHeadline(order), {
    label: 'Split fulfilment',
    mixedPrescriptions: true,
    prescriptionSummaries: ['Prescription 1: Being prepared', 'Prescription 2: Ready', 'Prescription 3: In transit'],
  });
});

test('order header uses one stable prescription stage and reserves split delivery for pack consignments', () => {
  const uniform = {
    date: new Date(),
    payment: { status: 'paid' },
    prescriptions: [{ status: 'processing' }, { status: 'approved' }, { status: 'processing' }],
  } as PatientOrder;
  assert.equal(orderFulfilmentHeadline(uniform)?.label, 'Dispensed by Clinic');

  const splitDelivery = {
    date: new Date(),
    payment: { status: 'paid' },
    prescriptions: [{
      status: 'dispatched',
      dispatchStatus: 'partial',
      fulfilmentLines: [{ productId: 'p1', ordered: 3, shipped: 1, received: 0, remaining: 2, collected: 0, requested: 3, sent: null, supplierReportedOrdered: 3, allocated: 1, returned: 0, backordered: true, quantityMismatch: false }],
    }],
  } as PatientOrder;
  assert.equal(orderFulfilmentHeadline(splitDelivery)?.label, 'Split delivery');

  const complete = {
    date: new Date(),
    payment: { status: 'paid' },
    prescriptions: [{ status: 'collected' }, { status: 'collected' }],
  } as PatientOrder;
  assert.equal(orderFulfilmentHeadline(complete)?.label, 'Collected');
});

test('mixed ready and unplaced prescriptions keep the collectable prescription actionable', () => {
  const order = {
    date: new Date(),
    payment: { status: 'paid' },
    prescriptions: [
      {
        status: 'ready',
        placed: true,
        fulfilmentLines: [{ productId: 'p1', ordered: 2, shipped: 2, received: 2, remaining: 0, collected: 0, requested: 2, sent: null, supplierReportedOrdered: 2, allocated: 2, returned: 0, backordered: false, quantityMismatch: false }],
      },
      {
        status: 'awaiting-approval',
        placed: false,
        items: [{ productId: 'p2', name: 'Vape', qty: 1, cost: 10, retail: 20 }],
      },
    ],
  } as PatientOrder;
  assert.equal(orderStage(order).stage, 'ready');
});

test('partial dispatch with zero check-in stays in transit despite stale ready shipment state', () => {
  const order = {
    date: new Date(),
    payment: { status: 'paid' },
    prescriptions: [{
      status: 'dispatched',
      dispatchStatus: 'partial',
      shipmentStates: { 'ship-1': 'ready_for_collection' },
      fulfilmentLines: [{
        productId: 'p1',
        ordered: 4,
        shipped: 2,
        received: 0,
        remaining: 2,
        collected: 0,
        requested: 4,
        sent: null,
        supplierReportedOrdered: 4,
        allocated: 2,
        returned: 0,
        backordered: true,
        quantityMismatch: false,
      }],
    }],
  } as PatientOrder;
  assert.equal(orderStage(order).stage, 'dispatched');
});

test('ready to collect requires checked-in packs', () => {
  const order = {
    date: new Date(),
    payment: { status: 'paid' },
    prescriptions: [{
      status: 'ready',
      shipmentStates: { 'ship-1': 'ready_for_collection' },
      fulfilmentLines: [{
        productId: 'p1',
        ordered: 4,
        shipped: 2,
        received: 0,
        remaining: 2,
        collected: 0,
        requested: 4,
        sent: null,
        supplierReportedOrdered: 4,
        allocated: 2,
        returned: 0,
        backordered: true,
        quantityMismatch: false,
      }],
    }],
  } as PatientOrder;
  assert.equal(orderStage(order).stage, 'dispatched');
});

test('processing prescriptions stay in the supplier-processing stage until a shipment exists', () => {
  const processing = {
    date: new Date(),
    payment: { status: 'paid' },
    prescriptions: [{ status: 'processing', placed: true }],
  } as PatientOrder;
  const dispatched = {
    ...processing,
    prescriptions: [{ status: 'dispatched', placed: true }],
  } as PatientOrder;
  assert.equal(orderStage(processing).stage, 'curaleaf-approved');
  assert.equal(orderStage(dispatched).stage, 'dispatched');
});

test('a remaining quantity is partial only after at least one pack has actually shipped', () => {
  assert.equal(hasDispatchedRemainder({ ordered: 1, shipped: 0 }), false);
  assert.equal(hasDispatchedRemainder({ ordered: 2, shipped: 1 }), true);
  assert.equal(hasDispatchedRemainder({ ordered: 1, shipped: 1 }), false);
});

test('ready and already-collected prescriptions classify the remaining order as ready', () => {
  const order = {
    date: new Date(),
    payment: { status: 'paid' },
    prescriptions: [{ status: 'ready' }, { status: 'collected' }],
  } as PatientOrder;
  assert.equal(orderStage(order).stage, 'ready');
});

test('partial check-in with supplier remainder is immediately ready to collect', () => {
  const order = {
    date: new Date(),
    payment: { status: 'paid' },
    prescriptions: [{
      status: 'partially-received',
      dispatchStatus: 'partial',
      shipmentStates: { 'ship-1': 'received' },
      fulfilmentLines: [{
        productId: 'p1',
        ordered: 10,
        shipped: 1,
        received: 1,
        remaining: 9,
        collected: 0,
        requested: 10,
        sent: null,
        supplierReportedOrdered: 10,
        allocated: 1,
        returned: 0,
        backordered: true,
        quantityMismatch: false,
      }],
    }],
  } as PatientOrder;
  assert.equal(orderStage(order).stage, 'ready');
  assert.equal(orderHasPartialPharmacyReceipt(order), true);
});

test('all checked-in packs are ready without a second pharmacy action', () => {
  const order = {
    date: new Date(),
    payment: { status: 'paid' },
    prescriptions: [{
      status: 'received',
      shipmentStates: { 'ship-1': 'received' },
      fulfilmentLines: [{
        productId: 'p1',
        ordered: 10,
        shipped: 10,
        received: 10,
        remaining: 0,
        collected: 0,
        requested: 10,
        sent: null,
        supplierReportedOrdered: 10,
        allocated: 10,
        returned: 0,
        backordered: false,
        quantityMismatch: false,
      }],
    }],
  } as PatientOrder;
  assert.equal(orderStage(order).stage, 'ready');
  assert.equal(orderHasPartialPharmacyReceipt(order), false);
});

test('partial collection with supplier remainder does not keep an in-transit delivery banner state', () => {
  const order = {
    date: new Date(),
    payment: { status: 'paid' },
    prescriptions: [{
      status: 'partially-received',
      dispatchStatus: 'partial',
      items: [{ productId: 'p1', name: 'Beach Wedding', qty: 4 }],
      shipmentStates: { 'ship-1': 'collected' },
      fulfilmentLines: [{
        productId: 'p1',
        ordered: 4,
        shipped: 2,
        received: 2,
        remaining: 2,
        collected: 2,
        requested: 4,
        sent: null,
        supplierReportedOrdered: 4,
        allocated: 2,
        returned: 0,
        backordered: true,
        quantityMismatch: false,
      }],
    }],
  } as PatientOrder;

  assert.equal(orderHasInTransitPacks(order), false);
  assert.equal(orderHasPartialCollection(order), true);
  assert.equal(orderHasUncollectedReceivedPacks(order), false);
  assert.equal(orderAwaitingSupplierShipmentProductNames(order).length, 1);
  assert.equal(prescriptionStatusLabel(order.prescriptions[0]!), 'Part Collected');
  assert.equal(orderStage(order).stage, 'curaleaf-approved');
});

test('partial Curaleaf allocation before courier is split dispensed', () => {
  const order = {
    date: new Date(),
    payment: { status: 'paid' },
    prescriptions: [{
      status: 'processing',
      purchaseOrderState: 'PROCESSING',
      items: [{ productId: 'p1', name: 'Beach Wedding', qty: 4 }],
      fulfilmentLines: [{
        productId: 'p1',
        ordered: 4,
        shipped: 0,
        received: 0,
        remaining: 4,
        collected: 0,
        requested: 4,
        sent: null,
        supplierReportedOrdered: 4,
        allocated: 2,
        returned: 0,
        backordered: false,
        quantityMismatch: false,
      }],
    }],
  } as PatientOrder;
  assert.equal(orderHasPartialCuraleafDispense(order), true);
  assert.equal(orderIsSplitFulfilment(order), true);
  assert.equal(orderHasInTransitPacks(order), false);
  const snapshot = orderSplitPackSnapshot(order);
  assert.equal(snapshot.dispensedAtCuraleaf, 2);
  assert.equal(snapshot.awaitingDispense, 2);
});

test('full Curaleaf allocation without a shipment is not split dispensed', () => {
  const order = {
    date: new Date(),
    payment: { status: 'paid' },
    prescriptions: [{
      status: 'processing',
      purchaseOrderState: 'FULLY_ALLOCATED',
      fulfilmentLines: [{
        productId: 'p1',
        ordered: 4,
        shipped: 0,
        received: 0,
        remaining: 4,
        collected: 0,
        requested: 4,
        sent: null,
        supplierReportedOrdered: 4,
        allocated: 4,
        returned: 0,
        backordered: false,
        quantityMismatch: false,
      }],
    }],
  } as PatientOrder;
  assert.equal(orderHasPartialCuraleafDispense(order), false);
  assert.equal(orderIsSplitFulfilment(order), false);
});

test('quote review required stays paid and is not treated as a Curaleaf rejection', () => {
  const order = {
    date: new Date(),
    payment: { status: 'paid' },
    prescriptions: [{ status: 'draft', placed: false }],
    quoteReview: { status: 'required', type: 'patient_price_changed' },
  } as PatientOrder;
  assert.equal(orderStage(order).stage, 'paid');
  assert.equal(orderStage(order).unresolvedReason, null);
});

test('Curaleaf-cancelled paid orders stay in cancelled unresolved, not as unpaid cancels', () => {
  const order = {
    date: new Date(),
    payment: { status: 'paid' },
    unresolvedReason: 'cancelled',
    cancellation: { status: 'refund_required' },
    curaleafCancellation: { status: 'confirmed' },
    prescriptions: [{ status: 'cancelled', purchaseOrderState: 'CANCELLED', placed: true }],
  } as PatientOrder;
  const staged = orderStage(order);
  assert.equal(staged.stage, 'cancelled');
  assert.equal(staged.unresolvedReason, 'cancelled');
  assert.equal(orderCancellationResolution(order), 'needs-action');
});

test('supplier-cancelled purchase orders are cancellation outcomes without an HHH cancellation row', () => {
  const unpaid = {
    date: new Date(),
    payment: { status: 'cancelled' },
    prescriptions: [{ status: 'cancelled', purchaseOrderState: 'CANCELLED', placed: true }],
  } as PatientOrder;
  assert.equal(orderCancellationResolution(unpaid), 'resolved');

  const paid = {
    ...unpaid,
    payment: { status: 'paid' },
  } as PatientOrder;
  assert.equal(orderCancellationResolution(paid), 'needs-action');

  const refunded = {
    ...paid,
    refund: { status: 'completed' },
  } as PatientOrder;
  assert.equal(orderCancellationResolution(refunded), 'refunded');
});

test('paid cancel with a pending manual refund stays in refund-due needs-action', () => {
  const order = {
    date: new Date(),
    payment: { status: 'paid' },
    unresolvedReason: 'cancelled',
    cancellation: { status: 'refund_required' },
    refund: { status: 'pending_confirmation' },
    prescriptions: [{ status: 'cancelled', purchaseOrderState: 'CANCELLED', placed: true }],
  } as PatientOrder;
  assert.equal(orderCancellationResolution(order), 'needs-action');
});

test('Curaleaf cancel wins over an expired or archived flag on the same paid order', () => {
  const order = {
    date: new Date('2026-07-01'),
    payment: { status: 'paid' },
    isExpired: true,
    lifecycleStatus: 'archived',
    unresolvedReason: 'expired',
    cancellation: { status: 'refund_required' },
    curaleafCancellation: { status: 'confirmed' },
    prescriptions: [{ status: 'cancelled', purchaseOrderState: 'CANCELLED', placed: true }],
  } as PatientOrder;
  const staged = orderStage(order);
  assert.equal(staged.stage, 'cancelled');
  assert.equal(staged.unresolvedReason, 'cancelled');
});

test('a CANCELLED purchase order is labelled cancelled even if rx status lagged', () => {
  const prescription = { status: 'processing', purchaseOrderState: 'CANCELLED', items: [], fulfilmentLines: [] } as PatientOrder['prescriptions'][number];
  assert.equal(prescriptionStatusLabel(prescription), 'Cancelled Purchase Order');
  assert.equal(prescriptionStatusChipTone(prescription), 'cancelled');
});

test('prescription chips use the same In Transit and Arrived at Pharmacy language as the order pills', () => {
  const inTransit = {
    status: 'dispatched',
    dispatchStatus: 'complete',
    items: [],
    fulfilmentLines: [],
  } as PatientOrder['prescriptions'][number];
  const partInTransit = {
    status: 'dispatched',
    dispatchStatus: 'partial',
    items: [],
    fulfilmentLines: [],
  } as PatientOrder['prescriptions'][number];
  const checkedIn = {
    status: 'received',
    items: [],
    fulfilmentLines: [],
  } as PatientOrder['prescriptions'][number];
  assert.equal(prescriptionStatusLabel(inTransit), 'In Transit');
  assert.equal(prescriptionStatusLabel(partInTransit), 'Part In Transit');
  assert.equal(prescriptionStatusLabel(checkedIn), 'Arrived at Pharmacy');
  assert.equal(prescriptionStatusLabel({
    status: 'awaiting-approval',
    placed: false,
    items: [],
  } as PatientOrder['prescriptions'][number]), 'Waiting for Curaleaf');
});
