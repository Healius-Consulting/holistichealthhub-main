import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { orderPayableTotal } from './payment-lifecycle.js';

describe('payment payable totals', () => {
  it('includes medicine, dispensing, and Pharmacy Delivery', () => {
    assert.equal(orderPayableTotal({
      dispensingFeePence: 500,
      pharmacyDeliveryPence: 1_000,
      quoteSnapshot: {
        lineItems: [{ packId: 'pack-1', unitPricePence: 8_500 }],
      },
    }, [{ items: [{ packId: 'pack-1', quantity: 2 }] }]), 18_500);
  });

  it('does not introduce a charge when no payable medicine remains', () => {
    assert.equal(orderPayableTotal({ dispensingFeePence: 500, pharmacyDeliveryPence: 1_000 }, []), 0);
  });
});
