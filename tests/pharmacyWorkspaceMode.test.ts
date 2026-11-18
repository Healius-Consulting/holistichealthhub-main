import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isOpenPharmacyWorkspace,
  pharmacyWorkspaceStatusLabel,
  resolvePharmacyWorkspaceMode,
  usesSandboxDummyPack,
} from '../src/training/workspaceMode.ts';

const livePharmacy = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  status: 'live' as const,
  workspaceClassification: 'standard' as const,
  testAccount: true,
};

const primary = {
  id: '70913a30-71c3-4a41-952e-d532927af58c',
  status: 'onboarding' as const,
  workspaceClassification: 'standard' as const,
};

test('Training, Test and Live are distinct pharmacy workspaces', () => {
  assert.equal(resolvePharmacyWorkspaceMode(primary), 'test');
  assert.equal(resolvePharmacyWorkspaceMode(primary, { localPreview: true }), 'training');
  assert.equal(resolvePharmacyWorkspaceMode(primary, { curaleafEstate: 'production' }), 'live');
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
  assert.equal(pharmacyWorkspaceStatusLabel('training'), 'Awaiting Curaleaf');
});

test('the demo data set shows in Demo mode or local preview, never on a live account otherwise', () => {
  assert.equal(usesSandboxDummyPack({ demo: true, localPreview: false }), true);
  assert.equal(usesSandboxDummyPack({ demo: false, localPreview: true }), true);
  assert.equal(usesSandboxDummyPack({ demo: false, localPreview: false }), false);
});

test('Demo mode runs any pharmacy as a closed training workspace, whatever its status', () => {
  assert.equal(resolvePharmacyWorkspaceMode(livePharmacy, { curaleafEstate: 'production', demo: true }), 'training');
  assert.equal(resolvePharmacyWorkspaceMode(primary, { demo: true }), 'training');
  assert.equal(resolvePharmacyWorkspaceMode({ ...livePharmacy, status: 'onboarding' }, { demo: true }), 'training');
  assert.equal(resolvePharmacyWorkspaceMode(livePharmacy, { curaleafEstate: 'production', demo: false }), 'live');
});
