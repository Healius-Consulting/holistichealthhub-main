import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GoLiveChecklistView } from '../../domain/organisation/go-live-checklist.js';
import { ONBOARDING_CONTENT_KEYS } from '../../domain/pharmacy-onboarding/content.js';
import type { PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';
import type { PartnerTermsAcceptanceRecord } from '../../domain/pharmacy-onboarding/terms.js';
import type { IntegrationConnectionRecord } from '../../repositories/ports/integration.port.js';
import type { NotificationOutboxRecord } from '../../repositories/ports/notification.port.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import type { WorldpayApplicationRecord, WorldpayApplicationStatus } from '../../repositories/ports/worldpay-application.port.js';
import { renderEmailTemplate, senderFor } from '../notifications/email-catalog.js';
import { FILLED_FORM_NAME_KEY, FILLED_FORM_PATH_KEY, LICENCE_PATH_KEY } from './emails.js';
import {
  createOnboardingEmails,
  curaleafFormFilename,
  onboardingEmailLog,
  type OnboardingEmailsDeps,
} from './onboarding-emails.service.js';

const REQUEST_ID = '6c1c5a0e-1a1f-4f43-9d1b-6f7a6f3f0a11';
const ORG_ID = '0b5e3c2a-7d44-4f1e-9a0c-2c7d9e1f4b22';
const API_KEY = 'sk_live_curaleaf_SECRET_123';
const NOW = new Date('2026-11-19T14:30:00.000Z');

function request(overrides: Partial<PharmacyOnboardingRequestRecord> = {}): PharmacyOnboardingRequestRecord {
  return {
    id: REQUEST_ID,
    status: 'PENDING',
    pharmacistName: 'Asha Shah',
    pharmacyName: 'Shah Pharmacy / Leeds',
    registeredCompanyName: 'SHAH HEALTH LIMITED',
    invoiceAddress: '1 High Street, Leeds',
    deliveryAddress: '1 High Street, Leeds',
    gphcNumber: '1234567',
    pharmacyEmail: 'Shop@Shah.test',
    accountsEmail: 'accounts@shah.test',
    pharmacyPhone: '0113 000 0000',
    accountsPhone: '0113 000 0001',
    faxNumber: null,
    signatureName: 'Asha Shah',
    signedOn: '2026-11-19',
    licenceStoragePath: 'pharmacy-onboarding/6c1c/licence.pdf',
    licenceContentType: 'application/pdf',
    licenceFilename: 'cd-licence.pdf',
    filledFormStoragePath: 'pharmacy-onboarding/6c1c/curaleaf-account.pdf',
    organisationId: null,
    holdReason: null,
    heldAt: null,
    decidedAt: null,
    decidedByUid: null,
    idempotencyKey: 'idem-123456',
    // 14:05 in London on 19 November (GMT).
    createdAt: '2026-11-19T14:05:00.000Z',
    ...overrides,
  } as PharmacyOnboardingRequestRecord;
}

function acceptance(overrides: Partial<PartnerTermsAcceptanceRecord> = {}): PartnerTermsAcceptanceRecord {
  return {
    id: 'acc-1',
    onboardingRequestId: REQUEST_ID,
    organisationId: null,
    termsVersion: 'v1.0',
    signerName: 'Priya  Patel',
    signerRole: 'SUPERINTENDENT',
    signerRoleOther: null,
    signerEmail: 'priya@shah.test',
    signerGphcNumber: '2222222',
    registeredCompanyName: 'SHAH HEALTH LIMITED',
    acceptedAt: '2026-11-19T14:20:00.000Z',
    ipAddress: 'hash',
    source: 'signup',
    nameMatchesPharmsmart: true,
    ...overrides,
  };
}

function organisation(overrides: Partial<OrganisationRecord> = {}): OrganisationRecord {
  return {
    id: ORG_ID,
    name: 'Shah Pharmacy Leeds',
    gphcNumber: '1234567',
    mainContactName: 'Asha Shah',
    mainContactEmail: 'asha@shah.test',
    pharmacyEmail: 'branch@shah.test',
    status: 'LIVE',
    ...overrides,
  } as OrganisationRecord;
}

function checklist(open: Array<{ key: string; section: 'required' | 'optional'; label: string }>): GoLiveChecklistView {
  const items = [
    { key: 'platform_live', section: 'required' as const, label: 'Curaleaf PHAR code and API key entered, platform live' },
    { key: 'partner_terms_accepted', section: 'required' as const, label: 'Partner Terms accepted' },
    { key: 'sops_approved', section: 'required' as const, label: 'SOPs approved by the superintendent' },
    { key: 'formulary_uploaded', section: 'required' as const, label: 'Formulary uploaded to PMR' },
    { key: 'staff_training', section: 'optional' as const, label: 'Staff training completed' },
    { key: 'posters_leaflets', section: 'optional' as const, label: 'Posters/leaflets created and printed' },
  ].map(item => ({
    ...item,
    group: 'x',
    detail: null,
    owners: [],
    kind: 'self',
    link: null,
    // platform_live reads as open here: the email must still never list it.
    done: item.key === 'platform_live' ? false : !open.some(o => o.key === item.key),
    doneAt: null,
    tickedByUid: null,
    tickedAt: null,
  }));
  return { organisationId: ORG_ID, items, sections: [], percent: 0, requiredComplete: false, complete: false } as unknown as GoLiveChecklistView;
}

type Row = Parameters<OnboardingEmailsDeps['notifications']['enqueue']>[0];

function harness(options: {
  request?: PharmacyOnboardingRequestRecord;
  acceptances?: PartnerTermsAcceptanceRecord[];
  orgAcceptances?: PartnerTermsAcceptanceRecord[];
  content?: Record<string, unknown>;
  worldpay?: WorldpayApplicationStatus | null;
  worldpayValidated?: boolean;
  organisation?: OrganisationRecord | null;
  requestForOrg?: PharmacyOnboardingRequestRecord | null;
  checklist?: GoLiveChecklistView;
  demo?: boolean;
  failEnqueue?: boolean;
  failContent?: boolean;
  termsRequired?: boolean;
} = {}) {
  const rows: Row[] = [];
  const warnings: string[] = [];
  let clock = NOW.getTime();
  const req = options.request ?? request();
  const worldpayRecord = options.worldpay ? { status: options.worldpay } as WorldpayApplicationRecord : null;
  const connections: Record<string, IntegrationConnectionRecord> = {
    CURALEAF: {
      id: 'c1', organisationId: ORG_ID, integration: 'CURALEAF', environment: 'PRODUCTION', status: 'ACTIVE',
      secretResourceName: `projects/x/secrets/${API_KEY}`, externalCustomerId: 'PHAR01234', maskedCredential: `****${API_KEY.slice(-4)}`,
      validatedAt: NOW.toISOString(), lastSuccessfulAt: NOW.toISOString(), lastErrorCode: null, version: 1, createdAt: '', updatedAt: '',
    },
    WORLDPAY: {
      id: 'w1', organisationId: ORG_ID, integration: 'WORLDPAY', environment: 'PRODUCTION',
      status: options.worldpayValidated ? 'ACTIVE' : 'PENDING_VALIDATION',
      secretResourceName: 'projects/x/secrets/worldpay', externalCustomerId: 'entity', maskedCredential: null,
      validatedAt: options.worldpayValidated ? NOW.toISOString() : null, lastSuccessfulAt: null, lastErrorCode: null, version: 1, createdAt: '', updatedAt: '',
    },
  };
  const deps: OnboardingEmailsDeps = {
    notifications: {
      async findByIdempotencyKey(key) {
        return (rows.find(row => row.idempotencyKey === key) as unknown as NotificationOutboxRecord) ?? null;
      },
      async enqueue(data) {
        if (options.failEnqueue) throw new Error('database unavailable');
        if (rows.some(row => row.idempotencyKey === data.idempotencyKey)) return { created: false };
        rows.push(data);
        return { id: `row-${rows.length}`, created: true };
      },
    },
    content: {
      async read() {
        if (options.failContent) throw new Error('content unavailable');
        return options.content ?? {};
      },
    },
    requests: {
      findById: async id => (id === req.id ? req : null),
      findByOrganisationId: async () => (options.requestForOrg === undefined ? req : options.requestForOrg),
      findTermsAcceptances: async () => options.acceptances ?? [acceptance()],
      findTermsAcceptancesForOrganisation: async () => options.orgAcceptances ?? [],
    },
    findOrganisation: async () => (options.organisation === undefined ? organisation() : options.organisation),
    worldpayApplications: {
      findForRequest: async () => worldpayRecord,
      findForOrganisation: async () => null,
    },
    findConnection: async (_id, integration) => connections[integration] ?? null,
    goLiveChecklist: async () => options.checklist ?? checklist([]),
    isDemoGphc: async () => Boolean(options.demo),
    termsRequired: async () => Boolean(options.termsRequired),
    curaleafRecipients: () => ({ to: ['new@curaleaf.test', 'second@curaleaf.test'], cc: ['spatel@healiusconsulting.com'] }),
    now: () => new Date(clock),
    warn: message => { warnings.push(message); },
  };
  return { rows, warnings, emails: createOnboardingEmails(deps), tick: () => { clock += 60_000; } };
}

const text = (row: Row | undefined) => {
  const payload = row!.payload as { paragraphs: string[] };
  return payload.paragraphs.join('\n\n');
};
const byTemplate = (rows: Row[], code: string) => rows.filter(row => row.templateCode === code);

describe('onboarding emails: Sent and the application to Curaleaf', () => {
  it('sends one Sent email when the signer and the branch share an address', async () => {
    const h = harness({ acceptances: [acceptance({ signerEmail: 'SHOP@shah.test' })] });
    await h.emails.applicationReceived({ request: request(), demo: false });
    const sent = byTemplate(h.rows, 'pharmacy_onboarding_submitted');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.toRecipients, ['shop@shah.test']);
  });

  it('sends Sent to the signer and the branch on one email, from content, tagged with the request', async () => {
    const h = harness();
    await h.emails.applicationReceived({ request: request(), demo: false });
    const sent = byTemplate(h.rows, 'pharmacy_onboarding_submitted')[0]!;
    assert.deepEqual(sent.toRecipients, ['priya@shah.test', 'shop@shah.test']);
    assert.equal(sent.idempotencyKey, `onboarding-sent:${REQUEST_ID}`);
    assert.equal(sent.onboardingRequestId, REQUEST_ID);
    const payload = sent.payload as Record<string, unknown>;
    assert.equal(payload.subject, 'We have your Holistic Health Hub application for Shah Pharmacy / Leeds');
    assert.equal(payload.fromName, 'Holistic Health Hub — Partner Onboarding');
    assert.equal(payload.replyTo, 'onboarding@holistichealthhub.live');
    const body = text(sent);
    assert.match(body, /^Hello Priya,/);
    assert.match(body, /to Curaleaf Laboratories on 19 November 2026\./);
    assert.match(body, /Priya {2}Patel accepted the Holistic Health Hub Partner Terms \(version v1\.0\) for SHAH HEALTH LIMITED on 19 November 2026\./);
    assert.match(body, /Card payments are optional/);
    assert.doesNotMatch(body, /Worldpay will email you/);
    // Terms not published: no link sentence at all.
    assert.doesNotMatch(body, /You can read them at any time/);
    assert.doesNotMatch(body, /\[/, 'no merge field or condition left unfilled');
  });

  it('switches the Worldpay line once an application is submitted (a draft does not count)', async () => {
    const draft = harness({ worldpay: 'DRAFT' });
    await draft.emails.applicationReceived({ request: request(), demo: false });
    assert.match(text(byTemplate(draft.rows, 'pharmacy_onboarding_submitted')[0]), /Card payments are optional/);

    const submitted = harness({ worldpay: 'SUBMITTED' });
    await submitted.emails.applicationReceived({ request: request(), demo: false });
    const body = text(byTemplate(submitted.rows, 'pharmacy_onboarding_submitted')[0]);
    assert.match(body, /Worldpay will email you separately/);
    assert.doesNotMatch(body, /Card payments are optional/);
  });

  it('mentions the Partner Terms only when they were accepted; without them it goes to the Curaleaf form signer', async () => {
    const accepted = harness();
    await accepted.emails.applicationReceived({ request: request(), demo: false });
    assert.match(text(byTemplate(accepted.rows, 'pharmacy_onboarding_submitted')[0]), /Your Partner Terms/);

    // Terms switched off: no acceptance at all. The form's own signer and the pharmacy email.
    const off = harness({ acceptances: [], request: request({ signatureName: 'Ravi Patel', pharmacistName: 'Asha Shah' }) });
    await off.emails.applicationReceived({ request: request({ signatureName: 'Ravi Patel', pharmacistName: 'Asha Shah' }), demo: false });
    const row = byTemplate(off.rows, 'pharmacy_onboarding_submitted')[0]!;
    assert.doesNotMatch(text(row), /Partner Terms/);
    assert.match(text(row), /Hello Ravi,/);
    assert.deepEqual(row.toRecipients, ['shop@shah.test']);
  });

  it('sends the application to Curaleaf with the renamed form, the licence and the Healius Reply-To', async () => {
    const h = harness();
    await h.emails.applicationReceived({ request: request(), demo: false });
    const curaleaf = byTemplate(h.rows, 'curaleaf_new_account_application');
    assert.equal(curaleaf.length, 1);
    const row = curaleaf[0]!;
    assert.deepEqual(row.toRecipients, ['new@curaleaf.test', 'second@curaleaf.test']);
    assert.deepEqual(row.ccRecipients, ['spatel@healiusconsulting.com']);
    assert.equal(row.idempotencyKey, `curaleaf-new-account-application:${REQUEST_ID}`);
    assert.equal(row.onboardingRequestId, REQUEST_ID);
    const payload = row.payload as Record<string, unknown>;
    assert.equal(payload[FILLED_FORM_NAME_KEY], 'Curaleaf-new-account_1234567_Shah Pharmacy Leeds_2026-11-19.pdf');
    assert.equal(payload[FILLED_FORM_PATH_KEY], 'pharmacy-onboarding/6c1c/curaleaf-account.pdf');
    assert.equal(payload[LICENCE_PATH_KEY], 'pharmacy-onboarding/6c1c/licence.pdf');
    assert.equal(payload.replyTo, 'spatel@healiusconsulting.com');
    assert.equal(payload.subject, 'New account application: Shah Pharmacy / Leeds, GPhC 1234567');
    assert.match(text(row), /on 19 November 2026 at 14:05\./);
    assert.deepEqual(senderFor('curaleaf_new_account_application', payload), {
      fromName: 'Holistic Health Hub — Partner Onboarding',
      replyTo: 'spatel@healiusconsulting.com',
    });
    const rendered = renderEmailTemplate('curaleaf_new_account_application', payload);
    assert.equal(rendered.subject, 'New account application: Shah Pharmacy / Leeds, GPhC 1234567');
    assert.match(rendered.html, /<strong>Once the account is open<\/strong>/);
    assert.match(rendered.html, /Replies to this email go to spatel@healiusconsulting\.com/);
  });

  it('sends a demo pharmacy\'s application to the CC list only, marked DEMO', async () => {
    const h = harness();
    await h.emails.applicationReceived({ request: request(), demo: true });
    const row = byTemplate(h.rows, 'curaleaf_new_account_application')[0]!;
    assert.deepEqual(row.toRecipients, ['spatel@healiusconsulting.com']);
    assert.deepEqual(row.ccRecipients ?? [], []);
    assert.match(String((row.payload as Record<string, unknown>).subject), /^DEMO, not sent to Curaleaf: New account application/);
  });

  it('sends each once, however often acceptance is retried', async () => {
    const h = harness();
    await h.emails.applicationReceived({ request: request(), demo: false });
    await h.emails.applicationReceived({ request: request(), demo: false });
    assert.equal(h.rows.length, 2);
  });
});

describe('onboarding emails: Activation and Hold', () => {
  it('activation: with the training link when one is set, otherwise the materials sentence', async () => {
    const withLink = harness();
    await withLink.emails.activated({ request: request({ organisationId: ORG_ID }), organisationId: ORG_ID });
    const row = withLink.rows[0]!;
    assert.equal(row.templateCode, 'pharmacy_onboarding_activated');
    assert.equal(row.idempotencyKey, `onboarding-activation:${REQUEST_ID}`);
    assert.equal(row.onboardingRequestId, REQUEST_ID);
    assert.match(text(row), /Train your team\. Book a place on a live session at https:\/\/calendly\.com\/spatel-72k\/30min, or use the training materials/);

    const noLink = harness({ content: { [ONBOARDING_CONTENT_KEYS.links]: { trainingBookingUrl: '' } } });
    await noLink.emails.activated({ request: request({ organisationId: ORG_ID }), organisationId: ORG_ID });
    const body = text(noLink.rows[0]);
    assert.match(body, /Train your team, using the training materials in your account\./);
    assert.doesNotMatch(body, /calendly/);

    await noLink.emails.activated({ request: request({ organisationId: ORG_ID }), organisationId: ORG_ID });
    assert.equal(noLink.rows.length, 1, 'once per request');
  });

  it('hold: only the chosen reason\'s block, plus the Worldpay line when one is submitted', async () => {
    const h = harness({ worldpay: 'WITH_WORLDPAY' });
    await h.emails.held({ request: request({ status: 'ON_HOLD' }), reason: 'MORE_INFORMATION_NEEDED', heldAt: '2026-11-19T15:00:00.000Z' });
    const row = h.rows[0]!;
    assert.equal(row.templateCode, 'pharmacy_onboarding_held');
    assert.equal(row.idempotencyKey, `onboarding-hold:${REQUEST_ID}:2026-11-19T15:00:00.000Z`);
    const body = text(row);
    assert.match(body, /We need some more information/);
    assert.doesNotMatch(body, /already has an account/);
    assert.doesNotMatch(body, /were not able to open an account/);
    assert.match(body, /Your Worldpay application is not affected/);

    const declined = harness();
    await declined.emails.held({ request: request({ status: 'ON_HOLD' }), reason: 'CURALEAF_DECLINED', heldAt: '2026-11-19T15:00:00.000Z' });
    const declinedBody = text(declined.rows[0]);
    assert.match(declinedBody, /were not able to open an account for Shah Pharmacy \/ Leeds/);
    assert.doesNotMatch(declinedBody, /more information|already has an account|Worldpay/);
  });

  it('hold: a new hold or a changed reason sends again, a retry of the same one does not', async () => {
    const h = harness();
    const held = request({ status: 'ON_HOLD' });
    await h.emails.held({ request: held, reason: 'EXISTING_CURALEAF_CUSTOMER', heldAt: '2026-11-19T15:00:00.000Z' });
    await h.emails.held({ request: held, reason: 'EXISTING_CURALEAF_CUSTOMER', heldAt: '2026-11-19T15:00:00.000Z' });
    await h.emails.held({ request: held, reason: 'CURALEAF_DECLINED', heldAt: '2026-11-19T16:00:00.000Z' });
    assert.equal(h.rows.length, 2);
  });
});

describe('onboarding emails: Live', () => {
  it('gives the PHAR code, never the API key, and lists only what is still open', async () => {
    const h = harness({
      request: request({ organisationId: ORG_ID, status: 'ACTIVATED' }),
      checklist: checklist([
        { key: 'sops_approved', section: 'required', label: 'SOPs approved by the superintendent' },
        { key: 'staff_training', section: 'optional', label: 'Staff training completed' },
      ]),
    });
    await h.emails.wentLive({ organisationId: ORG_ID });
    const row = h.rows[0]!;
    assert.equal(row.templateCode, 'pharmacy_onboarding_live');
    assert.equal(row.idempotencyKey, `onboarding-live:${ORG_ID}`);
    assert.equal(row.onboardingRequestId, REQUEST_ID);
    const body = text(row);
    assert.match(body, /Your Curaleaf account number is PHAR01234\./);
    assert.match(body, /These items on your checklist are still open:\n- SOPs approved by the superintendent\n\nPlease complete/);
    assert.match(body, /Also worth doing\n\n- Staff training completed$/m);
    assert.doesNotMatch(body, /platform live/, 'going live is the news, not an open item');
    assert.doesNotMatch(body, /Formulary/);
    assert.match(body, /Payment is taken in the pharmacy/);
    assert.doesNotMatch(body, /Online card payments are set up/);
    const everything = JSON.stringify(row);
    assert.ok(!everything.includes(API_KEY), 'the API key is never in an email');
    assert.ok(!everything.includes(API_KEY.slice(-4)), 'nor any part of it');
    assert.equal((row.payload as Record<string, unknown>).subject, 'Shah Pharmacy Leeds is live on Holistic Health Hub');
  });

  it('leaves out both checklist blocks when nothing is open, and says card payments are set up once validated', async () => {
    const h = harness({ worldpayValidated: true });
    await h.emails.wentLive({ organisationId: ORG_ID });
    const body = text(h.rows[0]);
    assert.doesNotMatch(body, /Before you dispense|Also worth doing|still open/);
    assert.match(body, /Online card payments are set up/);
    assert.doesNotMatch(body, /Payment is taken in the pharmacy/);
  });

  it('sends once per branch', async () => {
    const h = harness();
    await h.emails.wentLive({ organisationId: ORG_ID });
    await h.emails.wentLive({ organisationId: ORG_ID });
    assert.equal(h.rows.length, 1);
  });

  it('a branch with no request goes to its own inbox, untagged', async () => {
    const h = harness({ requestForOrg: null, acceptances: [], organisation: organisation({ pharmacyEmail: null }) });
    await h.emails.wentLive({ organisationId: ORG_ID });
    const row = h.rows[0]!;
    assert.deepEqual(row.toRecipients, ['asha@shah.test']);
    assert.equal(row.onboardingRequestId, undefined);
    assert.match(text(row), /^Hello Asha,/);
  });
});

describe('onboarding emails: failures, resend and the send log', () => {
  it('never throws when queueing or reading content fails', async () => {
    for (const options of [{ failEnqueue: true }, { failContent: true }]) {
      const h = harness(options);
      await h.emails.applicationReceived({ request: request(), demo: false });
      await h.emails.activated({ request: request(), organisationId: ORG_ID });
      await h.emails.held({ request: request(), reason: 'CURALEAF_DECLINED', heldAt: NOW.toISOString() });
      await h.emails.wentLive({ organisationId: ORG_ID });
      assert.equal(h.rows.length, 0);
      assert.equal(h.warnings.length, 5);
    }
  });

  it('resend queues the same email again under a new key each time', async () => {
    const h = harness();
    await h.emails.applicationReceived({ request: request(), demo: false });
    await h.emails.resend({ requestId: REQUEST_ID, kind: 'sent', actorUid: 'admin-1' });
    h.tick();
    await h.emails.resend({ requestId: REQUEST_ID, kind: 'sent', actorUid: 'admin-1' });
    const sent = byTemplate(h.rows, 'pharmacy_onboarding_submitted');
    assert.equal(sent.length, 3);
    assert.equal(sent[1]!.idempotencyKey, `onboarding-sent:${REQUEST_ID}:resend:2026-11-19T14:30:00.000Z`);
    assert.equal(sent[2]!.idempotencyKey, `onboarding-sent:${REQUEST_ID}:resend:2026-11-19T14:31:00.000Z`);
    assert.equal(sent[1]!.onboardingRequestId, REQUEST_ID);

    await h.emails.resend({ requestId: REQUEST_ID, kind: 'curaleafApplication', actorUid: 'admin-1' });
    assert.match(byTemplate(h.rows, 'curaleaf_new_account_application').at(-1)!.idempotencyKey, /^curaleaf-new-account-application:.*:resend:/);
  });

  it('resend refuses an email that does not apply yet', async () => {
    const h = harness();
    await assert.rejects(h.emails.resend({ requestId: REQUEST_ID, kind: 'activation', actorUid: 'a' }), { statusCode: 409 });
    await assert.rejects(h.emails.resend({ requestId: REQUEST_ID, kind: 'hold', actorUid: 'a' }), { statusCode: 409 });
    await assert.rejects(h.emails.resend({ requestId: 'f0000000-0000-4000-8000-000000000000', kind: 'sent', actorUid: 'a' }), { statusCode: 404 });
    // While the Partner Terms are on: never to Curaleaf (or the pharmacy) before they are accepted.
    const noTerms = harness({ acceptances: [], termsRequired: true });
    for (const kind of ['sent', 'curaleafApplication'] as const) {
      await assert.rejects(noTerms.emails.resend({ requestId: REQUEST_ID, kind, actorUid: 'a' }), { statusCode: 409 });
    }
    assert.equal(noTerms.rows.length, 0);
    // While they are off, the Curaleaf form alone is enough.
    const termsOff = harness({ acceptances: [] });
    await termsOff.emails.resend({ requestId: REQUEST_ID, kind: 'curaleafApplication', actorUid: 'a' });
    assert.equal(termsOff.rows.length, 1);
    const onHold = harness({ request: request({ status: 'ON_HOLD', holdReason: 'EXISTING_CURALEAF_CUSTOMER', heldAt: '2026-11-19T15:00:00.000Z' }) });
    await onHold.emails.resend({ requestId: REQUEST_ID, kind: 'hold', actorUid: 'a' });
    assert.match(onHold.rows[0]!.idempotencyKey, /^onboarding-hold:.*:2026-11-19T15:00:00\.000Z:resend:/);
    assert.match(text(onHold.rows[0]), /already has an account/);
  });

  it('the send log maps rows to kinds, newest first, with every recipient', async () => {
    const rows = [
      { id: 'a', templateCode: 'pharmacy_onboarding_submitted', status: 'SENT', createdAt: '2026-11-19T14:20:00Z', sentAt: '2026-11-19T14:21:00Z', toRecipients: ['p@x.test', 's@x.test'], encryptedRecipient: 'p@x.test' },
      { id: 'b', templateCode: 'curaleaf_new_account_application', status: 'FAILED', createdAt: '2026-11-19T14:22:00Z', failedAt: '2026-11-19T14:40:00Z', failureCode: 'Message provider returned 500.', toRecipients: ['c@x.test'], ccRecipients: ['h@x.test'], encryptedRecipient: 'c@x.test' },
      { id: 'c', templateCode: 'pharmacy_onboarding_held', status: 'PROCESSING', createdAt: '2026-11-20T09:00:00Z', encryptedRecipient: 'p@x.test' },
      { id: 'd', templateCode: 'patient_referred', status: 'SENT', createdAt: '2026-11-21T09:00:00Z', encryptedRecipient: 'z@x.test' },
    ] as unknown as NotificationOutboxRecord[];
    const entries = await onboardingEmailLog({ listForOnboardingRequest: async () => rows }, REQUEST_ID);
    assert.deepEqual(entries.map(entry => [entry.id, entry.kind, entry.status]), [
      ['c', 'hold', 'PENDING'],
      ['b', 'curaleafApplication', 'FAILED'],
      ['a', 'sent', 'SENT'],
    ]);
    assert.deepEqual(entries[1]!.recipients, ['c@x.test', 'h@x.test']);
    assert.equal(entries[1]!.failureCode, 'Message provider returned 500.');
    assert.deepEqual(entries[0]!.recipients, ['p@x.test']);
  });
});

describe('curaleafFormFilename', () => {
  it('strips characters unsafe in filenames and dates the file in UK time', () => {
    assert.equal(curaleafFormFilename('1234567', 'Boots: "Leeds" <Central>/2?', '2026-11-19T14:05:00Z'), 'Curaleaf-new-account_1234567_Boots Leeds Central2_2026-11-19.pdf');
    // 23:30 UTC on 30 June is 00:30 on 1 July in London.
    assert.equal(curaleafFormFilename('1234567', 'Shah', '2026-06-30T23:30:00Z'), 'Curaleaf-new-account_1234567_Shah_2026-07-01.pdf');
    assert.equal(curaleafFormFilename('1234567', '...', '2026-11-19T14:05:00Z'), 'Curaleaf-new-account_1234567_Pharmacy_2026-11-19.pdf');
  });
});
