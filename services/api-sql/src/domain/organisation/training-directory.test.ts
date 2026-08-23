import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isTrainingDirectoryOrganisation } from './training-directory.js';

describe('isTrainingDirectoryOrganisation', () => {
  it('keeps Primary and Alternate out of admin finance', () => {
    assert.equal(isTrainingDirectoryOrganisation({
      id: '70913a30-71c3-4a41-952e-d532927af58c',
      tradingName: 'Primary Branch',
      classification: 'STANDARD',
    }), true);
    assert.equal(isTrainingDirectoryOrganisation({
      id: 'f486a221223644a5b072f06de399ab0e',
      name: 'Alternate Pharmacy',
      classification: 'LIVE',
    }), true);
  });

  it('keeps classified training tenants out of admin finance', () => {
    assert.equal(isTrainingDirectoryOrganisation({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tradingName: 'Sandbox',
      classification: 'TRAINING',
    }), true);
  });

  it('leaves registered pharmacies in admin finance', () => {
    assert.equal(isTrainingDirectoryOrganisation({
      id: '6d0176bb-89a0-4e32-9bce-c934c9557c42',
      tradingName: 'Eastwood Health Ltd',
      classification: 'STANDARD',
    }), false);
  });
});
