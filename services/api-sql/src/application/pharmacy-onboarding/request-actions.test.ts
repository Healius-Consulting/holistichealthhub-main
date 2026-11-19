import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../../domain/common/errors.js';
import type { OnboardingHoldReason } from '../../domain/pharmacy-onboarding/content.js';
import type { PharmacyOnboardingRequestRecord, PharmacyOnboardingStatus } from '../../domain/pharmacy-onboarding/request.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import type { OnboardingEmails } from './onboarding-emails.js';
import { pharmacyRequestActions, type PharmacyRequestActionDeps } from './request-actions.js';

const id = '6c1c5a0e-1a1f-4f43-9d1b-6f7a6f3f0a11';
const BRANCH = '9d2f0b1c-2b3a-4c5d-8e6f-7a8b9c0d1e2f';

function request(status: PharmacyOnboardingStatus, organisationId: string | null = null): PharmacyOnboardingRequestRecord {
  return {
    id,
    status,
    pharmacistName: 'Asha Shah',
    pharmacyName: 'Shah Pharmacy',
    registeredCompanyName: 'Shah Health Ltd',
    invoiceAddress: '1 High Street, Leeds, LS1 1AA',
    deliveryAddress: '1 High Street, Leeds, LS1 1AA',
    gphcNumber: '1234567',
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
    organisationId,
    holdReason: status === 'ON_HOLD' ? 'MORE_INFORMATION_NEEDED' : null,
    heldAt: status === 'ON_HOLD' ? '2026-11-18T08:00:00.000Z' : null,
    decidedAt: null,
    decidedByUid: null,
    idempotencyKey: 'idempotency-key-1',
    createdAt: '2026-11-18T09:00:00.000Z',
  };
}

type Branch = Pick<OrganisationRecord, 'id' | 'status' | 'intakeEnabled' | 'archivedAt' | 'gphcNumber' | 'name'>;

function harness(status: PharmacyOnboardingStatus, branch?: Partial<Branch>, options: { emailsThrow?: boolean } = {}) {
  let row = request(status, branch ? BRANCH : null);
  const branches = new Map<string, Branch>();
  if (branch) branches.set(BRANCH, { id: BRANCH, status: 'ONBOARDING', intakeEnabled: true, archivedAt: null, gphcNumber: '1234567', name: 'Shah Pharmacy', ...branch });
  const sent: Array<{ kind: string; input: Record<string, unknown> }> = [];
  const clickup: Array<{ hook: string; input: Record<string, unknown> }> = [];
  const audits: Array<{ event: string; organisationId: string | null; recordId: string; details: Record<string, unknown> }> = [];
  const created: Array<{ id: string; intakeEnabled?: boolean }> = [];
  const writes: string[] = [];
  const revoked: string[] = [];
  const links: Array<[string, string]> = [];
  const fail = () => { if (options.emailsThrow) throw new Error('smtp down'); };
  const emails: OnboardingEmails = {
    applicationReceived: async input => { sent.push({ kind: 'applicationReceived', input }); },
    activated: async input => { sent.push({ kind: 'activated', input }); fail(); },
    held: async input => { sent.push({ kind: 'held', input }); fail(); },
    wentLive: async input => { sent.push({ kind: 'wentLive', input }); },
    resend: async input => { sent.push({ kind: 'resend', input }); },
  };
  const actions = pharmacyRequestActions({
    repo: {
      findById: async requested => (requested === row.id ? { ...row } : null),
      listOrganisationGphcNumbers: async () => [],
      activate: async (_id, organisationId, decidedAt, decidedByUid) => {
        writes.push('activate');
        row = { ...row, status: 'ACTIVATED', organisationId, decidedAt, decidedByUid };
      },
      hold: async (_id, reason, heldAt, decidedByUid) => {
        writes.push(`hold:${reason}`);
        row = { ...row, status: 'ON_HOLD', holdReason: reason, heldAt, decidedAt: heldAt, decidedByUid };
      },
      unhold: async (_id, next) => {
        writes.push(`unhold:${next}`);
        row = { ...row, status: next };
      },
      linkTermsAcceptances: async (requestId, organisationId) => { links.push([requestId, organisationId]); },
    },
    organisations: {
      createOrganisation: async (input: { id: string; intakeEnabled?: boolean }) => {
        created.push(input);
        branches.set(input.id, { id: input.id, status: 'ONBOARDING', intakeEnabled: true, archivedAt: null, gphcNumber: '1234567', name: 'Shah Pharmacy' });
      },
      findOrganisationById: async (organisationId: string) => branches.get(organisationId) ?? null,
      updateOrganisationStatus: async (organisationId: string, next: OrganisationRecord['status']) => {
        writes.push(`branch:${next}`);
        branches.set(organisationId, { ...branches.get(organisationId)!, status: next });
      },
      updateOrganisationIntakeEnabled: async (organisationId: string, enabled: boolean) => {
        writes.push(`intake:${enabled}`);
        branches.set(organisationId, { ...branches.get(organisationId)!, intakeEnabled: enabled });
      },
    } as unknown as PharmacyRequestActionDeps['organisations'],
    referralLinks: { ensureEligibilityLink: async () => ({ token: 'token-1' }) },
    revokeSessions: async organisationId => { revoked.push(organisationId); },
    audit: async input => { audits.push(input); },
    emails,
    clickup: {
      activated: async input => { clickup.push({ hook: 'activated', input: input as unknown as Record<string, unknown> }); },
      held: async input => { clickup.push({ hook: 'held', input }); },
      unheld: async input => { clickup.push({ hook: 'unheld', input }); },
    },
  });
  return {
    actions,
    sent,
    clickup,
    audits,
    created,
    writes,
    revoked,
    links,
    row: () => row,
    branch: (organisationId = BRANCH) => branches.get(organisationId),
  };
}

function refusedWith(code: string) {
  return (error: unknown) => error instanceof HttpError && error.statusCode === 409 && error.code === code;
}

const at = (iso: string) => new Date(iso);

describe('pharmacy request actions', () => {
  it('activates a pending request: creates the branch in demo mode, audits it and sends the Activation email once', async () => {
    const h = harness('PENDING');
    const result = await h.actions.activate({ id, actorUid: 'admin-1' });
    assert.equal(h.created.length, 1);
    assert.equal(result.request?.status, 'ACTIVATED');
    assert.deepEqual(h.audits.map(row => row.event), ['organisation.created', 'pharmacy_onboarding.activated']);
    assert.deepEqual(h.sent.map(row => row.kind), ['activated']);
    assert.equal(h.sent[0]!.input.organisationId, result.organisation.id);
    assert.equal((h.sent[0]!.input.request as PharmacyOnboardingRequestRecord).status, 'ACTIVATED');
    await assert.rejects(() => h.actions.activate({ id, actorUid: 'admin-1' }), refusedWith('ONBOARDING_REQUEST_DECIDED'));
    assert.equal(h.sent.length, 1);
    assert.equal(h.created.length, 1);
  });

  it('links the Partner Terms acceptance to the new branch at Activate, and nowhere else', async () => {
    const h = harness('PENDING');
    await h.actions.hold({ id, reason: 'MORE_INFORMATION_NEEDED', actorUid: 'admin-1' });
    await h.actions.unhold({ id });
    assert.deepEqual(h.links, []);
    const result = await h.actions.activate({ id, actorUid: 'admin-1' });
    assert.deepEqual(h.links, [[id, result.organisation.id]]);
  });

  it('opens the eligibility link at Activate, while the pharmacy awaits Curaleaf', async () => {
    const h = harness('PENDING');
    const result = await h.actions.activate({ id, actorUid: 'admin-1' });
    assert.equal(h.created[0]!.id, result.organisation.id);
    assert.equal(h.created[0]!.intakeEnabled, true);
    assert.equal(result.organisation.referralToken, 'token-1');
  });

  it('refuses to activate a request on hold until it is unheld', async () => {
    const h = harness('ON_HOLD');
    await assert.rejects(() => h.actions.activate({ id, actorUid: 'admin-1' }), refusedWith('ONBOARDING_REQUEST_ON_HOLD'));
    assert.deepEqual(h.created, []);
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.audits, []);
  });

  for (const reason of ['EXISTING_CURALEAF_CUSTOMER', 'MORE_INFORMATION_NEEDED', 'CURALEAF_DECLINED'] as const) {
    it(`holds a pending request for ${reason}: status and reason saved, audited, Hold email with the reason`, async () => {
      const h = harness('PENDING');
      const held = await h.actions.hold({ id, reason, actorUid: 'admin-1', now: at('2026-11-19T10:00:00.000Z') });
      assert.equal(held.status, 'ON_HOLD');
      assert.equal(h.row().holdReason, reason);
      assert.equal(h.row().heldAt, '2026-11-19T10:00:00.000Z');
      assert.equal(h.row().decidedByUid, 'admin-1');
      assert.deepEqual(h.audits.map(row => [row.event, row.organisationId, row.details.reason]), [['pharmacy_onboarding.held', null, reason]]);
      assert.deepEqual(h.sent.map(row => [row.kind, row.input.reason, row.input.heldAt]), [['held', reason, '2026-11-19T10:00:00.000Z']]);
      // No branch yet: nothing else is touched.
      assert.deepEqual(h.writes, [`hold:${reason}`]);
      assert.deepEqual(h.revoked, []);
    });
  }

  it('rejects a reason outside the fixed list', async () => {
    const h = harness('PENDING');
    await assert.rejects(
      () => h.actions.hold({ id, reason: 'Some free text' as OnboardingHoldReason, actorUid: 'admin-1' }),
      (error: unknown) => error instanceof HttpError && error.statusCode === 400 && error.code === 'INVALID_INPUT',
    );
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.sent, []);
  });

  for (const status of ['ONBOARDING', 'INTAKE_LIVE'] as const) {
    it(`holds an activated branch that is not live yet (${status}): branch ON_HOLD, intake off, staff signed out`, async () => {
      const h = harness('ACTIVATED', { status });
      const held = await h.actions.hold({ id, reason: 'CURALEAF_DECLINED', actorUid: 'admin-1', now: at('2026-11-19T10:00:00.000Z') });
      assert.equal(held.status, 'ON_HOLD');
      assert.equal(held.organisationId, BRANCH);
      assert.equal(h.branch()?.status, 'ON_HOLD');
      assert.equal(h.branch()?.intakeEnabled, false);
      assert.deepEqual(h.revoked, [BRANCH]);
      assert.deepEqual(h.writes, ['branch:ON_HOLD', 'intake:false', 'hold:CURALEAF_DECLINED']);
      assert.deepEqual(h.audits.map(row => [row.event, row.organisationId]), [['pharmacy_onboarding.held', BRANCH]]);
      assert.deepEqual(h.sent.map(row => row.kind), ['held']);
    });
  }

  for (const status of ['LIVE', 'PAUSED'] as const) {
    it(`refuses to hold a branch that is ${status}`, async () => {
      const h = harness('ACTIVATED', { status });
      await assert.rejects(() => h.actions.hold({ id, reason: 'CURALEAF_DECLINED', actorUid: 'admin-1' }), refusedWith('ONBOARDING_BRANCH_LIVE'));
      assert.deepEqual(h.writes, []);
      assert.deepEqual(h.revoked, []);
      assert.deepEqual(h.sent, []);
      assert.deepEqual(h.audits, []);
      assert.deepEqual(h.clickup, []);
    });
  }

  it('changes the reason of a hold: saved, audited as a change, and the Hold email sent again', async () => {
    const h = harness('PENDING');
    await h.actions.hold({ id, reason: 'MORE_INFORMATION_NEEDED', actorUid: 'admin-1', now: at('2026-11-19T10:00:00.000Z') });
    await h.actions.hold({ id, reason: 'EXISTING_CURALEAF_CUSTOMER', actorUid: 'admin-2', now: at('2026-11-20T10:00:00.000Z') });
    assert.equal(h.row().holdReason, 'EXISTING_CURALEAF_CUSTOMER');
    assert.equal(h.row().heldAt, '2026-11-20T10:00:00.000Z');
    assert.deepEqual(h.audits.map(row => [row.event, row.details.reason, row.details.previousReason]), [
      ['pharmacy_onboarding.held', 'MORE_INFORMATION_NEEDED', undefined],
      ['pharmacy_onboarding.hold_reason_changed', 'EXISTING_CURALEAF_CUSTOMER', 'MORE_INFORMATION_NEEDED'],
    ]);
    assert.deepEqual(h.sent.map(row => [row.kind, row.input.reason]), [
      ['held', 'MORE_INFORMATION_NEEDED'],
      ['held', 'EXISTING_CURALEAF_CUSTOMER'],
    ]);
    assert.deepEqual(h.clickup.map(row => [row.hook, row.input.reason, row.input.previousReason]), [
      ['held', 'MORE_INFORMATION_NEEDED', null],
      ['held', 'EXISTING_CURALEAF_CUSTOMER', 'MORE_INFORMATION_NEEDED'],
    ]);
  });

  it('refuses the same reason again: already on hold for that reason, nothing sent', async () => {
    const h = harness('ON_HOLD');
    await assert.rejects(
      () => h.actions.hold({ id, reason: 'MORE_INFORMATION_NEEDED', actorUid: 'admin-1' }),
      refusedWith('ONBOARDING_REQUEST_ALREADY_ON_HOLD'),
    );
    assert.deepEqual(h.writes, []);
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.clickup, []);
  });

  it('changes the reason of a held branch without touching it again', async () => {
    const h = harness('ACTIVATED', { status: 'ONBOARDING' });
    await h.actions.hold({ id, reason: 'MORE_INFORMATION_NEEDED', actorUid: 'admin-1' });
    h.writes.length = 0;
    await h.actions.hold({ id, reason: 'CURALEAF_DECLINED', actorUid: 'admin-1' });
    assert.deepEqual(h.writes, ['hold:CURALEAF_DECLINED']);
    assert.equal(h.branch()?.status, 'ON_HOLD');
    assert.deepEqual(h.sent.map(row => row.kind), ['held', 'held']);
  });

  it('unholds a pending request back to PENDING with no email, keeping the reason as history', async () => {
    const h = harness('ON_HOLD');
    const unheld = await h.actions.unhold({ id });
    assert.equal(unheld.status, 'PENDING');
    assert.equal(h.row().status, 'PENDING');
    assert.equal(h.row().holdReason, 'MORE_INFORMATION_NEEDED');
    assert.deepEqual(h.writes, ['unhold:PENDING']);
    assert.deepEqual(h.audits.map(row => row.event), ['pharmacy_onboarding.unheld']);
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.clickup.map(row => [row.hook, row.input.organisationId]), [['unheld', null]]);
  });

  it('unholds an activated branch back to ACTIVATED and ONBOARDING with intake restored, and sends nothing', async () => {
    const h = harness('ACTIVATED', { status: 'INTAKE_LIVE' });
    await h.actions.hold({ id, reason: 'EXISTING_CURALEAF_CUSTOMER', actorUid: 'admin-1' });
    h.sent.length = 0;
    h.writes.length = 0;
    const unheld = await h.actions.unhold({ id });
    assert.equal(unheld.status, 'ACTIVATED');
    assert.equal(h.row().status, 'ACTIVATED');
    assert.equal(h.branch()?.status, 'ONBOARDING');
    assert.equal(h.branch()?.intakeEnabled, true);
    assert.deepEqual(h.writes, ['branch:ONBOARDING', 'intake:true', 'unhold:ACTIVATED']);
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.audits.at(-1)?.event, 'pharmacy_onboarding.unheld');
    assert.deepEqual(h.clickup.at(-1), { hook: 'unheld', input: { id, gphcNumber: '1234567', organisationId: BRANCH } });
  });

  it('lifts a branch left on hold by a half-written hold (request still ACTIVATED)', async () => {
    const h = harness('ACTIVATED', { status: 'ON_HOLD', intakeEnabled: false });
    const unheld = await h.actions.unhold({ id });
    assert.equal(unheld.status, 'ACTIVATED');
    assert.equal(h.branch()?.status, 'ONBOARDING');
    assert.deepEqual(h.writes, ['branch:ONBOARDING', 'intake:true']);
  });

  it('refuses to unhold a request that is pending, or activated with a branch not on hold', async () => {
    for (const h of [harness('PENDING'), harness('ACTIVATED', { status: 'ONBOARDING' })]) {
      await assert.rejects(() => h.actions.unhold({ id }), refusedWith('ONBOARDING_REQUEST_NOT_ON_HOLD'));
      assert.deepEqual(h.writes, []);
      assert.deepEqual(h.audits, []);
    }
  });

  it('runs hold, unhold, then activate: one Hold email, one Activation email, none on unhold', async () => {
    const h = harness('PENDING');
    await h.actions.hold({ id, reason: 'MORE_INFORMATION_NEEDED', actorUid: 'admin-1' });
    await h.actions.unhold({ id });
    await h.actions.activate({ id, actorUid: 'admin-1' });
    assert.deepEqual(h.sent.map(row => row.kind), ['held', 'activated']);
    assert.deepEqual(h.audits.map(row => row.event), [
      'pharmacy_onboarding.held',
      'pharmacy_onboarding.unheld',
      'organisation.created',
      'pharmacy_onboarding.activated',
    ]);
  });

  it('keeps the state change when an email throws', async () => {
    const h = harness('PENDING', undefined, { emailsThrow: true });
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const held = await h.actions.hold({ id, reason: 'CURALEAF_DECLINED', actorUid: 'admin-1' });
      assert.equal(held.status, 'ON_HOLD');
      assert.deepEqual(h.clickup.map(row => row.hook), ['held']);
      await h.actions.unhold({ id });
      const activated = await h.actions.activate({ id, actorUid: 'admin-1' });
      assert.equal(activated.request?.status, 'ACTIVATED');
    } finally {
      console.error = originalError;
    }
  });

  it('reports a missing request as not found', async () => {
    const h = harness('PENDING');
    const other = '7c1c5a0e-1a1f-4f43-9d1b-6f7a6f3f0a11';
    for (const run of [
      () => h.actions.activate({ id: other, actorUid: 'a' }),
      () => h.actions.hold({ id: other, reason: 'CURALEAF_DECLINED', actorUid: 'a' }),
      () => h.actions.unhold({ id: other }),
    ]) {
      await assert.rejects(run, (error: unknown) => error instanceof HttpError && error.statusCode === 404);
    }
  });
});
