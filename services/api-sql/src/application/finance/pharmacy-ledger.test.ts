import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allocatePatientRevenueAfterRefund, OVERVIEW_FINANCE_PERIOD_DAYS, overviewFinanceSnapshot } from './pharmacy-ledger.js';

const NOW = Date.parse('2026-08-27T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

type Row = Parameters<typeof overviewFinanceSnapshot>[0][number];

function row(overrides: Partial<Row> = {}): Row {
  return {
    financialEventAt: daysAgo(1),
    realised: false,
    pendingCollection: false,
    patientRevenuePence: 0,
    totalContributionPence: null,
    wholesaleComplete: false,
    paymentStatus: 'paid',
    ...overrides,
  };
}

describe('the Overview thirty-day money snapshot', () => {
  it('reports the agreed fixed window', () => {
    assert.equal(OVERVIEW_FINANCE_PERIOD_DAYS, 30);
    assert.equal(overviewFinanceSnapshot([], NOW).period, '30d');
  });

  it('counts only realised orders as earned revenue', () => {
    const snapshot = overviewFinanceSnapshot([
      row({ realised: true, patientRevenuePence: 6_000 }),
      row({ pendingCollection: true, patientRevenuePence: 4_000 }),
      row({ paymentStatus: 'pending', patientRevenuePence: 2_500 }),
    ], NOW);
    assert.equal(snapshot.realisedPatientRevenuePence, 6_000);
    assert.equal(snapshot.realisedCount, 1);
  });

  it('separates money paid but awaiting collection from money already earned', () => {
    const snapshot = overviewFinanceSnapshot([
      row({ realised: true, patientRevenuePence: 6_000 }),
      row({ pendingCollection: true, patientRevenuePence: 4_000 }),
      row({ pendingCollection: true, patientRevenuePence: 1_500 }),
    ], NOW);
    assert.equal(snapshot.pendingCollectionCount, 2);
    assert.equal(snapshot.pendingPatientRevenuePence, 5_500);
  });

  it('reports the value still awaiting payment, not just the count', () => {
    const snapshot = overviewFinanceSnapshot([
      row({ paymentStatus: 'pending', patientRevenuePence: 2_500 }),
      row({ paymentStatus: 'awaiting_manual_payment', patientRevenuePence: 3_000 }),
      row({ realised: true, patientRevenuePence: 6_000 }),
    ], NOW);
    assert.equal(snapshot.awaitingPaymentCount, 2);
    assert.equal(snapshot.awaitingPaymentValuePence, 5_500);
  });

  it('excludes anything older than the window', () => {
    const snapshot = overviewFinanceSnapshot([
      row({ realised: true, patientRevenuePence: 6_000, financialEventAt: daysAgo(2) }),
      row({ realised: true, patientRevenuePence: 9_900, financialEventAt: daysAgo(31) }),
    ], NOW);
    assert.equal(snapshot.realisedPatientRevenuePence, 6_000);
    assert.equal(snapshot.realisedCount, 1);
  });

  it('sums contribution only over orders with a wholesale cost to work from', () => {
    const snapshot = overviewFinanceSnapshot([
      row({ realised: true, patientRevenuePence: 6_000, wholesaleComplete: true, totalContributionPence: 2_000 }),
      row({ realised: true, patientRevenuePence: 5_000, wholesaleComplete: false, totalContributionPence: null }),
    ], NOW);
    assert.equal(snapshot.contributionPence, 2_000);
    // The pharmacy is told the figure is partial rather than shown £20.00 as if
    // the uncosted order had cost nothing at all.
    assert.equal(snapshot.contributionComplete, false);
  });

  it('reports contribution as complete when every realised order is costed', () => {
    const snapshot = overviewFinanceSnapshot([
      row({ realised: true, patientRevenuePence: 6_000, wholesaleComplete: true, totalContributionPence: 2_000 }),
      row({ realised: true, patientRevenuePence: 5_000, wholesaleComplete: true, totalContributionPence: 1_500 }),
    ], NOW);
    assert.equal(snapshot.contributionPence, 3_500);
    assert.equal(snapshot.contributionComplete, true);
  });

  it('is all zeroes rather than absent for a pharmacy that has not traded', () => {
    const snapshot = overviewFinanceSnapshot([], NOW);
    assert.equal(snapshot.realisedPatientRevenuePence, 0);
    assert.equal(snapshot.pendingCollectionCount, 0);
    assert.equal(snapshot.awaitingPaymentValuePence, 0);
    assert.equal(snapshot.contributionComplete, true);
  });

  it('ignores rows with no financial event date instead of dating them today', () => {
    const snapshot = overviewFinanceSnapshot([
      row({ realised: true, patientRevenuePence: 6_000, financialEventAt: '' }),
    ], NOW);
    assert.equal(snapshot.realisedCount, 0);
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
