import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { quotedCostFromSnapshot, stampPaidQuoteOnSnapshot } from './finance-costing.js';

const paidQuote = {
  shippingPrice: '5.00',
  taxRate: '0.2',
  items: [{
    packId: 'pack-a',
    quantity: 1,
    inStock: true,
    wholesalePackPrice: '68.00',
    patientPackPrice: '85.00',
  }],
};

describe('quoted cost from order snapshot', () => {
  it('uses the stored quote wholesale and shipping, not 75% of patient price', () => {
    const cost = quotedCostFromSnapshot({
      lineItems: [{ packId: 'pack-a', quantity: 1, unitPricePence: 8500 }],
      quote: paidQuote,
      pricingQuote: paidQuote,
    });
    assert.equal(cost.wholesaleComplete, true);
    assert.equal(cost.wholesaleProductPence, 6800);
    assert.equal(cost.shippingPence, 500);
    assert.equal(cost.wholesalePence, 7300);
  });

  it('does not invent a cost when the paid quote is missing', () => {
    const cost = quotedCostFromSnapshot({
      lineItems: [{ packId: 'pack-a', quantity: 1, unitPricePence: 8500 }],
    });
    assert.equal(cost.wholesaleComplete, false);
    assert.equal(cost.wholesaleProductPence, null);
    assert.equal(cost.shippingPence, null);
    assert.equal(cost.wholesalePence, null);
  });

  it('ignores a later quote-review price when the paid quote is stored', () => {
    const cost = quotedCostFromSnapshot({
      quote: paidQuote,
      quoteReview: {
        latestQuote: {
          ...paidQuote,
          items: [{ ...paidQuote.items[0]!, wholesalePackPrice: '72.00' }],
          shippingPrice: '7.00',
        },
      },
    });
    assert.equal(cost.wholesaleProductPence, 6800);
    assert.equal(cost.shippingPence, 500);
  });
});

describe('quote bank fallback for orders with no frozen paid quote', () => {
  const bank = new Map([['pack-a', 6400], ['pack-b', 3000]]);

  it('prefers the frozen paid quote over the bank', () => {
    const cost = quotedCostFromSnapshot({
      lineItems: [{ packId: 'pack-a', quantity: 1, unitPricePence: 8500 }],
      quote: paidQuote,
    }, { bankWholesalePenceByPackId: bank });
    assert.equal(cost.costBasis, 'paid_quote');
    assert.equal(cost.wholesaleProductPence, 6800);
    assert.equal(cost.shippingKnown, true);
  });

  it('falls back to the paid payment-gate totals before the bank', () => {
    const cost = quotedCostFromSnapshot({
      lineItems: [{ packId: 'pack-a', quantity: 1, unitPricePence: 8500 }],
      paymentQuote: { wholesaleTotalPence: 7300, shippingPence: 500 },
    }, { bankWholesalePenceByPackId: bank });
    assert.equal(cost.costBasis, 'paid_quote_totals');
    assert.equal(cost.wholesaleProductPence, 6800);
    assert.equal(cost.shippingPence, 500);
    assert.equal(cost.wholesalePence, 7300);
    assert.equal(cost.prices.size, 0);
  });

  it('estimates from the bank when nothing paid was ever frozen', () => {
    const cost = quotedCostFromSnapshot({
      lineItems: [{ packId: 'pack-a', quantity: 2, unitPricePence: 8500 }],
    }, { bankWholesalePenceByPackId: bank });
    assert.equal(cost.wholesaleComplete, true);
    assert.equal(cost.costBasis, 'quote_bank');
    assert.equal(cost.wholesaleProductPence, 12800);
    // The bank prices packs, not delivery: shipping stays unknown rather than invented.
    assert.equal(cost.shippingKnown, false);
    assert.equal(cost.shippingPence, null);
    assert.equal(cost.wholesalePence, 12800);
    assert.equal(cost.prices.get('pack-a'), 6400);
  });

  it('stays awaiting-quote when the bank cannot price every line', () => {
    const cost = quotedCostFromSnapshot({
      lineItems: [
        { packId: 'pack-a', quantity: 1, unitPricePence: 8500 },
        { packId: 'pack-unknown', quantity: 1, unitPricePence: 4000 },
      ],
    }, { bankWholesalePenceByPackId: bank });
    assert.equal(cost.wholesaleComplete, false);
    assert.equal(cost.costBasis, null);
    assert.equal(cost.wholesaleProductPence, null);
  });

  it('never invents a cost from the patient price when there is no bank', () => {
    const cost = quotedCostFromSnapshot({
      lineItems: [{ packId: 'pack-a', quantity: 1, unitPricePence: 8500 }],
    });
    assert.equal(cost.wholesaleComplete, false);
    assert.equal(cost.costBasis, null);
  });

  it('reads prescription item lines as well as line items', () => {
    const cost = quotedCostFromSnapshot({
      prescriptions: [{ items: [{ productId: 'pack-b', quantity: 3 }] }],
    }, { bankWholesalePenceByPackId: bank });
    assert.equal(cost.costBasis, 'quote_bank');
    assert.equal(cost.wholesaleProductPence, 9000);
  });
});

describe('freezing the paid quote onto a snapshot', () => {
  it('stamps the paid quote when nothing froze it earlier', () => {
    const stamped = stampPaidQuoteOnSnapshot({ lineItems: [] }, paidQuote);
    assert.equal(quotedCostFromSnapshot(stamped).costBasis, 'paid_quote');
    assert.equal(quotedCostFromSnapshot(stamped).wholesaleProductPence, 6800);
  });

  it('never overwrites a quote that is already frozen', () => {
    const original = { quote: paidQuote };
    const stamped = stampPaidQuoteOnSnapshot(original, {
      ...paidQuote,
      items: [{ ...paidQuote.items[0]!, wholesalePackPrice: '99.00' }],
    });
    assert.equal(quotedCostFromSnapshot(stamped).wholesaleProductPence, 6800);
  });

  it('ignores an unparseable quote instead of corrupting the snapshot', () => {
    const stamped = stampPaidQuoteOnSnapshot({ lineItems: [] }, { items: [] });
    assert.deepEqual(stamped, { lineItems: [] });
  });
});
