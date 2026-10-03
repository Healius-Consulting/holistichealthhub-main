import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  matchExistingPharmacyForPharmsmart,
  pharmacyStaffEmails,
  pharmsmartSsoContract,
} from './pharmsmart-sso.js';

const monivea = {
  id: '70913a30-71c3-4a41-952e-d532927af58c',
  gphcNumber: 'gphc-monivea-existing',
  pharmsmartPharmacyId: null,
};

describe('Pharmsmart SSO contract', () => {
  it('refuses redemption until the token contract and a server credential exist', () => {
    const contract = pharmsmartSsoContract();
    assert.equal(contract.redeemable, false);
    assert.equal(contract.pharmacyDetailsAuthenticated, false);
    assert.deepEqual(contract.missing, [
      'token_algorithm',
      'shared_secret',
      'token_expiry',
      'claim_names',
      'pharmacy_details_schema',
      'server_credential',
    ]);
  });
});

describe('existing pharmacy link', () => {
  it('keeps Monivea Road on its stored GPhC and does not create a pharmacy from a name', () => {
    const matched = matchExistingPharmacyForPharmsmart([monivea], { gphcNumber: 'gphc-monivea-existing' });
    assert.deepEqual(matched, { status: 'matched', organisationId: monivea.id });

    assert.deepEqual(
      matchExistingPharmacyForPharmsmart([monivea], {}),
      { status: 'unmatched', reason: 'IDENTITY_REQUIRED' },
    );
  });

  it('matches a stored Pharmsmart pharmacy id on that same organisation', () => {
    const linked = { ...monivea, pharmsmartPharmacyId: 'ps-monivea' };
    assert.deepEqual(
      matchExistingPharmacyForPharmsmart([linked], { pharmsmartPharmacyId: 'ps-monivea' }),
      { status: 'matched', organisationId: monivea.id },
    );
  });

  it('refuses a GPhC and Pharmsmart id that point at different pharmacies', () => {
    const other = { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', gphcNumber: '1099999', pharmsmartPharmacyId: 'ps-other' };
    assert.deepEqual(
      matchExistingPharmacyForPharmsmart([monivea, other], { gphcNumber: monivea.gphcNumber, pharmsmartPharmacyId: 'ps-other' }),
      { status: 'unmatched', reason: 'AMBIGUOUS' },
    );
  });

  it('refuses an unknown GPhC instead of inserting a pharmacy', () => {
    assert.deepEqual(
      matchExistingPharmacyForPharmsmart([monivea], { gphcNumber: '0000000' }),
      { status: 'unmatched', reason: 'NOT_FOUND' },
    );
  });
});

describe('pharmacy staff access', () => {
  it('keeps invited emails as the only access list while SSO cannot be redeemed', () => {
    const contract = pharmsmartSsoContract();
    assert.deepEqual(pharmacyStaffEmails({
      invitedEmails: ['Temp.User@pharmacy.test'],
      ssoEmail: 'pharmacist@pharmacy.test',
      ssoRedeemable: contract.redeemable,
    }), ['temp.user@pharmacy.test']);
  });

  it('adds an SSO email to the same list once redemption is allowed', () => {
    assert.deepEqual(pharmacyStaffEmails({
      invitedEmails: ['temp.user@pharmacy.test'],
      ssoEmail: 'pharmacist@pharmacy.test',
      ssoRedeemable: true,
    }), ['temp.user@pharmacy.test', 'pharmacist@pharmacy.test']);
  });
});
