import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { emptyPrompt, partnerTermsPromptId, type PartnerTermsDocumentRecord, type PartnerTermsPromptRecord } from '../../domain/pharmacy-onboarding/partner-terms.js';
import type { PartnerTermsAcceptanceRecord } from '../../domain/pharmacy-onboarding/terms.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import { remindUnsignedPartnerTerms } from '../workers/partner-terms-reminder.js';
import {
  owesSignature,
  PARTNER_TERMS_SETTINGS_KEY,
  partnerTermsState,
  recordPromptSigned,
  recordPromptSkipped,
  recordPromptViewed,
} from './partner-terms.service.js';
import { afterTermsSigned } from './partner-terms-signing.js';
import { stampSignedCopy } from './signed-terms-copy.js';

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DOC = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-27T09:00:00.000Z');

const doc = (overrides: Partial<PartnerTermsDocumentRecord> = {}): PartnerTermsDocumentRecord => ({
  id: DOC, version: 'v1.0', storagePath: 'partner-terms/v1.pdf', filename: 'v1.pdf', sizeBytes: 9, uploadedAt: '2026-11-19T09:00:00Z',
  uploadedByUid: 'admin', publishedAt: '2026-11-19T09:05:00Z', publishedByUid: 'admin', withdrawnAt: null, withdrawnByUid: null,
  ...overrides,
});

function stateDeps(settings: unknown, document: PartnerTermsDocumentRecord | null = doc()) {
  return {
    content: { read: async () => (settings === undefined ? {} : { [PARTNER_TERMS_SETTINGS_KEY]: settings }) },
    repo: { findDocument: async (id: string) => (document && id === document.id ? document : null) },
  };
}

function promptStore(initial: PartnerTermsPromptRecord[] = []) {
  const rows = new Map(initial.map(row => [row.id, row]));
  return {
    rows,
    findPrompt: async (organisationId: string, documentId: string) => rows.get(partnerTermsPromptId(organisationId, documentId)) ?? null,
    savePrompt: async (row: PartnerTermsPromptRecord) => { rows.set(row.id, row); },
    listPrompts: async (documentId: string) => [...rows.values()].filter(row => row.documentId === documentId),
  };
}

async function samplePdf() {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  pdf.addPage();
  return pdf.save();
}

describe('Partner Terms state', () => {
  it('is off by default, for the text-era row, and until a published version is current', async () => {
    assert.equal((await partnerTermsState(stateDeps(undefined))).on, false);
    assert.equal((await partnerTermsState(stateDeps({ published: true, version: 'v1', text: 'Old text' }))).on, false, 'the old typed-Terms row reads as off');
    assert.equal((await partnerTermsState(stateDeps({ enabled: true, currentDocumentId: null }))).on, false);
    assert.equal((await partnerTermsState(stateDeps({ enabled: false, currentDocumentId: DOC }))).on, false);
    assert.equal((await partnerTermsState(stateDeps({ enabled: true, currentDocumentId: DOC }, doc({ publishedAt: null })))).on, false, 'a draft is never current');
    assert.equal((await partnerTermsState(stateDeps({ enabled: true, currentDocumentId: DOC }, doc({ withdrawnAt: '2026-11-20T00:00:00Z' })))).on, false);
    const on = await partnerTermsState(stateDeps({ enabled: true, currentDocumentId: DOC }));
    assert.equal(on.on, true);
    assert.equal(on.document?.version, 'v1.0');
  });

  it('reads a version id stored without hyphens (as Data Connect returns it) as the same version', async () => {
    const compact = DOC.replaceAll('-', '');
    const state = await partnerTermsState(stateDeps({ enabled: true, currentDocumentId: compact }, doc({ id: DOC })));
    assert.equal(state.on, true, 'a compact id must not make the switch read as off');
    assert.equal(owesSignature(state, { status: 'LIVE' }, [{ documentId: compact }]), false, 'a signature recorded with the compact id counts');
  });

  it('asks activated branches without a signature for the current version, and nobody while off', async () => {
    const on = await partnerTermsState(stateDeps({ enabled: true, currentDocumentId: DOC }));
    const off = await partnerTermsState(stateDeps({ enabled: false, currentDocumentId: DOC }));
    assert.equal(owesSignature(on, { status: 'LIVE' }, []), true);
    assert.equal(owesSignature(on, { status: 'ONBOARDING' }, [{ documentId: 'older' }]), true, 'an older version does not count');
    assert.equal(owesSignature(on, { status: 'LIVE' }, [{ documentId: DOC }]), false);
    assert.equal(owesSignature(on, { status: 'ON_HOLD' }, []), false, 'a held branch cannot log in');
    assert.equal(owesSignature(off, { status: 'LIVE' }, []), false);
  });

  it('records the first view once, every skip, and the signature', async () => {
    const store = promptStore();
    await recordPromptViewed(store, ORG, DOC, { uid: 'u1', email: 'first@pharmacy.test' }, new Date('2026-11-20T09:00:00Z'));
    await recordPromptViewed(store, ORG, DOC, { uid: 'u2', email: 'second@pharmacy.test' }, new Date('2026-11-21T09:00:00Z'));
    await recordPromptSkipped(store, ORG, DOC, 'u2', new Date('2026-11-21T09:01:00Z'));
    const skipped = await recordPromptSkipped(store, ORG, DOC, 'u3', new Date('2026-11-22T09:00:00Z'));
    assert.equal(skipped.firstViewedAt, '2026-11-20T09:00:00.000Z');
    assert.equal(skipped.firstViewedByEmail, 'first@pharmacy.test');
    assert.equal(skipped.viewCount, 2);
    assert.equal(skipped.skipCount, 2);
    assert.equal(skipped.lastSkippedByUid, 'u3');
    const signed = await recordPromptSigned(store, ORG, DOC, NOW);
    assert.equal(signed.signedAt, NOW.toISOString());
    assert.equal((await recordPromptSigned(store, ORG, DOC, new Date())).signedAt, NOW.toISOString(), 'the first signature time stands');
  });
});

describe('the signed copy', () => {
  it('is the Terms PDF with one stamped signature page added', async () => {
    const original = await samplePdf();
    const stamped = await stampSignedCopy(original, {
      pharmacyName: 'Kirkgate Pharmacy', registeredCompanyName: 'Kirkgate Health Ltd', gphcPremisesNumber: '1123456',
      signerName: 'Asha Shah', signerRole: 'Superintendent pharmacist', signerGphcNumber: '2012345', signerEmail: 'asha@kirkgate.test',
      signedAt: '2026-11-20T10:42:00.000Z', termsVersion: 'v1.0', acceptanceId: 'acc-1',
    });
    const loaded = await PDFDocument.load(stamped);
    assert.equal(loaded.getPageCount(), 3);
  });

  it('after signing: the prompt is marked signed, the copy stored, and the confirmation queued with it attached', async () => {
    const original = await samplePdf();
    const saved: string[] = [];
    const queued: Array<{ templateCode: string; toRecipients?: string[]; payload: Record<string, unknown> }> = [];
    const store = promptStore([{ ...emptyPrompt(ORG, DOC), firstViewedAt: '2026-11-20T09:00:00Z' }]);
    const linked: Array<[string, string]> = [];
    const acceptance = {
      id: 'acc-1', onboardingRequestId: null, organisationId: ORG, termsVersion: 'v1.0', documentId: DOC, signerName: 'Asha Shah',
      signerRole: 'SUPERINTENDENT_PHARMACIST', signerRoleOther: null, signerEmail: 'asha@kirkgate.test', signerGphcNumber: '2012345',
      registeredCompanyName: 'Kirkgate Health Ltd', acceptedAt: '2026-11-20T10:42:00.000Z', ipAddress: null, source: 'reacceptance',
      nameMatchesPharmsmart: null,
    } satisfies PartnerTermsAcceptanceRecord;
    const result = await afterTermsSigned({
      storage: { downloadFile: async () => ({ bytes: Buffer.from(original) }), saveObject: async path => { saved.push(path); } },
      terms: { ...store, findDocument: async () => doc() },
      acceptances: { setTermsSignedCopy: async (id, path) => { linked.push([id, path]); } },
      notifications: { enqueue: async row => { queued.push(row as never); return { created: true } as never; } },
      now: () => NOW,
    }, acceptance, { organisationId: ORG, onboardingRequestId: null, pharmacyName: 'Kirkgate Pharmacy', gphcNumber: '1123456', pharmacyEmail: 'shop@kirkgate.test' });
    assert.equal(result.signedCopyPath, `partner-terms/signed/${ORG}/acc-1.pdf`);
    assert.deepEqual(saved, [result.signedCopyPath]);
    assert.deepEqual(linked, [['acc-1', result.signedCopyPath]]);
    assert.equal((await store.findPrompt(ORG, DOC))?.signedAt, NOW.toISOString());
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.templateCode, 'pharmacy_partner_terms_signed');
    assert.deepEqual(queued[0]!.toRecipients, ['shop@kirkgate.test', 'asha@kirkgate.test']);
    assert.equal(queued[0]!.payload.signedTermsStoragePath, result.signedCopyPath);
  });

  it('still sends the confirmation, without the attachment, when the copy cannot be made', async () => {
    const queued: Array<{ payload: Record<string, unknown> }> = [];
    const acceptance = {
      id: 'acc-2', onboardingRequestId: 'req-1', organisationId: null, termsVersion: 'v1.0', documentId: DOC, signerName: 'Asha Shah',
      signerRole: 'DIRECTOR', signerRoleOther: null, signerEmail: 'asha@kirkgate.test', signerGphcNumber: null,
      registeredCompanyName: 'Kirkgate Health Ltd', acceptedAt: '2026-11-20T10:42:00.000Z', ipAddress: null, source: 'signup',
      nameMatchesPharmsmart: null,
    } satisfies PartnerTermsAcceptanceRecord;
    await afterTermsSigned({
      storage: { downloadFile: async () => { throw new Error('storage down'); }, saveObject: async () => undefined },
      terms: { ...promptStore(), findDocument: async () => doc() },
      acceptances: { setTermsSignedCopy: async () => undefined },
      notifications: { enqueue: async row => { queued.push(row as never); return { created: true } as never; } },
      warn: () => undefined,
    }, acceptance, { organisationId: null, onboardingRequestId: 'req-1', pharmacyName: 'Kirkgate Pharmacy', gphcNumber: '1123456', pharmacyEmail: 'shop@kirkgate.test' });
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.payload.signedTermsStoragePath, undefined);
  });
});

describe('the 7-day reminder', () => {
  function reminderHarness(options: { firstViewedAt?: string | null; signed?: boolean; reminderSentAt?: string | null; enabled?: boolean; status?: string } = {}) {
    const store = promptStore([{
      ...emptyPrompt(ORG, DOC),
      firstViewedAt: options.firstViewedAt === undefined ? '2026-11-20T08:00:00.000Z' : options.firstViewedAt,
      firstViewedByEmail: 'first@kirkgate.test',
      reminderSentAt: options.reminderSentAt ?? null,
    }]);
    const queued: Array<{ templateCode: string; toRecipients?: string[]; ccRecipients?: string[] }> = [];
    const overdue: string[] = [];
    const organisation = { id: ORG, name: 'Kirkgate Pharmacy', status: options.status ?? 'LIVE', gphcNumber: '1123456', pharmacyEmail: 'shop@kirkgate.test', mainContactEmail: 'owner@kirkgate.test' } as OrganisationRecord;
    const deps = {
      ...stateDeps({ enabled: options.enabled ?? true, currentDocumentId: DOC }),
      repo: { ...store, findDocument: async () => doc() },
      acceptances: {
        findByOrganisationId: async () => null,
        findTermsAcceptances: async () => [],
        findTermsAcceptancesForOrganisation: async () => (options.signed ? [{ id: 'a', documentId: DOC, acceptedAt: '2026-11-21T00:00:00Z' }] as never : []),
      },
      findOrganisation: async () => organisation,
      notifications: { enqueue: async (row: never) => { queued.push(row); return { created: true } as never; } },
      clickup: { termsOverdue: async (input: { version: string }) => { overdue.push(input.version); } },
    };
    return { deps, store, queued, overdue };
  }

  it('emails the pharmacy and the first viewer once, 7 days after the first view, and tells ClickUp', async () => {
    const h = reminderHarness();
    const summary = await remindUnsignedPartnerTerms(h.deps, NOW);
    assert.equal(summary.sent, 1);
    assert.equal(h.queued[0]!.templateCode, 'pharmacy_partner_terms_reminder');
    assert.deepEqual(h.queued[0]!.toRecipients, ['shop@kirkgate.test']);
    assert.deepEqual(h.queued[0]!.ccRecipients, ['first@kirkgate.test']);
    assert.deepEqual(h.overdue, ['v1.0']);
    assert.ok((await h.store.findPrompt(ORG, DOC))?.reminderSentAt);
    assert.equal((await remindUnsignedPartnerTerms(h.deps, NOW)).sent, 0, 'only once per version');
  });

  it('waits the full 7 days, and never emails a branch that has not seen it, has signed, or while the Terms are off', async () => {
    assert.equal((await remindUnsignedPartnerTerms(reminderHarness({ firstViewedAt: '2026-11-20T09:30:00.000Z' }).deps, NOW)).sent, 0);
    assert.equal((await remindUnsignedPartnerTerms(reminderHarness({ firstViewedAt: null }).deps, NOW)).sent, 0);
    assert.equal((await remindUnsignedPartnerTerms(reminderHarness({ signed: true }).deps, NOW)).sent, 0);
    assert.equal((await remindUnsignedPartnerTerms(reminderHarness({ enabled: false }).deps, NOW)).sent, 0);
  });
});
