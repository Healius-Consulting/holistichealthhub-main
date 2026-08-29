import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  compactCustomerReferenceBelongsToOrder,
  compactOrderReferenceToken,
} from '../src/utils/curaleafCustomerReference.ts';

describe('compact Curaleaf customer references', () => {
  it('recognises every prescription reference for the same order', () => {
    const orderNumber = 'ORD-MTDQOYO5-204A222B97';
    assert.equal(compactOrderReferenceToken(orderNumber, 'order-id'), '204A222B97');
    assert.equal(compactCustomerReferenceBelongsToOrder('VNR-204A222B97-P1', orderNumber, 'order-id'), true);
    assert.equal(compactCustomerReferenceBelongsToOrder('VNR-204A222B97-P2', orderNumber, 'order-id'), true);
    assert.equal(compactCustomerReferenceBelongsToOrder('VNR-204A222B97-P3', orderNumber, 'order-id'), true);
    assert.equal(compactCustomerReferenceBelongsToOrder('VNR-204A222B97-r1', orderNumber, 'order-id'), true);
  });

  it('rejects a compact reference belonging to another order', () => {
    assert.equal(
      compactCustomerReferenceBelongsToOrder(
        'VNR-AAAAAAAAAA-r1',
        'ORD-MTDQOYO5-204A222B97',
        'order-id',
      ),
      false,
    );
  });
});
