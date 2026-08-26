import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { financeRevenueBasis, pharmacyFinanceRecognition } from './finance-recognition.js';

const organisationIdSchema = z.string().regex(/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i);

const financeDateRangeSchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
}).strict();

describe('portal finance query validation', () => {
  it('accepts compact tenant ids for admin finance filters', () => {
    const organisationId = '70913a3071c34a41952ed532927af58c';
    assert.doesNotThrow(() => organisationIdSchema.parse(organisationId));
  });

  it('accepts date-only filters for pharmacy prescription finance', () => {
    const parsed = financeDateRangeSchema.parse({ from: '2026-05-19' });
    assert.equal(parsed.from, '2026-05-19');
    assert.equal(parsed.to, undefined);
  });
});

describe('pharmacy finance recognition', () => {
  it('keeps paid uncollected orders pending, not realised', () => {
    const paid = pharmacyFinanceRecognition({
      paymentStatus: 'PAID',
      status: 'PLACED',
      fulfilmentStatus: 'READY_FOR_COLLECTION',
      paidAt: '2026-08-01T10:00:00.000Z',
    });
    assert.equal(paid.recognised, false);
    assert.equal(paid.realised, false);
    assert.equal(paid.pendingCollection, true);
    assert.equal(paid.refunded, false);
    assert.equal(paid.refundPending, false);
  });

  it('realises paid orders after collection', () => {
    const collected = pharmacyFinanceRecognition({
      paymentStatus: 'PAID',
      status: 'COMPLETED',
      fulfilmentStatus: 'COLLECTED',
      paidAt: '2026-08-01T10:00:00.000Z',
    });
    assert.equal(collected.recognised, true);
    assert.equal(collected.realised, true);
    assert.equal(collected.pendingCollection, false);
  });

  it('does not recognise unpaid orders', () => {
    const unpaid = pharmacyFinanceRecognition({
      paymentStatus: 'PENDING',
      status: 'PENDING_PLACEMENT',
      fulfilmentStatus: 'SUPPLIER_PENDING',
      paidAt: null,
    });
    assert.equal(unpaid.recognised, false);
    assert.equal(unpaid.realised, false);
    assert.equal(unpaid.pendingCollection, false);
  });

  it('removes completed refunds from recognised totals', () => {
    const refunded = pharmacyFinanceRecognition({
      paymentStatus: 'PAID',
      status: 'CANCELLED',
      fulfilmentStatus: 'COLLECTED',
      paidAt: '2026-08-01T10:00:00.000Z',
      quoteSnapshot: { refund: { status: 'completed', confirmedAt: '2026-08-02T10:00:00.000Z' } },
    });
    assert.equal(refunded.recognised, false);
    assert.equal(refunded.realised, false);
    assert.equal(refunded.pendingCollection, false);
    assert.equal(refunded.refunded, true);
    assert.equal(refunded.refundConfirmedAt, '2026-08-02T10:00:00.000Z');
  });

  it('treats a confirmed payment cancellation as refunded', () => {
    const cancelledPayment = pharmacyFinanceRecognition({
      paymentStatus: 'CANCELLED',
      status: 'CANCELLED',
      fulfilmentStatus: 'READY_FOR_COLLECTION',
      paidAt: '2026-08-01T10:00:00.000Z',
    });
    assert.equal(cancelledPayment.recognised, false);
    assert.equal(cancelledPayment.refunded, true);
    assert.equal(cancelledPayment.pendingCollection, false);
  });

  it('excludes opened refunds before confirmation', () => {
    const pending = pharmacyFinanceRecognition({
      paymentStatus: 'PAID',
      status: 'CANCELLED',
      fulfilmentStatus: 'COLLECTED',
      paidAt: '2026-08-01T10:00:00.000Z',
      quoteSnapshot: { refund: { status: 'pending_confirmation' } },
    });
    assert.equal(pending.recognised, false);
    assert.equal(pending.refundPending, true);
    assert.equal(pending.refunded, false);
    assert.equal(pending.pendingCollection, false);
  });

  it('keeps supplied value recognised after a completed partial remainder refund when collected', () => {
    const partial = pharmacyFinanceRecognition({
      paymentStatus: 'PAID',
      status: 'CANCELLED',
      fulfilmentStatus: 'COLLECTED',
      paidAt: '2026-08-01T10:00:00.000Z',
      totalPence: 35_000,
      quoteSnapshot: { refund: { status: 'completed', amountPence: 17_000 } },
    });
    assert.equal(partial.recognised, true);
    assert.equal(partial.realised, true);
    assert.equal(partial.refunded, false);
    assert.equal(partial.partialRefund, true);
    assert.equal(partial.refundAmountPence, 17_000);
  });

  it('keeps a supplied source allocation and its dispensing fee recognised after replacement when collected', () => {
    const source = pharmacyFinanceRecognition({
      paymentStatus: 'PAID', status: 'CANCELLED', fulfilmentStatus: 'COLLECTED',
      paidAt: '2026-08-01T10:00:00.000Z',
      resolutionReason: 'REPLACED', activeAllocationPence: 18_000,
    });
    assert.equal(source.recognised, true);
    assert.equal(source.refundPending, false);
    assert.deepEqual(financeRevenueBasis({
      medicineTotalPence: 34_000,
      dispensingFeePence: 1_000,
      totalPence: 35_000,
      activeAllocationPence: 18_000,
      replacementLinked: true,
    }), { patientRevenuePence: 18_000, productRevenuePence: 17_000, dispensingFeePence: 1_000 });
  });

  it('recognises the transferred allocation, not an absorbed replacement quote', () => {
    assert.deepEqual(financeRevenueBasis({
      medicineTotalPence: 18_000,
      dispensingFeePence: 1_000,
      totalPence: 19_000,
      activeAllocationPence: 17_000,
      replacementLinked: true,
      sourceRetainsAllocation: true,
    }), { patientRevenuePence: 17_000, productRevenuePence: 17_000, dispensingFeePence: 0 });
  });
});
