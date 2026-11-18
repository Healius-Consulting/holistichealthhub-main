import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StaffUserRecord } from '../../repositories/ports/identity.port.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import { pharmacyEmailContext, pharmacyOwnerRecipients, queueSharedEmail } from './email-outbox.js';

const organisationId = '70913a30-71c3-4a41-952e-d532927af58c';

const owner: StaffUserRecord = {
  uid: 'owner-uid',
  organisationId,
  email: 'owner@example.test',
  displayName: 'Alex Owner',
  role: 'PHARMACY_STAFF',
  status: 'ACTIVE',
  disabled: false,
  createdAt: '2026-01-01T10:00:00.000Z',
  version: 1,
};

const staffMember: StaffUserRecord = {
  uid: 'staff-uid',
  organisationId,
  email: 'staff@example.test',
  displayName: 'Sam Staff',
  role: 'PHARMACY_STAFF',
  status: 'ACTIVE',
  disabled: false,
  createdAt: '2026-01-02T10:00:00.000Z',
  version: 1,
};

const organisation = {
  mainContactEmail: 'desk@example.test',
  mainContactName: 'Pharmacy desk',
} as OrganisationRecord;

describe('pharmacy operational email recipients', () => {
  it('uses the pharmacy inbox ahead of any staff login, including an SSO user', () => {
    const ssoUser = { ...staffMember, uid: 'sso-uid', email: 'amina@pharmsmart.test', displayName: 'Amina Khan' };
    assert.deepEqual(pharmacyOwnerRecipients([staffMember, owner, ssoUser], {
      ...organisation,
      pharmacyEmail: 'pharmacy@eastwood.test',
      primaryContactUid: staffMember.uid,
    }), [
      { email: 'pharmacy@eastwood.test', displayName: null },
    ]);
  });

  it('uses the superintendent when the pharmacy inbox is blank', () => {
    assert.deepEqual(pharmacyOwnerRecipients([owner], organisation), [
      { email: 'desk@example.test', displayName: 'Pharmacy desk' },
    ]);
  });
});


it('the pharmacy email reaches patients only when the pharmacy chose to show it; the phone always does', () => {
  const pharmacy = { id: 'org-1', name: 'Eastwood', pharmacyPhone: '01522 000 000', pharmacyEmail: 'shop@eastwood.example', mainContactEmail: 'super@eastwood.example' } as never;
  assert.equal(pharmacyEmailContext(pharmacy).pharmacyPublicEmail, '');
  assert.equal(pharmacyEmailContext(pharmacy).pharmacyPhone, '01522 000 000');
  assert.equal(pharmacyEmailContext({ ...(pharmacy as object), showEmailToPatients: true } as never).pharmacyPublicEmail, 'shop@eastwood.example');
  // The superintendent's own address is never shown in its place.
  assert.equal(pharmacyEmailContext({ ...(pharmacy as object), pharmacyEmail: '', showEmailToPatients: true } as never).pharmacyPublicEmail, '');
});

describe('queueSharedEmail', () => {
  it('writes one row naming every To and CC address, under one key', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const repo = {
      enqueue: async (data: Record<string, unknown>) => {
        if (rows.some(row => row.idempotencyKey === data.idempotencyKey)) return { created: false };
        rows.push(data);
        return { created: true };
      },
    } as unknown as Parameters<typeof queueSharedEmail>[0];
    const input = {
      to: ['A@Curaleaf.test', 'b@curaleaf.test', 'a@curaleaf.test'],
      cc: ['copy@hhh.test', 'b@curaleaf.test'],
      templateCode: 'curaleaf_new_account_application' as const,
      payload: { branchName: 'Eastwood Health' },
      keyParts: ['curaleaf-new-account-application', 'req-1'],
    };
    assert.deepEqual(await queueSharedEmail(repo, input), { queued: true });
    assert.deepEqual(await queueSharedEmail(repo, input), { queued: false });
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]!.toRecipients, ['a@curaleaf.test', 'b@curaleaf.test']);
    assert.deepEqual(rows[0]!.ccRecipients, ['copy@hhh.test']);
    assert.equal(rows[0]!.encryptedRecipient, 'a@curaleaf.test');
    assert.equal(rows[0]!.idempotencyKey, 'curaleaf-new-account-application:req-1');
  });
});
