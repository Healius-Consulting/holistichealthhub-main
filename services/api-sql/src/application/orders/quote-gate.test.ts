import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { authoritativeQuoteLineItems, authoritativeQuotePricing, evaluateQuoteGate, quoteBasketFingerprint, quotePaymentTotalPence } from './quote-gate.js';

const raw = {
  shippingPrice: '5.00',
  taxRate: '0',
  items: [{ packId: 'pack-a', quantity: 2, inStock: true, wholesalePackPrice: '68.00', patientPackPrice: '85.00' }],
};

describe('quote gates', () => {
  it('derives payment amount from the supplier quote and server fee', () => {
    const check = evaluateQuoteGate({ rawQuote: raw, basket: [{ packId: 'pack-a', quantity: 2 }], dispensingFeePence: 1000 });
    assert.equal(check.status, 'MATCHED');
    assert.equal(check.patientTotalPence, 18_000);
    assert.equal(quotePaymentTotalPence(check.quote, 1000), 18_000);
  });

  it('freezes totals and line prices from the supplier quote', () => {
    const check = evaluateQuoteGate({ rawQuote: raw, basket: [{ packId: 'pack-a', quantity: 2 }], dispensingFeePence: 1000 });
    const pricing = authoritativeQuotePricing(check);
    assert.equal(pricing.medicineTotalPence, 17_000);
    assert.equal(pricing.deliveryPence, 500);
    assert.equal(pricing.totalPence, 18_000);
    assert.deepEqual(pricing.unitPrices.get('pack-a'), { patientPence: 8_500, wholesalePence: 6_800 });
    assert.deepEqual(authoritativeQuoteLineItems([
      { packId: 'pack-a', quantity: 2, unitPricePence: 1, name: 'Caller metadata is retained' },
    ], check), [{
      packId: 'pack-a', quantity: 2, unitPricePence: 8_500, wholesalePackPricePence: 6_800,
      name: 'Caller metadata is retained',
    }]);
  });

  it('adds Pharmacy Delivery but never Curaleaf Delivery to a new patient total', () => {
    assert.equal(quotePaymentTotalPence(evaluateQuoteGate({ rawQuote: raw, basket: [{ packId: 'pack-a', quantity: 2 }] }).quote, 500, 1_500), 19_000);
  });

  it('retains Curaleaf Delivery for unstamped legacy-order rechecks', () => {
    assert.equal(quotePaymentTotalPence(evaluateQuoteGate({ rawQuote: raw, basket: [{ packId: 'pack-a', quantity: 2 }] }).quote, 500, 0, true), 18_000);
  });

  it('rejects incomplete or substituted baskets', () => {
    const check = evaluateQuoteGate({ rawQuote: raw, basket: [{ packId: 'pack-b', quantity: 2 }] });
    assert.equal(check.status, 'RECONCILIATION_REQUIRED');
  });

  it('holds out of stock before payment', () => {
    const check = evaluateQuoteGate({
      rawQuote: { ...raw, items: [{ ...raw.items[0], inStock: false }] },
      basket: [{ packId: 'pack-a', quantity: 2 }],
    });
    assert.equal(check.status, 'OUT_OF_STOCK');
  });

  it('requires review for increases, decreases and wholesale-only changes', () => {
    const baselineEvaluation = evaluateQuoteGate({ rawQuote: raw, basket: [{ packId: 'pack-a', quantity: 2 }] });
    const baseline = {
      id: 'quote-1', organisationId: 'org', orderId: 'order', phase: 'PRE_PAYMENT' as const, status: 'MATCHED' as const,
      basketFingerprint: quoteBasketFingerprint([{ packId: 'pack-a', quantity: 2 }]),
      quoteFingerprint: baselineEvaluation.quoteFingerprint,
      patientTotalPence: baselineEvaluation.patientTotalPence,
      wholesaleTotalPence: baselineEvaluation.wholesaleTotalPence,
      shippingPence: 500, taxPence: 0, rawQuote: raw, createdAt: '2026-01-01T00:00:00Z',
    };
    for (const changed of [
      { ...raw, items: [{ ...raw.items[0], patientPackPrice: '90.00' }] },
      { ...raw, items: [{ ...raw.items[0], patientPackPrice: '80.00' }] },
      { ...raw, items: [{ ...raw.items[0], wholesalePackPrice: '70.00' }] },
    ]) {
      assert.equal(evaluateQuoteGate({ rawQuote: changed, basket: [{ packId: 'pack-a', quantity: 2 }], baseline }).status, 'REVIEW_REQUIRED');
    }
  });

  it('does not adopt a missing paid baseline', () => {
    const invalidBaseline = {
      id: 'quote-1', organisationId: 'org', orderId: 'order', phase: 'PRE_PAYMENT' as const, status: 'MATCHED' as const,
      basketFingerprint: quoteBasketFingerprint([{ packId: 'pack-a', quantity: 2 }]), quoteFingerprint: 'old',
      patientTotalPence: 17000, wholesaleTotalPence: 13600, shippingPence: 500, taxPence: 0,
      rawQuote: null, createdAt: '2026-01-01T00:00:00Z',
    };
    assert.equal(evaluateQuoteGate({ rawQuote: raw, basket: [{ packId: 'pack-a', quantity: 2 }], baseline: invalidBaseline }).status, 'RECONCILIATION_REQUIRED');
  });
});
