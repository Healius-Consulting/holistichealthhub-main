import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_RETENTION_WINDOWS,
  discountFloorError,
  discountFromInput,
  inactiveFromLastPayment,
  inferRetention,
  linePriceError,
  medicinesGrossProfitPence,
  prefillPatientPricePence,
  proportionalDiscountShare,
  weightedMarginPercent,
} from './rules.js';

describe('line prices', () => {
  it('accepts RRP plus 10 percent and rejects a penny over, and rejects a price below wholesale', () => {
    assert.equal(linePriceError(11_000, 10_000, 8_000), null);
    assert.match(linePriceError(11_001, 10_000, 8_000) ?? '', /10%/);
    assert.match(linePriceError(7_999, 10_000, 8_000) ?? '', /wholesale/);
  });

  it('keeps a saved price below a risen RRP and caps it when RRP falls', () => {
    assert.equal(prefillPatientPricePence({ savedPence: 18_700, rrpPence: 20_000, wholesalePence: 15_000 }), 18_700);
    assert.equal(prefillPatientPricePence({ savedPence: 18_700, rrpPence: 16_000, wholesalePence: 15_000 }), 17_600);
  });
});

describe('order discount', () => {
  it('discounts medicines only and refuses a net below wholesale', () => {
    assert.equal(discountFromInput(20_000, { mode: 'percent', percent: 10 }), 2_000);
    assert.equal(discountFloorError(20_000, 2_000, 16_395), null);
    assert.match(discountFloorError(20_000, 5_000, 16_395) ?? '', /wholesale/);
  });

  it('splits a partial refund discount in proportion to the line price', () => {
    assert.equal(proportionalDiscountShare(12_000, 20_000, 2_000), 1_200);
  });
});

describe('medicines-only margin', () => {
  it('uses medicine revenue after discount, not delivery, and weights the period', () => {
    assert.equal(medicinesGrossProfitPence(19_795, 16_395), 3_400);
    assert.equal(weightedMarginPercent(3_400, 19_795), 17.2);
    assert.equal(weightedMarginPercent(11_000, 40_000), 27.5);
  });
});

describe('inactive patients', () => {
  it('waits 56 days from the payment, including when that payment was later refunded', () => {
    const paid = '2026-07-01T00:00:00.000Z';
    assert.equal(inactiveFromLastPayment(paid, new Date('2026-08-25T00:00:00.000Z')), false);
    assert.equal(inactiveFromLastPayment(paid, new Date('2026-08-26T00:00:00.000Z')), true);
  });
});

describe('inferred retention', () => {
  const start = '2026-01-01T00:00:00.000Z';

  it('qualifies on day 120 when the first three windows each have a prescription', () => {
    const result = inferRetention({
      periodStart: start,
      prescriptionDates: ['2026-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z', '2026-05-01T00:00:00.000Z'],
      asOf: '2026-05-01T00:00:00.000Z',
    });
    assert.equal(result.status, 'Qualified');
    assert.deepEqual(result.met, ['W1', 'W2', 'W3']);
  });

  it('counts three early prescriptions as the initial appointment only', () => {
    const result = inferRetention({
      periodStart: start,
      prescriptionDates: ['2026-01-01T00:00:00.000Z', '2026-01-11T00:00:00.000Z', '2026-01-21T00:00:00.000Z'],
      asOf: '2026-01-21T00:00:00.000Z',
    });
    assert.deepEqual(result.met, ['W1']);
    assert.equal(result.status, 'On track');
  });

  it('is at risk when the one-month window closes empty', () => {
    const result = inferRetention({
      periodStart: start,
      prescriptionDates: ['2026-01-01T00:00:00.000Z'],
      asOf: '2026-03-03T00:00:00.000Z',
    });
    assert.equal(result.status, 'At risk');
  });

  it('follows a narrower W2 window on the next evaluation', () => {
    const dates = ['2026-01-01T00:00:00.000Z', '2026-02-20T00:00:00.000Z'];
    const asOf = '2026-03-15T00:00:00.000Z';
    assert.equal(inferRetention({ periodStart: start, prescriptionDates: dates, asOf }).status, 'On track');
    assert.equal(inferRetention({
      periodStart: start,
      prescriptionDates: dates,
      asOf,
      settings: { ...DEFAULT_RETENTION_WINDOWS, w2EndDay: 40 },
    }).met.includes('W2'), false);
  });
});
