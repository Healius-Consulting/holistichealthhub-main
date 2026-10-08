import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  choosePharmsmartAccount,
  isPharmsmartSsoSignIn,
  issuePharmsmartSetupTicket,
  matchExistingPharmacyForPharmsmart,
  matchPharmacyByGphc,
  parsePharmsmartPharmacyInfo,
  pharmacyLoginAccount,
  pharmacyStaffEmails,
  pharmsmartSsoContract,
  readPharmsmartSetupTicket,
} from './pharmsmart-sso.js';

const monivea = {
  id: '70913a30-71c3-4a41-952e-d532927af58c',
  gphcNumber: 'gphc-monivea-existing',
  pharmsmartPharmacyId: null,
};

const pharmacyInfo = `{
    "status_code": 200,
    "status_message": "Pharmacy info",
    "data": {
        "pharmacy_id": 30,
        "email": "manoj.iihglobal@gmail.com",
        "first_name": "Sylvia",
        "last_name": "Hockett",
        "gphc": "1234471"
    }
}`;

describe('Pharmsmart SSO contract', () => {
  it('redeems an opaque token and matches the pharmacy by GPhC', () => {
    const contract = pharmsmartSsoContract();
    assert.equal(contract.redeemable, true);
    assert.equal(contract.pharmacyDetailsAuthenticated, true);
    assert.equal(contract.matchKey, 'gphc');
    assert.equal(contract.pharmsmartPharmacyId, 'external');
    assert.equal(contract.acceptsEmailNameQuery, false);
  });
});

describe('PharmSmart pharmacy info', () => {
  it('reads the GPhC and keeps PharmSmart pharmacy id as their identifier', () => {
    assert.deepEqual(parsePharmsmartPharmacyInfo(`\uFEFF${pharmacyInfo}`), {
      status: 'pharmacy',
      gphcNumber: '1234471',
      pharmsmartPharmacyId: '30',
      email: 'manoj.iihglobal@gmail.com',
      firstName: 'Sylvia',
      lastName: 'Hockett',
    });
  });

  it('treats an expired token as expired and ignores email and name on their own', () => {
    assert.deepEqual(parsePharmsmartPharmacyInfo('{"status_code":401,"status_message":"Token is expired"}'), {
      status: 'expired',
    });
    assert.deepEqual(parsePharmsmartPharmacyInfo('{"status_code":200,"data":{"email":"person@pharmacy.test","first_name":"Sylvia","last_name":"Hockett"}}'), {
      status: 'rejected',
    });
  });

  it('matches our pharmacy on GPhC even when another row uses PharmSmart id 30 as its own id', () => {
    const ours = { id: '70913a30-71c3-4a41-952e-d532927af58c', gphcNumber: '123 4471', pharmsmartPharmacyId: null };
    const theirs = { id: '30', gphcNumber: '9999999', pharmsmartPharmacyId: '30' };
    assert.deepEqual(matchPharmacyByGphc([ours, theirs], '1234471'), {
      status: 'matched',
      organisationId: ours.id,
    });
  });
});

describe('PharmSmart person account', () => {
  const organisationId = monivea.id;
  const sylvia = {
    uid: 'sylvia-uid',
    organisationId,
    email: 'sylvia@pharmacy.test',
    displayName: 'Sylvia Hockett',
    role: 'PHARMACY_STAFF' as const,
    status: 'ACTIVE' as const,
    disabled: false,
  };
  const person = { email: 'new.person@pharmacy.test', firstName: 'Amina', lastName: 'Khan' };

  it('reuses the same email and a unique matching name', () => {
    assert.deepEqual(choosePharmsmartAccount({
      organisationId,
      person: { email: 'Sylvia@pharmacy.test', firstName: 'Other', lastName: 'Name' },
      staff: [sylvia],
      emailOwner: sylvia,
    }), { action: 'use', uid: sylvia.uid });

    assert.deepEqual(choosePharmsmartAccount({
      organisationId,
      person: { email: 'someone.else@pharmacy.test', firstName: 'Sylvia', lastName: 'Hockett' },
      staff: [sylvia],
      emailOwner: null,
    }), { action: 'use', uid: sylvia.uid });
  });

  it('creates a new SSO account when the name is new and the details are complete', () => {
    assert.deepEqual(choosePharmsmartAccount({
      organisationId,
      person,
      staff: [sylvia],
      emailOwner: null,
    }), { action: 'create' });
  });

  it('asks for the missing person details instead of inventing an account', () => {
    assert.deepEqual(choosePharmsmartAccount({
      organisationId,
      person: { email: null, firstName: 'Amina', lastName: null },
      staff: [sylvia],
      emailOwner: null,
    }), { action: 'setup', missing: ['email'] });
  });

  it('does not take an email that already belongs to another organisation', () => {
    assert.deepEqual(choosePharmsmartAccount({
      organisationId,
      person,
      staff: [sylvia],
      emailOwner: { ...sylvia, uid: 'other-uid', organisationId: 'other-org' },
    }), { action: 'blocked', reason: 'EMAIL_IN_USE' });
  });

  it('signs a setup ticket that cannot be retargeted to another pharmacy', () => {
    const ticket = issuePharmsmartSetupTicket({
      organisationId,
      pharmsmartPharmacyId: '30',
      email: null,
      firstName: 'Amina',
      lastName: 'Khan',
    }, 'secret', 1_000);
    assert.deepEqual(readPharmsmartSetupTicket(ticket, 'secret', 1_000)?.organisationId, organisationId);
    assert.equal(readPharmsmartSetupTicket(`${ticket}x`, 'secret', 1_000), null);
    assert.equal(readPharmsmartSetupTicket(ticket, 'other-secret', 1_000), null);
  });
});

describe('pharmacy login account', () => {
  const organisationId = monivea.id;
  const owner = {
    uid: 'owner-uid',
    organisationId,
    role: 'PHARMACY_STAFF' as const,
    status: 'ACTIVE' as const,
    disabled: false,
    createdAt: '2026-02-01T00:00:00.000Z',
  };
  const earlier = { ...owner, uid: 'earlier-uid', createdAt: '2026-01-01T00:00:00.000Z' };

  it('uses the pharmacy owner account', () => {
    assert.deepEqual(pharmacyLoginAccount({
      organisationId,
      primaryContactUid: owner.uid,
      staff: [earlier, owner],
    }), { status: 'account', uid: owner.uid });
  });

  it('does not sign in an invited, disabled, or admin account', () => {
    assert.deepEqual(pharmacyLoginAccount({
      organisationId,
      staff: [
        { ...owner, status: 'INVITED' },
        { ...earlier, disabled: true },
        { ...owner, uid: 'admin-uid', role: 'HHH_ADMIN' },
      ],
    }), { status: 'unavailable' });
  });
});

describe('PharmSmart session proof', () => {
  it('accepts only a fresh custom token minted for this redemption', () => {
    const now = 1_700_000_000_000;
    assert.equal(isPharmsmartSsoSignIn({
      pharmsmartSso: true,
      auth_time: now / 1000,
      firebase: { sign_in_provider: 'custom' },
    }, now), true);
    assert.equal(isPharmsmartSsoSignIn({
      pharmsmartSso: true,
      auth_time: now / 1000,
      firebase: { sign_in_provider: 'password' },
    }, now), false);
    assert.equal(isPharmsmartSsoSignIn({
      auth_time: now / 1000,
      firebase: { sign_in_provider: 'custom' },
    }, now), false);
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
  it('does not turn the PharmSmart contact email into a second login', () => {
    const contract = pharmsmartSsoContract();
    assert.deepEqual(pharmacyStaffEmails({
      invitedEmails: ['Temp.User@pharmacy.test'],
      ssoEmail: 'pharmacist@pharmacy.test',
      ssoRedeemable: contract.redeemable,
    }), ['temp.user@pharmacy.test']);
  });
});
