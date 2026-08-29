import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flattenPrescriptionLines } from '../src/pages/create-order/prescriptionLineOwnership.ts';

describe('create-order prescription line ownership', () => {
  it('keeps three prescriptions attached to their own pack lines', () => {
    const lines = flattenPrescriptionLines([
      { id: 101, items: [{ packId: 'pack-a', quantity: 1 }] },
      { id: 102, items: [{ packId: 'pack-b', quantity: 2 }] },
      { id: 103, items: [{ packId: 'pack-c', quantity: 3 }] },
    ], item => item);

    assert.deepEqual(lines, [
      { packId: 'pack-a', quantity: 1, localPrescriptionId: '101' },
      { packId: 'pack-b', quantity: 2, localPrescriptionId: '102' },
      { packId: 'pack-c', quantity: 3, localPrescriptionId: '103' },
    ]);
    assert.deepEqual(lines.map(line => line.localPrescriptionId), ['101', '102', '103']);
  });

  it('preserves the single-prescription payload shape', () => {
    assert.deepEqual(flattenPrescriptionLines([
      { id: 1, items: [{ packId: 'pack-only', quantity: 1 }] },
    ], item => item), [
      { packId: 'pack-only', quantity: 1, localPrescriptionId: '1' },
    ]);
  });
});
