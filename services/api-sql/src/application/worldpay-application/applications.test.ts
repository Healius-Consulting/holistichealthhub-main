import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import JSZip from 'jszip';
import { HttpError } from '../../domain/common/errors.js';
import { completeAnswers } from '../../domain/worldpay-application/answers.test.js';
import { WORLDPAY_CONTENT_KEYS } from '../../domain/worldpay-application/content.js';
import type {
  PlatformContentRepository,
  WorldpayApplicationRecord,
  WorldpayApplicationRepository,
} from '../../repositories/ports/worldpay-application.port.js';
import type { ImmediateEmail } from '../workers/deliver-messages.js';
import {
  applyWorldpayRetention,
  loadWorldpayApplication,
  resendWorldpayApplication,
  saveWorldpayDraft,
  setWorldpayApplicationStatus,
  submitWorldpayApplication,
  type WorldpayDeps,
  type WorldpayOwner,
} from './applications.js';

const NOW = new Date('2026-11-18T12:00:00Z');

class MemoryRepo implements WorldpayApplicationRepository {
  rows = new Map<string, WorldpayApplicationRecord>();
  private seq = 0;
  async findById(id: string) { return structuredClone(this.rows.get(id) ?? null); }
  async findForOrganisation(organisationId: string) { return structuredClone([...this.rows.values()].filter(r => r.organisationId === organisationId).at(-1) ?? null); }
  async findForRequest(requestId: string) { return structuredClone([...this.rows.values()].filter(r => r.onboardingRequestId === requestId).at(-1) ?? null); }
  async create(input: Parameters<WorldpayApplicationRepository['create']>[0]) {
    const id = `app-${++this.seq}`;
    this.rows.set(id, {
      id, organisationId: input.organisationId, onboardingRequestId: input.onboardingRequestId, gphcNumber: input.gphcNumber,
      status: 'DRAFT', reference: null, answers: input.answers, version: 1, legalName: input.legalName, tradingName: input.tradingName,
      usesHhhWebsite: input.usesHhhWebsite, companyNumber: input.companyNumber, companyStatus: input.companyStatus,
      companyLookedUpAt: input.companyLookedUpAt, companyName: input.companyName, submittedAt: null, submittedByUid: null,
      submitterName: null, submitterEmail: null, signerName: null, signerPosition: null, pdfStoragePath: null, xlsxStoragePath: null,
      sentAt: null, deliveryError: null, statusNote: null, statusChangedAt: null, statusChangedByUid: null, sensitiveDeletedAt: null,
      createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    });
    return id;
  }
  async saveDraft(id: string, version: number, answers: WorldpayApplicationRecord['answers']) {
    const row = this.rows.get(id);
    if (!row || row.status !== 'DRAFT' || row.version !== version) return false;
    Object.assign(row, { answers, version: version + 1 });
    return true;
  }
  async markSubmitted(id: string, version: number, fields: Parameters<WorldpayApplicationRepository['markSubmitted']>[2]) {
    const row = this.rows.get(id);
    if (!row || row.status !== 'DRAFT' || row.version !== version) return false;
    Object.assign(row, fields, { status: 'SUBMITTED', version: version + 1, statusChangedAt: fields.submittedAt });
    return true;
  }
  async lastReference(prefix: string) { return [...this.rows.values()].map(r => r.reference).filter((r): r is string => Boolean(r?.startsWith(prefix))).sort().at(-1) ?? null; }
  async recordDelivery(id: string, result: { sentAt: string } | { deliveryError: string }) {
    const row = this.rows.get(id)!;
    if ('sentAt' in result) Object.assign(row, { sentAt: result.sentAt, deliveryError: null });
    else row.deliveryError = result.deliveryError;
  }
  async setStatus(id: string, status: WorldpayApplicationRecord['status'], change: { note: string | null; byUid: string | null; at: string }) {
    Object.assign(this.rows.get(id)!, { status, statusNote: change.note, statusChangedByUid: change.byUid, statusChangedAt: change.at });
  }
  async list() { return [...this.rows.values()]; }
  async linkRequestToOrganisation() {}
  async listForRetention(closedBefore: string, draftBefore: string) {
    return [...this.rows.values()].filter(r => (['ACCOUNT_OPEN', 'CONNECTED', 'WITHDRAWN', 'DECLINED'].includes(r.status) && (r.statusChangedAt ?? '') < closedBefore && !r.sensitiveDeletedAt)
      || (r.status === 'DRAFT' && r.updatedAt < draftBefore));
  }
  async clearSensitive(id: string, answers: WorldpayApplicationRecord['answers'], at: string) {
    Object.assign(this.rows.get(id)!, { answers, pdfStoragePath: null, xlsxStoragePath: null, sensitiveDeletedAt: at });
  }
  async deleteDraft(id: string) { this.rows.delete(id); }
}

class MemoryContent implements PlatformContentRepository {
  constructor(public values: Record<string, unknown> = {}) {}
  async read(keys: string[]) { return Object.fromEntries(keys.filter(k => k in this.values).map(k => [k, this.values[k]])); }
  async write(key: string, value: unknown) { this.values[key] = value; }
}

function harness(content: Record<string, unknown> = {}) {
  const repo = new MemoryRepo();
  const files = new Map<string, Buffer>([['worldpay/service-info.pdf', Buffer.from('%PDF service')]]);
  const sent: ImmediateEmail[] = [];
  let failNext = false;
  const deps: WorldpayDeps = {
    repo,
    content: new MemoryContent(content),
    storage: {
      async saveObject(path, bytes) { files.set(path, bytes); },
      async downloadFile(path) { const bytes = files.get(path); if (!bytes) throw new Error('missing'); return { bytes, contentType: 'application/octet-stream' }; },
      async deleteFile(path) { files.delete(path); },
    },
    sendEmail: async email => { if (failNext) { failNext = false; throw new Error('Message provider returned 500.'); } sent.push(email); },
    now: () => NOW,
  };
  return { deps, repo, files, sent, failOnce: () => { failNext = true; } };
}

const branch: WorldpayOwner = { kind: 'branch', organisationId: 'org-1', gphcNumber: '1234567' };
const submitter = { uid: 'uid-1', name: 'Priya Shah', email: 'priya@example.test' };
const declaration = { accurate: true, consent: true, signerName: 'Priya Shah', signerPosition: 'Director' };

async function submitted(h: ReturnType<typeof harness>, answers = completeAnswers()) {
  const draft = await saveWorldpayDraft(h.deps, branch, { id: null, version: 0, answers });
  return submitWorldpayApplication(h.deps, branch, { id: draft.id, version: draft.version, answers, declaration, submitter });
}

const SENSITIVE = ['1980-04-12', '12/04/1980', '1 Home Road', '12345678', '20-00-00', '200000'];

describe('Worldpay application', () => {
  it('starts from what the platform knows and the scheme answers in admin', async () => {
    const h = harness({ [WORLDPAY_CONTENT_KEYS.schemeAnswers]: { s01: 'UK only.', s02: 'Yes.', s03: 'Licensed [B-09].', s04: 'Waive Visa.', s05: 'None.' } });
    const view = await loadWorldpayApplication(h.deps, branch, { legalName: 'Shah Health Ltd', tradingName: 'Shah Pharmacy', gphcNumber: '1234567', contactName: 'Priya Shah' });
    assert.equal(view.id, null);
    assert.equal(view.answers.business.businessType, 'Limited company');
    assert.equal(view.answers.business.legalName, 'Shah Health Ltd');
    assert.equal(view.answers.financials.accountName, 'Shah Health Ltd');
    assert.equal(view.answers.financials.expectedCardPayments, 100000);
    assert.equal(view.answers.transactions.internet, 100);
    assert.equal(view.answers.scheme.s01, 'UK only.');
    assert.equal(view.content.pricingPanel.price, '1.3% + 20p per transaction*');
  });

  it('saves drafts and refuses a stale save', async () => {
    const h = harness();
    const first = await saveWorldpayDraft(h.deps, branch, { id: null, version: 0, answers: { business: { legalName: 'Shah' } } });
    const second = await saveWorldpayDraft(h.deps, branch, { id: first.id, version: first.version, answers: { business: { legalName: 'Shah Health' } } });
    assert.equal(second.version, 2);
    await assert.rejects(saveWorldpayDraft(h.deps, branch, { id: first.id, version: 1, answers: {} }), (e: HttpError) => e.code === 'WORLDPAY_DRAFT_CONFLICT');
  });

  it('will not submit until every answer is in, and says where', async () => {
    const h = harness();
    const answers = completeAnswers();
    answers.financials.sortCode = '1';
    const draft = await saveWorldpayDraft(h.deps, branch, { id: null, version: 0, answers });
    await assert.rejects(
      submitWorldpayApplication(h.deps, branch, { id: draft.id, version: draft.version, answers, declaration, submitter }),
      (e: HttpError) => e.statusCode === 422 && Array.isArray(e.details) && (e.details as Array<{ path: string }>).some(p => p.path === 'financials.sortCode'),
    );
    await assert.rejects(
      submitWorldpayApplication(h.deps, branch, { id: draft.id, version: draft.version, answers: completeAnswers(), declaration: { ...declaration, consent: false }, submitter }),
    );
    assert.equal(h.sent.length, 0);
  });

  it('submits: a reference, both files, WP-01 to the admin route with attachments, WP-02 to the pharmacy', async () => {
    const h = harness();
    const answers = completeAnswers();
    answers.business.hasOwnWebsite = 'yes';
    answers.business.website = 'https://shahpharmacy.example';
    const record = await submitted(h, answers);
    assert.equal(record.status, 'SUBMITTED', 'the default route is HHH\'s own mailbox, so it waits for admin');
    assert.equal(record.reference, 'HHH-WP-2026-0001');
    assert.ok(record.sentAt);
    assert.equal(record.deliveryError, null);
    const [wp01, wp02] = h.sent;
    assert.equal(wp01?.templateCode, 'worldpay_application_to_worldpay');
    assert.deepEqual(wp01?.to, ['worldpay@holistichealthhub.live']);
    assert.deepEqual(wp01?.attachments.map(a => a.filename), [
      'Worldpay-application_SHAH HEALTH LIMITED_HHH-WP-2026-0001.pdf',
      'Worldpay-application_SHAH HEALTH LIMITED_HHH-WP-2026-0001.xlsx',
    ]);
    assert.equal(wp01?.payload.subject, 'Worldpay application — SHAH HEALTH LIMITED t/a Shah Pharmacy — HHH-WP-2026-0001');
    assert.equal(wp02?.templateCode, 'worldpay_application_confirmation');
    assert.deepEqual(wp02?.to, ['priya@example.test', 'shop@example.test']);
    assert.match(String(wp02?.payload.subject), /HHH-WP-2026-0001/);
    assert.match(String(wp02?.payload.paragraphs), /^Hello Priya,/);
    for (const email of h.sent) {
      const body = JSON.stringify(email.payload);
      for (const secret of SENSITIVE) assert.ok(!body.includes(secret), `${email.templateCode} body leaks ${secret}`);
    }
    assert.equal(wp01!.attachments[0]!.content.subarray(0, 4).toString(), '%PDF');
    // Worldpay's own questionnaire, filled in: answers in column C, percentages as fractions, dates as Excel dates.
    const sheet = await JSZip.loadAsync(wp01!.attachments[1]!.content);
    const questionnaire = await sheet.file('xl/worksheets/sheet1.xml')!.async('string');
    assert.match(questionnaire, /HHH-WP-2026-0001/);
    assert.match(questionnaire, /<c r="C11" s="31" t="inlineStr"><is><t xml:space="preserve">SHAH HEALTH LIMITED<\/t>/);
    assert.match(questionnaire, /<c r="C91" s="42"><v>1<\/v><\/c>/);
    assert.match(questionnaire, /<c r="C36" s="38"><v>29323<\/v><\/c>/);
    assert.match(questionnaire, /Principal 1: Director and Shareholder/);
    assert.match(questionnaire, /<f>SUM\(C89:C91\)<\/f>/, 'totals stay formulas');
    assert.match(await sheet.file('xl/worksheets/sheet2.xml')!.async('string'), /<c r="D5" s="57" t="inlineStr"><is><t xml:space="preserve">1234567<\/t>/);
  });

  it('sends the PDF and spreadsheet only, giving the HHH website when the pharmacy has none', async () => {
    const noSite = harness();
    await submitted(noSite);
    assert.equal(noSite.sent[0]?.templateCode, 'worldpay_application_to_worldpay');
    assert.equal(noSite.sent[0]?.attachments.length, 2);
    assert.match(String(noSite.sent[0]!.payload.paragraphs), /does not have a website/);
    assert.doesNotMatch(String(noSite.sent[0]!.payload.paragraphs), /attached Holistic Health Hub|service information/);
    assert.doesNotMatch(String(noSite.sent[0]!.payload.paragraphs), /Website: /);

    const ownSite = harness();
    const answers = completeAnswers();
    answers.business.hasOwnWebsite = 'yes';
    answers.business.website = 'https://shahpharmacy.example';
    await submitted(ownSite, answers);
    assert.equal(ownSite.sent[0]?.attachments.length, 2);
    assert.match(String(ownSite.sent[0]!.payload.paragraphs), /Website: https:\/\/shahpharmacy\.example/);
  });

  it('numbers references within the year and goes straight to With Worldpay when admin sends to Worldpay', async () => {
    const h = harness({ [WORLDPAY_CONTENT_KEYS.recipients]: { to: ['onboarding@worldpay-agent.example'], cc: ['worldpay@holistichealthhub.live'] } });
    const answers = completeAnswers();
    answers.business.hasOwnWebsite = 'yes';
    answers.business.website = 'https://shahpharmacy.example';
    const first = await submitted(h, answers);
    const second = await submitWorldpayApplication(h.deps, { kind: 'branch', organisationId: 'org-2', gphcNumber: '7654321' }, {
      ...(await saveWorldpayDraft(h.deps, { kind: 'branch', organisationId: 'org-2', gphcNumber: '7654321' }, { id: null, version: 0, answers })),
      answers, declaration, submitter,
    });
    assert.equal(first.status, 'WITH_WORLDPAY');
    assert.equal(second.reference, 'HHH-WP-2026-0002');
    assert.deepEqual(h.sent[0]?.cc, ['worldpay@holistichealthhub.live']);
  });

  it('records a failed send for admin to resend, and resends', async () => {
    const h = harness();
    h.failOnce();
    const answers = completeAnswers();
    answers.business.hasOwnWebsite = 'yes';
    answers.business.website = 'https://shahpharmacy.example';
    const record = await submitted(h, answers);
    assert.equal(record.status, 'SUBMITTED');
    assert.match(record.deliveryError ?? '', /500/);
    const resent = await resendWorldpayApplication(h.deps, record.id);
    assert.ok(resent.sentAt);
    assert.equal(resent.deliveryError, null);
  });

  it('lets admin move the status on, with a note for a query', async () => {
    const h = harness();
    const record = await submitted(h);
    await assert.rejects(setWorldpayApplicationStatus(h.deps, record.id, { status: 'QUERY', note: ' ', byUid: 'admin' }), (e: HttpError) => e.code === 'WORLDPAY_QUERY_NOTE_REQUIRED');
    const query = await setWorldpayApplicationStatus(h.deps, record.id, { status: 'QUERY', note: 'Worldpay need the VAT number.', byUid: 'admin' });
    assert.equal(query.status, 'QUERY');
    const view = await loadWorldpayApplication(h.deps, branch, {});
    assert.equal(view.statusNote, 'Worldpay need the VAT number.');
    await assert.rejects(saveWorldpayDraft(h.deps, branch, { id: record.id, version: view.version, answers: {} }), (e: HttpError) => e.code === 'WORLDPAY_APPLICATION_SUBMITTED');
  });

  it('clears principals, bank details and files 30 days after closing, and deletes stale drafts', async () => {
    const h = harness();
    const record = await submitted(h);
    await setWorldpayApplicationStatus(h.deps, record.id, { status: 'ACCOUNT_OPEN', note: null, byUid: 'admin' });
    await saveWorldpayDraft(h.deps, { kind: 'request', onboardingRequestId: 'req-1', gphcNumber: '1111111' }, { id: null, version: 0, answers: {} });
    const later = { ...h.deps, now: () => new Date(NOW.getTime() + 91 * 24 * 60 * 60 * 1000) };
    for (const row of h.repo.rows.values()) if (row.status === 'DRAFT') row.updatedAt = NOW.toISOString();
    const result = await applyWorldpayRetention(later);
    assert.deepEqual(result, { cleared: 1, draftsDeleted: 1, failed: 0 });
    const cleared = h.repo.rows.get(record.id)!;
    assert.deepEqual(cleared.answers.principals, []);
    assert.equal(cleared.answers.financials.accountNumber, '');
    assert.equal(cleared.pdfStoragePath, null);
    assert.equal(cleared.legalName, 'SHAH HEALTH LIMITED');
    assert.equal([...h.files.keys()].filter(path => path.startsWith('worldpay-applications/')).length, 0);
  });
});
