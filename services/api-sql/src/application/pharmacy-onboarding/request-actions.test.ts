import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../../domain/common/errors.js';
import type { PharmacyOnboardingRequestRecord, PharmacyOnboardingStatus } from '../../domain/pharmacy-onboarding/request.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import { renderEmailTemplate, type EmailTemplateCode } from '../notifications/email-catalog.js';
import { pharmacyRequestActions, type PharmacyRequestActionDeps } from './request-actions.js';

const REASON = 'GPhC premises check failed: address does not match the register.';

function request(status: PharmacyOnboardingStatus): PharmacyOnboardingRequestRecord {
  return {
    id: '6c1c5a0e-1a1f-4f43-9d1b-6f7a6f3f0a11',
    status,
    pharmacistName: 'Asha Shah',
    pharmacyName: 'Shah Pharmacy',
    registeredCompanyName: 'Shah Health Ltd',
    invoiceAddress: '1 High Street, Leeds, LS1 1AA',
    deliveryAddress: '1 High Street, Leeds, LS1 1AA',
    gphcNumber: '1234567',
    wdaNumber: '',
    licenceDetails: '',
    pharmacyEmail: 'shop@shah.test',
    accountsEmail: 'accounts@shah.test',
    pharmacyPhone: '0113 000 0000',
    accountsPhone: '0113 000 0001',
    faxNumber: null,
    signatureName: 'Asha Shah',
    signedOn: '2026-11-18',
    licenceStoragePath: '',
    licenceContentType: '',
    licenceFilename: '',
    filledFormStoragePath: 'pharmacy-onboarding/6c1c/curaleaf-account.pdf',
    organisationId: null,
    declineReason: status === 'ON_HOLD' ? REASON : null,
    decidedAt: null,
    decidedByUid: null,
    idempotencyKey: 'idempotency-key-1',
    createdAt: '2026-11-18T09:00:00.000Z',
  };
}

type Enqueued = { templateCode: EmailTemplateCode; encryptedRecipient: string; payload: Record<string, unknown>; idempotencyKey: string };

function harness(status: PharmacyOnboardingStatus) {
  let row = request(status);
  const emails: Enqueued[] = [];
  const audits: Array<{ event: string; recordId: string; details: Record<string, unknown> }> = [];
  const organisations: string[] = [];
  const created: Array<{ id: string; intakeEnabled?: boolean }> = [];
  const writes: string[] = [];
  const links: Array<[string, string]> = [];
  const keys = new Set<string>();
  const notificationRepo = {
    async enqueue(data: Enqueued) {
      if (keys.has(data.idempotencyKey)) return { created: false };
      keys.add(data.idempotencyKey);
      emails.push(data);
      return { created: true };
    },
  } as unknown as NotificationRepositoryPort;
  const actions = pharmacyRequestActions({
    repo: {
      findById: async id => (id === row.id ? { ...row } : null),
      listOrganisationGphcNumbers: async () => [],
      activate: async (_id, organisationId, decidedAt, decidedByUid) => {
        writes.push('activate');
        row = { ...row, status: 'ACTIVATED', organisationId, decidedAt, decidedByUid };
      },
      hold: async (_id, reason, decidedAt, decidedByUid) => {
        writes.push('hold');
        row = { ...row, status: 'ON_HOLD', declineReason: reason, decidedAt, decidedByUid };
      },
      unhold: async () => {
        writes.push('unhold');
        row = { ...row, status: 'PENDING' };
      },
      linkTermsAcceptances: async (requestId, organisationId) => { links.push([requestId, organisationId]); },
    },
    organisations: {
      createOrganisation: async (input: { id: string; intakeEnabled?: boolean }) => {
        organisations.push(input.id);
        created.push(input);
      },
    } as unknown as PharmacyRequestActionDeps['organisations'],
    referralLinks: { ensureEligibilityLink: async () => ({ token: 'token-1' }) },
    notificationRepo,
    audit: async input => { audits.push(input); },
  });
  return { actions, emails, audits, organisations, created, writes, links, row: () => row };
}

const id = '6c1c5a0e-1a1f-4f43-9d1b-6f7a6f3f0a11';

function refusedWith(code: string) {
  return (error: unknown) => error instanceof HttpError && error.statusCode === 409 && error.code === code;
}

describe('pharmacy request actions', () => {
  it('activates a pending request: creates the pharmacy, audits it and emails the pharmacy once', async () => {
    const h = harness('PENDING');
    const result = await h.actions.activate({ id, actorUid: 'admin-1' });
    assert.equal(h.organisations.length, 1);
    assert.equal(result.request?.status, 'ACTIVATED');
    assert.deepEqual(h.audits.map(row => row.event), ['organisation.created', 'pharmacy_onboarding.activated']);
    assert.deepEqual(h.emails.map(row => [row.templateCode, row.encryptedRecipient]), [['pharmacy_onboarding_activated', 'shop@shah.test']]);
    await assert.rejects(() => h.actions.activate({ id, actorUid: 'admin-1' }), refusedWith('ONBOARDING_REQUEST_DECIDED'));
    assert.equal(h.emails.length, 1);
    assert.equal(h.organisations.length, 1);
  });

  it('links the Partner Terms acceptance to the new branch at Activate, and nowhere else', async () => {
    const h = harness('PENDING');
    await h.actions.hold({ id, reason: REASON, actorUid: 'admin-1' });
    await h.actions.unhold({ id });
    assert.deepEqual(h.links, []);
    const result = await h.actions.activate({ id, actorUid: 'admin-1' });
    assert.deepEqual(h.links, [[id, result.organisation.id]]);
  });

  it('opens the eligibility link at Activate, while the pharmacy awaits Curaleaf', async () => {
    const h = harness('PENDING');
    const result = await h.actions.activate({ id, actorUid: 'admin-1' });
    assert.equal(h.created.length, 1);
    assert.equal(h.created[0]!.id, result.organisation.id);
    assert.equal(h.created[0]!.intakeEnabled, true);
    assert.equal(result.organisation.referralToken, 'token-1');
  });

  it('refuses to activate a request on hold until it is unheld', async () => {
    const h = harness('ON_HOLD');
    await assert.rejects(() => h.actions.activate({ id, actorUid: 'admin-1' }), refusedWith('ONBOARDING_REQUEST_ON_HOLD'));
    assert.deepEqual(h.organisations, []);
    assert.deepEqual(h.emails, []);
    assert.deepEqual(h.audits, []);
  });

  it('holds a pending request with an admin-only reason and emails the pharmacy without it', async () => {
    const h = harness('PENDING');
    const held = await h.actions.hold({ id, reason: `  ${REASON}  `, actorUid: 'admin-1', now: new Date('2026-11-18T10:00:00.000Z') });
    assert.equal(held.status, 'ON_HOLD');
    assert.equal(h.row().declineReason, REASON);
    assert.equal(h.row().decidedByUid, 'admin-1');
    assert.deepEqual(h.audits.map(row => row.event), ['pharmacy_onboarding.held']);
    assert.equal(JSON.stringify(h.audits).includes(REASON), false);
    assert.deepEqual(h.emails.map(row => row.templateCode), ['pharmacy_onboarding_held']);
    const email = h.emails[0]!;
    assert.equal(JSON.stringify(email.payload).includes(REASON), false);
    const rendered = renderEmailTemplate(email.templateCode, email.payload);
    for (const part of [rendered.subject, rendered.text, rendered.html]) {
      assert.equal(part.includes(REASON), false);
      assert.equal(part.includes('address does not match'), false);
    }
    assert.deepEqual(h.organisations, []);
  });

  it('requires a hold reason of 2 to 500 characters', async () => {
    for (const reason of ['', ' ', 'x', ' y ', 'z'.repeat(501)]) {
      const h = harness('PENDING');
      await assert.rejects(
        () => h.actions.hold({ id, reason, actorUid: 'admin-1' }),
        (error: unknown) => error instanceof HttpError && error.statusCode === 400 && error.code === 'INVALID_INPUT',
      );
      assert.deepEqual(h.writes, []);
      assert.deepEqual(h.emails, []);
    }
  });

  it('refuses to hold a request that is on hold or activated', async () => {
    const onHold = harness('ON_HOLD');
    await assert.rejects(() => onHold.actions.hold({ id, reason: 'Again', actorUid: 'admin-1' }), refusedWith('ONBOARDING_REQUEST_ON_HOLD'));
    const activated = harness('ACTIVATED');
    await assert.rejects(() => activated.actions.hold({ id, reason: 'Too late', actorUid: 'admin-1' }), refusedWith('ONBOARDING_REQUEST_DECIDED'));
    assert.deepEqual([...onHold.writes, ...activated.writes], []);
    assert.deepEqual([...onHold.emails, ...activated.emails], []);
  });

  it('unholds a request back to pending with no email, keeping the reason', async () => {
    const h = harness('ON_HOLD');
    const unheld = await h.actions.unhold({ id });
    assert.equal(unheld.status, 'PENDING');
    assert.equal(h.row().status, 'PENDING');
    assert.equal(h.row().declineReason, REASON);
    assert.deepEqual(h.audits.map(row => row.event), ['pharmacy_onboarding.unheld']);
    assert.deepEqual(h.emails, []);
  });

  it('refuses to unhold a request that is pending or activated', async () => {
    for (const status of ['PENDING', 'ACTIVATED'] as const) {
      const h = harness(status);
      await assert.rejects(() => h.actions.unhold({ id }), refusedWith('ONBOARDING_REQUEST_NOT_ON_HOLD'));
      assert.deepEqual(h.writes, []);
      assert.deepEqual(h.audits, []);
    }
  });

  it('runs hold, unhold, then activate: one held email, one activated email, none on unhold', async () => {
    const h = harness('PENDING');
    await h.actions.hold({ id, reason: REASON, actorUid: 'admin-1' });
    await h.actions.unhold({ id });
    await h.actions.activate({ id, actorUid: 'admin-1' });
    assert.deepEqual(h.emails.map(row => row.templateCode), ['pharmacy_onboarding_held', 'pharmacy_onboarding_activated']);
    assert.deepEqual(h.audits.map(row => row.event), [
      'pharmacy_onboarding.held',
      'pharmacy_onboarding.unheld',
      'organisation.created',
      'pharmacy_onboarding.activated',
    ]);
  });

  it('reports a missing request as not found', async () => {
    const h = harness('PENDING');
    const other = '7c1c5a0e-1a1f-4f43-9d1b-6f7a6f3f0a11';
    for (const run of [
      () => h.actions.activate({ id: other, actorUid: 'a' }),
      () => h.actions.hold({ id: other, reason: 'Reason', actorUid: 'a' }),
      () => h.actions.unhold({ id: other }),
    ]) {
      await assert.rejects(run, (error: unknown) => error instanceof HttpError && error.statusCode === 404);
    }
  });
});
