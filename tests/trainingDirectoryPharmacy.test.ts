import assert from 'node:assert/strict';
import test from 'node:test';
import { isPlatformTestPharmacy, isTrainingDirectoryPharmacy } from '../src/shared/contracts.ts';

test('only the known Primary and Alternate IDs are platform Test pharmacies', () => {
  assert.equal(isPlatformTestPharmacy({ id: '70913a30-71c3-4a41-952e-d532927af58c', tradingName: 'Primary Branch' }), true);
  assert.equal(isTrainingDirectoryPharmacy({ id: 'f486a221-2236-44a5-b072-f06de399ab0e', name: 'Alternate Pharmacy' }), true);
  assert.equal(isPlatformTestPharmacy({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', testAccount: true, tradingName: 'Sandbox' }), false);
  assert.equal(isPlatformTestPharmacy({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', workspaceClassification: 'training', tradingName: 'Demo' }), false);
});

test('Eastwood, K-Chem, and new pharmacies stay ordinary tenants even if branded Primary Branch', () => {
  assert.equal(isPlatformTestPharmacy({ id: '6d0176bb-89a0-4e32-9bce-c934c9557c42', tradingName: 'Eastwood Health Ltd' }), false);
  assert.equal(isPlatformTestPharmacy({ id: '3e9f74ff-4fed-497d-904d-4d3ee3e5e126', tradingName: 'K-Chem Ltd' }), false);
  assert.equal(isPlatformTestPharmacy({ id: '3e9f74ff-4fed-497d-904d-4d3ee3e5e126', tradingName: 'Primary Branch' }), false);
  assert.equal(isPlatformTestPharmacy({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', tradingName: 'Primary Branch' }), false);
});
