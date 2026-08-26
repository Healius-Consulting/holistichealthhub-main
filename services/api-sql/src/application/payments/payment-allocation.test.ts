import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { refundedAllocationState } from './payment-allocation.js';

describe('refunded payment allocations', () => {
  it('closes a fully refunded allocation', () => {
    assert.deepEqual(refundedAllocationState(12_500, 12_500), { amountPence: 0, status: 'REFUNDED' });
  });

  it('keeps only the unrefunded remainder active', () => {
    assert.deepEqual(refundedAllocationState(12_500, 4_000), { amountPence: 8_500, status: 'ACTIVE' });
  });

  it('rejects a refund beyond the active allocation', () => {
    assert.throws(() => refundedAllocationState(4_000, 4_001), /exceeds/);
  });
});
