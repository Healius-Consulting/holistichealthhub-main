import assert from 'node:assert/strict';
import test from 'node:test';

import { replacementAllocationAmount, replacementPrescriptionPolicy, replacementSupplierResolution } from './replacement-resolution.js';

test('requires every supplier split line to be shipped or explicitly cancelled before replacement', () => {
  assert.deepEqual(replacementSupplierResolution({
    hasPurchaseOrder: true,
    cancellationConfirmed: true,
    fulfilmentLines: [{ ordered: 4, shipped: 2, cancelledRemainder: 1 }],
  }), { resolved: false, reason: 'supplier_split_not_fully_resolved' });
  assert.deepEqual(replacementSupplierResolution({
    hasPurchaseOrder: true,
    cancellationConfirmed: true,
    fulfilmentLines: [{ ordered: 4, shipped: 2, cancelledRemainder: 2 }],
  }), { resolved: true });
});

test('does not treat a cancelled purchase order with missing line evidence as resolved', () => {
  assert.deepEqual(replacementSupplierResolution({
    hasPurchaseOrder: true,
    cancellationConfirmed: true,
    fulfilmentLines: [],
  }), { resolved: false, reason: 'supplier_lines_require_reconciliation' });
});

test('transfers the full paid allocation when Curaleaf shipped nothing', () => {
  assert.equal(replacementAllocationAmount({
    activeAllocationPence: 18_000,
    hasPurchaseOrder: true,
    sourceLines: [{ packId: 'pack-a', quantity: 2, fixedPatientPricePence: 8_500 }],
    fulfilmentLines: [{ productId: 'pack-a', shipped: 0, cancelledRemainder: 2 }],
  }), 18_000);
});

test('retains fees and supplied value while transferring only a partial cancelled remainder', () => {
  assert.equal(replacementAllocationAmount({
    activeAllocationPence: 35_000,
    hasPurchaseOrder: true,
    sourceLines: [{ packId: 'pack-a', quantity: 4, fixedPatientPricePence: 8_500 }],
    fulfilmentLines: [{ productId: 'pack-a', shipped: 2, cancelledRemainder: 2 }],
  }), 17_000);
});

test('fails closed on ambiguous duplicate-product remainder pricing', () => {
  assert.throws(() => replacementAllocationAmount({
    activeAllocationPence: 20_000,
    hasPurchaseOrder: true,
    sourceLines: [
      { packId: 'pack-a', quantity: 1, fixedPatientPricePence: 8_500 },
      { packId: 'pack-a', quantity: 1, fixedPatientPricePence: 9_000 },
    ],
    fulfilmentLines: [{ productId: 'pack-a', shipped: 1, cancelledRemainder: 1 }],
  }), /one priced order line/);
});

test('allows a copied serial after a purchase order when the scan is still on file', () => {
  assert.deepEqual(replacementPrescriptionPolicy({
    sourceSerial: 'rx-1',
    sourceIssueDate: '2026-08-01',
    sourceOrderId: 'source-1',
    liveOrderId: 'source-1',
    replacementSerial: 'rx-1',
    replacementIssueDate: '2026-08-01',
    replacementHasUsableFile: true,
    sourceLines: [{ packId: 'pack-a', quantity: 1 }],
    replacementLines: [{ packId: 'pack-a', quantity: 1 }],
    asOf: new Date('2026-08-12T00:00:00.000Z'),
  }), { allowed: true, reusesSourceSerial: true, reason: undefined, occupyingOrderId: undefined });
});

test('rejects a copied serial once the 24-day reuse window has closed', () => {
  assert.equal(replacementPrescriptionPolicy({
    sourceSerial: 'rx-1',
    sourceIssueDate: '2026-07-18',
    sourceOrderId: 'source-1',
    liveOrderId: 'source-1',
    replacementSerial: 'rx-1',
    replacementHasUsableFile: true,
    sourceLines: [{ packId: 'pack-a', quantity: 1 }],
    replacementLines: [{ packId: 'pack-a', quantity: 1 }],
    asOf: new Date('2026-08-12T00:00:00.000Z'),
  }).reason, 'SERIAL_REUSE_EXPIRED');
});
