import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ONBOARDING_CONTENT_DEFAULTS } from '../../domain/pharmacy-onboarding/content.js';
import { branchHoldMessage } from './hold-message.js';

const readContent = async () => ONBOARDING_CONTENT_DEFAULTS;

describe('branchHoldMessage', () => {
  it('uses the branch request\'s reason, merged with the request\'s pharmacy name', async () => {
    const message = await branchHoldMessage({
      findRequestByOrganisation: async () => ({ holdReason: 'CURALEAF_DECLINED', pharmacyName: 'Shah Pharmacy' }),
      readContent,
    }, { id: 'org-1', name: 'Shah Branch' });
    assert.equal(message.reason, 'CURALEAF_DECLINED');
    assert.equal(message.heading, ONBOARDING_CONTENT_DEFAULTS.holdPage.heading);
    assert.match(message.paragraphs.join(' '), /were not able to open an account for Shah Pharmacy/);
    assert.equal(message.footer, ONBOARDING_CONTENT_DEFAULTS.holdPage.footer);
  });

  it('reads a held branch with no reason on record as an existing Curaleaf customer', async () => {
    const message = await branchHoldMessage({
      findRequestByOrganisation: async () => null,
      readContent,
    }, { id: 'org-1', name: 'Shah Branch' });
    assert.equal(message.reason, 'EXISTING_CURALEAF_CUSTOMER');
    assert.match(message.paragraphs.join(' '), /Shah Branch already has an account/);
  });
});
