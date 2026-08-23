import assert from 'node:assert/strict';
import test from 'node:test';
import { publicDirectoryPharmacyName } from '../src/shared/contracts.ts';

test('directory results prefer the pharmacy name over the company trading name', () => {
  assert.equal(publicDirectoryPharmacyName({
    name: 'Eastwood Health Pharmacy',
    tradingName: 'Eastwood Health Ltd',
  }), 'Eastwood Health Pharmacy');
  assert.equal(publicDirectoryPharmacyName({
    name: '  ',
    tradingName: 'Eastwood Health Ltd',
  }), 'Eastwood Health Ltd');
  assert.equal(publicDirectoryPharmacyName({
    tradingName: 'Eastwood Health Ltd',
  }), 'Eastwood Health Ltd');
});
