import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isOpenPharmacyWorkspace,
  pharmacyWorkspaceStatusLabel,
  resolvePharmacyWorkspaceMode,
} from '../src/training/workspaceMode.ts';

const livePharmacy = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  status: 'live' as const,
  workspaceClassification: 'standard' as const,
  testAccount: true,
};

test('Training, Test and Live are distinct pharmacy workspaces', () => {
  assert.equal(resolvePharmacyWorkspaceMode({
    id: '70913a30-71c3-4a41-952e-d532927af58c',
    status: 'live',
    workspaceClassification: 'standard',
  }), 'training');
  assert.equal(resolvePharmacyWorkspaceMode({
    ...livePharmacy,
    status: 'onboarding',
  }), 'training');
  assert.equal(resolvePharmacyWorkspaceMode(livePharmacy), 'test');
  assert.equal(resolvePharmacyWorkspaceMode(livePharmacy, { curaleafEstate: 'test' }), 'test');
  assert.equal(resolvePharmacyWorkspaceMode(livePharmacy, { curaleafEstate: 'production' }), 'live');
  assert.equal(isOpenPharmacyWorkspace('training'), false);
  assert.equal(isOpenPharmacyWorkspace('test'), true);
  assert.equal(isOpenPharmacyWorkspace('live'), true);
  assert.equal(pharmacyWorkspaceStatusLabel('test'), 'Test');
  assert.equal(pharmacyWorkspaceStatusLabel('live'), 'Live');
  assert.equal(pharmacyWorkspaceStatusLabel('training'), 'Training');
});
