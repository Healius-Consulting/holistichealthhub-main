import assert from 'node:assert/strict';
import test from 'node:test';
import type { PatientOrder, Prescription } from '../src/context/AppContext.tsx';
import { orderBoardLane } from '../src/utils/orderBoardLanes.ts';
import { buildPrescriptionWorkItems, prescriptionWorkItemIsLive } from '../src/utils/prescriptionWorkItems.ts';

function prescription(id: number, status: Prescription['status'], overrides: Partial<Prescription> = {}): Prescription {
  return {
    id,
    entryMode: 'clinic',
    prescriber: 'Dr Training',
    copyFileName: 'training.pdf',
    items: [{ productId: `product-${id}`, name: `Product ${id}`, qty: 1, cost: 42, retail: 85 }],
    placed: status !== 'awaiting-approval',
    purchaseOrderId: status === 'awaiting-approval' ? null : `PO-${id}`,
    status,
    invoiceRef: null,
    trackingNumber: null,
    carrier: null,
    ...overrides,
  };
}

function order(prescriptions: Prescription[], overrides: Partial<PatientOrder> = {}): PatientOrder {
  return {
    id: 1,
    organisationId: 'org-1',
    patientId: 'patient-1',
    date: new Date('2026-08-20T10:00:00Z'),
    dispensingFee: 0,
    pharmacyDelivery: 0,
    pharmacyDeliveryAllowed: true,
    payment: {
      status: 'paid', route: 'worldpay', amount: prescriptions.length * 85, ref: 'PAY-1',
      sentAt: new Date(), paidAt: new Date(), manualTender: null, manualReference: null,
      manualNotes: null, manualRecordedBy: null,
    },
    prescriptions,
    ...overrides,
  };
}

test('awaiting payment stays one order-level work item', () => {
  const source = order([prescription(1, 'awaiting-approval'), prescription(2, 'awaiting-approval')]);
  source.payment.status = 'sent';
  const items = buildPrescriptionWorkItems({ order: source, patient: null });
  assert.equal(items.length, 1);
  assert.equal(items[0]?.prescription, null);
  assert.equal(orderBoardLane(items[0]!.record), 'awaiting-payment');
});

test('paid orders produce exactly one work item per prescription', () => {
  const source = order([prescription(1, 'processing'), prescription(2, 'ready')]);
  const items = buildPrescriptionWorkItems({ order: source, patient: null });
  assert.deepEqual(items.map(item => item.prescription?.id), [1, 2]);
  assert.equal(new Set(items.map(item => item.key)).size, 2);
});

test('mixed prescription stages can occupy different board lanes', () => {
  const source = order([
    prescription(1, 'processing', { purchaseOrderState: 'PROCESSING' }),
    prescription(2, 'ready', {
      purchaseOrderState: 'FULLY_ALLOCATED',
      dispatchStatus: 'complete',
      fulfilmentLines: [{ productId: 'product-2', ordered: 1, requested: 1, sent: 1, supplierReportedOrdered: 1, allocated: 1, shipped: 1, remaining: 0, received: 1, collected: 0, returned: 0, backordered: false, quantityMismatch: false }],
    }),
  ]);
  const lanes = buildPrescriptionWorkItems({ order: source, patient: null }).map(item => orderBoardLane(item.record));
  assert.deepEqual(lanes, ['curaleaf', 'ready']);
});

test('a cancelled PO creates work only for the affected prescription', () => {
  const source = order([
    prescription(1, 'cancelled', { purchaseOrderState: 'CANCELLED' }),
    prescription(2, 'processing', { purchaseOrderState: 'PROCESSING' }),
  ], {
    lifecycleStatus: 'cancelled',
    unresolvedReason: 'cancelled',
    cancellation: { status: 'refund_required' } as PatientOrder['cancellation'],
  });
  const items = buildPrescriptionWorkItems({ order: source, patient: null });
  assert.equal(orderBoardLane(items[0]!.record), 'needs-action');
  assert.equal(orderBoardLane(items[1]!.record), 'curaleaf');
  assert.equal(items[1]!.record.order.cancellation, undefined);
});

test('an order-level quote gate is assigned to one deterministic prescription', () => {
  const source = order([prescription(1, 'awaiting-approval'), prescription(2, 'awaiting-approval')], {
    quoteReview: { status: 'required' } as PatientOrder['quoteReview'],
  });
  const items = buildPrescriptionWorkItems({ order: source, patient: null });
  assert.equal(items.filter(item => item.record.order.quoteReview).length, 1);
  assert.deepEqual(items.map(item => orderBoardLane(item.record)), ['needs-action', 'curaleaf']);
});

test('terminal siblings remain in the order dialog but leave the live board', () => {
  const source = order([
    prescription(1, 'collected', { purchaseOrderState: 'FULLY_ALLOCATED' }),
    prescription(2, 'processing', { purchaseOrderState: 'PROCESSING' }),
  ]);
  const items = buildPrescriptionWorkItems({ order: source, patient: null });
  assert.equal(items.length, 2);
  assert.deepEqual(items.filter(prescriptionWorkItemIsLive).map(item => item.prescription?.id), [2]);
});
