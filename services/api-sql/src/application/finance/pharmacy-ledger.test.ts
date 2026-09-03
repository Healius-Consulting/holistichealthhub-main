import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  allocatePatientRevenueAfterRefund,
  OVERVIEW_FINANCE_TIME_ZONE,
  overviewFinanceSnapshot,
  thisMonthBounds,
} from './pharmacy-ledger.js';

const NOW = Date.parse('2026-09-03T12:00:00.000Z');

type Row = Parameters<typeof overviewFinanceSnapshot>[0][number];

function row(overrides: Partial<Row> = {}): Row {
  return {
    orderId: 'ord-1',
    patientId: 'patient-a',
    createdAt: '2026-09-02T10:00:00.000Z',
    paidAt: '2026-09-02T10:00:00.000Z',
    refundedAt: null,
    paymentStatus: 'paid',
    grossPatientRevenuePence: 0,
    refundAmountPence: 0,
    patientRevenuePence: 0,
    wholesalePence: null,
    wholesaleComplete: false,
    ...overrides,
  };
}

describe('this month bounds in Europe/London', () => {
  it('starts at midnight on the first of the calendar month', () => {
    const bounds = thisMonthBounds(NOW);
    assert.equal(bounds.timezone, OVERVIEW_FINANCE_TIME_ZONE);
    assert.equal(bounds.periodStart, '2026-08-31T23:00:00.000Z');
    assert.equal(bounds.periodEnd, new Date(NOW).toISOString());
  });
});

describe('the Overview this-month cash snapshot', () => {
  it('counts paid uncollected settlements as revenue', () => {
    const snapshot = overviewFinanceSnapshot([
      row({ grossPatientRevenuePence: 6_000, wholesalePence: 2_000, wholesaleComplete: true }),
      row({
        orderId: 'ord-unpaid',
        paymentStatus: 'pending',
        paidAt: null,
        grossPatientRevenuePence: 2_500,
        patientRevenuePence: 2_500,
      }),
    ], NOW);
    assert.equal(snapshot.period, 'this_month');
    assert.equal(snapshot.revenuePence, 6_000);
    assert.equal(snapshot.revenueOrderCount, 1);
    assert.equal(snapshot.grossProfitPence, 4_000);
    assert.equal(snapshot.awaitingPaymentValuePence, 2_500);
  });

  it('excludes unpaid, cancelled, and failed payments from revenue and gross profit', () => {
    const snapshot = overviewFinanceSnapshot([
      row({ grossPatientRevenuePence: 6_000, wholesalePence: 2_000, wholesaleComplete: true }),
      row({
        orderId: 'ord-failed',
        paymentStatus: 'failed',
        paidAt: null,
        grossPatientRevenuePence: 9_900,
      }),
      row({
        orderId: 'ord-cancelled',
        paymentStatus: 'cancelled',
        paidAt: null,
        createdAt: '2026-09-01T08:00:00.000Z',
        grossPatientRevenuePence: 4_000,
      }),
    ], NOW);
    assert.equal(snapshot.revenuePence, 6_000);
    assert.equal(snapshot.grossProfitPence, 4_000);
    assert.equal(snapshot.awaitingPaymentCount, 0);
  });

  it('starts the window on the first of the month, not thirty days back', () => {
    const snapshot = overviewFinanceSnapshot([
      row({ paidAt: '2026-08-31T22:00:00.000Z', grossPatientRevenuePence: 9_900, wholesalePence: 1, wholesaleComplete: true }),
      row({ paidAt: '2026-08-31T23:00:00.000Z', grossPatientRevenuePence: 6_000, wholesalePence: 2_000, wholesaleComplete: true }),
    ], NOW);
    assert.equal(snapshot.revenuePence, 6_000);
    assert.equal(snapshot.revenueOrderCount, 1);
  });

  it('records a later-month refund in the refund month, not the original payment month', () => {
    const september = overviewFinanceSnapshot([
      row({
        paidAt: '2026-08-10T10:00:00.000Z',
        refundedAt: '2026-09-02T09:00:00.000Z',
        refundAmountPence: 3_000,
        grossPatientRevenuePence: 10_000,
        wholesalePence: 4_000,
        wholesaleComplete: true,
      }),
    ], NOW);
    assert.equal(september.revenuePence, -3_000);
    assert.equal(september.grossProfitPence, -3_000);
    assert.equal(september.revenueOrderCount, 0);
    assert.equal(september.payingPatientCount, 0);

    const august = overviewFinanceSnapshot([
      row({
        paidAt: '2026-08-10T10:00:00.000Z',
        refundedAt: '2026-09-02T09:00:00.000Z',
        refundAmountPence: 3_000,
        grossPatientRevenuePence: 10_000,
        wholesalePence: 4_000,
        wholesaleComplete: true,
      }),
    ], Date.parse('2026-08-20T12:00:00.000Z'));
    assert.equal(august.revenuePence, 10_000);
    assert.equal(august.grossProfitPence, 6_000);
  });

  it('counts a patient with two paid orders once in average spend', () => {
    const snapshot = overviewFinanceSnapshot([
      row({ orderId: 'ord-1', patientId: 'patient-a', grossPatientRevenuePence: 6_000, wholesalePence: 2_000, wholesaleComplete: true }),
      row({ orderId: 'ord-2', patientId: 'patient-a', grossPatientRevenuePence: 4_000, wholesalePence: 1_000, wholesaleComplete: true }),
      row({ orderId: 'ord-3', patientId: 'patient-b', grossPatientRevenuePence: 5_000, wholesalePence: 2_000, wholesaleComplete: true }),
    ], NOW);
    assert.equal(snapshot.revenuePence, 15_000);
    assert.equal(snapshot.payingPatientCount, 2);
    assert.equal(snapshot.averageSpendPence, 7_500);
  });

  it('keeps uncosted payments in revenue and flags incomplete gross profit', () => {
    const snapshot = overviewFinanceSnapshot([
      row({ grossPatientRevenuePence: 6_000, wholesalePence: 2_000, wholesaleComplete: true }),
      row({
        orderId: 'ord-open-cost',
        patientId: 'patient-b',
        grossPatientRevenuePence: 5_000,
        wholesalePence: null,
        wholesaleComplete: false,
      }),
    ], NOW);
    assert.equal(snapshot.revenuePence, 11_000);
    assert.equal(snapshot.grossProfitPence, 9_000);
    assert.equal(snapshot.grossProfitComplete, false);
    assert.equal(snapshot.costedOrderCount, 1);
    assert.equal(snapshot.revenueOrderCount, 2);
  });

  it('shows zeros and no paying patients rather than dividing by zero', () => {
    const snapshot = overviewFinanceSnapshot([], NOW);
    assert.equal(snapshot.revenuePence, 0);
    assert.equal(snapshot.grossProfitPence, 0);
    assert.equal(snapshot.averageSpendPence, 0);
    assert.equal(snapshot.payingPatientCount, 0);
    assert.equal(snapshot.grossProfitComplete, true);
    assert.equal(snapshot.awaitingPaymentValuePence, 0);
  });

  it('keeps awaiting payment out of revenue and gross profit', () => {
    const snapshot = overviewFinanceSnapshot([
      row({ grossPatientRevenuePence: 6_000, wholesalePence: 2_000, wholesaleComplete: true }),
      row({
        orderId: 'ord-link',
        paymentStatus: 'pending',
        paidAt: null,
        patientRevenuePence: 8_000,
        grossPatientRevenuePence: 8_000,
      }),
    ], NOW);
    assert.equal(snapshot.revenuePence, 6_000);
    assert.equal(snapshot.grossProfitPence, 4_000);
    assert.equal(snapshot.awaitingPaymentCount, 1);
    assert.equal(snapshot.awaitingPaymentValuePence, 8_000);
  });

  it('ignores payments and refunds with blank dates instead of dating them today', () => {
    const snapshot = overviewFinanceSnapshot([
      row({ paidAt: '', grossPatientRevenuePence: 6_000, wholesaleComplete: true, wholesalePence: 1 }),
      row({ paidAt: null, refundedAt: '', refundAmountPence: 2_000, grossPatientRevenuePence: 6_000 }),
    ], NOW);
    assert.equal(snapshot.revenuePence, 0);
    assert.equal(snapshot.revenueOrderCount, 0);
  });
});

describe('patient revenue refund allocation', () => {
  it('uses product revenue first, then Pharmacy Delivery, then dispensing', () => {
    assert.deepEqual(allocatePatientRevenueAfterRefund({
      productRevenuePence: 10_000,
      pharmacyDeliveryPence: 1_000,
      dispensingFeePence: 500,
      refundPence: 10_750,
    }), { productRevenuePence: 0, pharmacyDeliveryPence: 250, dispensingFeePence: 500, patientRevenuePence: 750 });
    assert.deepEqual(allocatePatientRevenueAfterRefund({
      productRevenuePence: 10_000,
      pharmacyDeliveryPence: 1_000,
      dispensingFeePence: 500,
      refundPence: 11_250,
    }), { productRevenuePence: 0, pharmacyDeliveryPence: 0, dispensingFeePence: 250, patientRevenuePence: 250 });
  });

  it('zeroes every component for a full refund', () => {
    assert.deepEqual(allocatePatientRevenueAfterRefund({
      productRevenuePence: 10_000,
      pharmacyDeliveryPence: 1_000,
      dispensingFeePence: 500,
      refundPence: 11_500,
      fullyRefunded: true,
    }), { productRevenuePence: 0, pharmacyDeliveryPence: 0, dispensingFeePence: 0, patientRevenuePence: 0 });
  });
});
