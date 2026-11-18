import { test } from 'node:test';
import assert from 'node:assert/strict';
import { declineNewPharmacy, type DeclinePharmacyDeps } from './decline-pharmacy.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import type { PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';

function deps(organisation: Partial<OrganisationRecord> | null, request: Partial<PharmacyOnboardingRequestRecord> | null = null) {
  const calls: string[] = [];
  const emails: Array<{ email: string; reason: string }> = [];
  const d: DeclinePharmacyDeps = {
    findOrganisation: async () => (organisation ? { id: 'org-1', name: 'Shah Pharmacy', status: 'ONBOARDING', pharmacyEmail: 'shop@shah.test', mainContactEmail: null, archivedAt: null, ...organisation } as OrganisationRecord : null),
    findRequestByOrganisation: async () => (request ? { id: 'req-1', pharmacyName: 'Shah Pharmacy', pharmacyEmail: 'form@shah.test', ...request } as PharmacyOnboardingRequestRecord : null),
    archiveOrganisation: async (id, reason) => { calls.push(`archive:${id}:${reason}`); },
    holdRequest: async id => { calls.push(`hold:${id}`); },
    emailPharmacy: async input => { emails.push(input); },
  };
  return { d, calls, emails };
}

test('archives a new pharmacy, holds its request and emails the form address', async () => {
  const { d, calls, emails } = deps({}, {});
  await declineNewPharmacy(d, { organisationId: 'org-1', reason: 'Curaleaf rejected the account.', actorUid: 'admin-1' });
  assert.deepEqual(calls, ['archive:org-1:Curaleaf rejected the account.', 'hold:req-1']);
  assert.deepEqual(emails.map(email => email.email), ['form@shah.test']);
});

test('declines a pharmacy with no request and emails its own inbox', async () => {
  const { d, calls, emails } = deps({});
  await declineNewPharmacy(d, { organisationId: 'org-1', reason: 'Duplicate account.', actorUid: 'admin-1' });
  assert.deepEqual(calls, ['archive:org-1:Duplicate account.']);
  assert.deepEqual(emails.map(email => email.email), ['shop@shah.test']);
});

test('never declines a live pharmacy, an unknown one, or without a reason', async () => {
  await assert.rejects(declineNewPharmacy(deps({ status: 'LIVE' }).d, { organisationId: 'org-1', reason: 'No', actorUid: 'a' }), /Pause it instead/);
  await assert.rejects(declineNewPharmacy(deps(null).d, { organisationId: 'org-1', reason: 'Gone away', actorUid: 'a' }), /not found/);
  await assert.rejects(declineNewPharmacy(deps({}).d, { organisationId: 'org-1', reason: ' ', actorUid: 'a' }), /reason/);
});
