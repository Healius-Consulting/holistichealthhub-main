import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isHiddenPublicPharmacy,
  isPubliclyListedPharmacy,
  type PublicListingOrganisation,
} from './public-listing.js';

const realPharmacy: PublicListingOrganisation = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Eastwood Health Pharmacy',
  tradingName: 'Eastwood Health Ltd',
  classification: 'STANDARD',
  status: 'ONBOARDING',
  archivedAt: null,
};

describe('public pharmacy listing', () => {
  it('lists real pharmacies before go-live', () => {
    assert.equal(isPubliclyListedPharmacy(realPharmacy), true);
    assert.equal(isPubliclyListedPharmacy({ ...realPharmacy, status: 'INTAKE_LIVE' }), true);
    assert.equal(isPubliclyListedPharmacy({ ...realPharmacy, status: 'LIVE' }), true);
  });

  it('hides paused, archived, training, and Holistic Health Hub Allocation workspaces', () => {
    assert.equal(isPubliclyListedPharmacy({ ...realPharmacy, status: 'PAUSED' }), false);
    assert.equal(isPubliclyListedPharmacy({ ...realPharmacy, archivedAt: '2026-08-19T00:00:00.000Z' }), false);
    assert.equal(isPubliclyListedPharmacy({ ...realPharmacy, classification: 'TRAINING' }), false);
    assert.equal(isPubliclyListedPharmacy({
      ...realPharmacy,
      classification: 'ALLOCATION_HOLDING',
      status: 'LIVE',
    }), false);
  });

  it('keeps Primary Pharmacy and Alternate Pharmacy off the public form', () => {
    assert.equal(isHiddenPublicPharmacy({
      ...realPharmacy,
      id: '70913a30-71c3-4a41-952e-d532927af58c',
      name: 'Primary Branch',
      tradingName: 'Primary Pharmacy',
    }), true);
    assert.equal(isHiddenPublicPharmacy({
      ...realPharmacy,
      id: 'f486a221-2236-44a5-b072-f06de399ab0e',
      name: 'Alternate Branch',
      tradingName: 'Alternate Pharmacy',
    }), true);
    assert.equal(isPubliclyListedPharmacy({
      ...realPharmacy,
      id: 'f486a221-2236-44a5-b072-f06de399ab0e',
      status: 'LIVE',
    }), false);
    assert.equal(isHiddenPublicPharmacy({
      ...realPharmacy,
      id: '3e9f74ff-4fed-497d-904d-4d3ee3e5e126',
      name: 'Primary Branch',
      tradingName: 'Primary Branch',
    }), false);
  });
});
