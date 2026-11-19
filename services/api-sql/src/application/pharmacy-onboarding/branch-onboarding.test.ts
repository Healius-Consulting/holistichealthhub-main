import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from '../../domain/common/errors.js';
import type { PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';
import { branchPartnerTermsAcceptanceSchema, type PartnerTermsAcceptanceRecord } from '../../domain/pharmacy-onboarding/terms.js';
import type { WorldpaySubmissionNote } from '../../domain/pharmacy-onboarding/worldpay.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import { acceptBranchPartnerTerms, branchOnboardingView, type BranchOnboardingRepo } from './branch-onboarding.js';
import type { PartnerTermsState } from './partner-terms.service.js';

const BRANCH_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const branch = (overrides: Partial<OrganisationRecord> = {}) => ({
  id: BRANCH_ID,
  status: 'ONBOARDING',
  gphcNumber: '765 4321',
  name: 'Shah Pharmacy',
  tradingName: 'Shah Health Ltd',
  ...overrides,
}) as OrganisationRecord;

const request = (overrides: Partial<PharmacyOnboardingRequestRecord> = {}) => ({
  id: 'req-1',
  status: 'ACTIVATED',
  registeredCompanyName: 'Shah Health Limited',
  gphcNumber: '7654321',
  organisationId: BRANCH_ID,
  createdAt: '2026-11-19T14:05:00.000Z',
  ...overrides,
}) as PharmacyOnboardingRequestRecord;

const signer = branchPartnerTermsAcceptanceSchema.parse({
  signerName: 'Asha Shah',
  signerRole: 'SUPERINTENDENT_PHARMACIST',
  signerEmail: 'Asha@Shah.test',
  signerGphcNumber: '201 2345',
  authorised: true,
});

function memory(input: { request?: PharmacyOnboardingRequestRecord | null; terms?: PartnerTermsAcceptanceRecord[]; worldpay?: WorldpaySubmissionNote[] } = {}) {
  const terms = [...(input.terms ?? [])];
  const worldpay = [...(input.worldpay ?? [])];
  const repo: BranchOnboardingRepo = {
    async findByOrganisationId(id) { return input.request && input.request.organisationId === id ? input.request : null; },
    async findTermsAcceptances(requestId) { return terms.filter(row => row.onboardingRequestId === requestId); },
    async findTermsAcceptancesForOrganisation(id) { return terms.filter(row => row.organisationId === id); },
    async hasAcceptedTermsForGphc(gphc) {
      return Boolean(input.request && input.request.gphcNumber === gphc && terms.some(row => row.onboardingRequestId === input.request!.id));
    },
    async findWorldpaySubmissionForBranch(id, gphc) {
      return worldpay.filter(note => note.organisationId === id || note.gphcNumber === gphc).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0] ?? null;
    },
    async insertTermsAcceptance(row) { terms.push({ organisationId: null, ...row }); },
  };
  return { repo, terms, worldpay };
}

const acceptance = (overrides: Partial<PartnerTermsAcceptanceRecord> = {}): PartnerTermsAcceptanceRecord => ({
  id: 'terms-1',
  onboardingRequestId: 'req-1',
  organisationId: BRANCH_ID,
  termsVersion: '2026-11-draft',
  signerName: 'Asha Shah',
  signerRole: 'DIRECTOR',
  signerRoleOther: null,
  signerEmail: 'asha@shah.test',
  signerGphcNumber: null,
  registeredCompanyName: 'Shah Health Limited',
  acceptedAt: '2026-11-19T14:10:00.000Z',
  ipAddress: null,
  source: 'signup',
  nameMatchesPharmsmart: null,
  ...overrides,
});

const DOC_V1 = '11111111-1111-4111-8111-111111111111';
const DOC_V2 = '22222222-2222-4222-8222-222222222222';
const termsDoc = (id: string, version: string) => ({
  id, version, storagePath: `partner-terms/${id}.pdf`, filename: `${version}.pdf`, sizeBytes: 10, uploadedAt: '2026-11-19T09:00:00Z',
  uploadedByUid: 'admin', publishedAt: '2026-11-19T09:05:00Z', publishedByUid: 'admin', withdrawnAt: null, withdrawnByUid: null,
});
const TERMS_OFF: PartnerTermsState = { settings: { enabled: false, currentDocumentId: null }, document: null, on: false };
const termsOn = (id = DOC_V1, version = 'v1.0'): PartnerTermsState => ({ settings: { enabled: true, currentDocumentId: id }, document: termsDoc(id, version), on: true });
const V1 = { version: 'v1.0', documentId: DOC_V1 };

test('a branch awaiting Curaleaf with everything done shows the submission, Terms and Worldpay dates', async () => {
  const { repo } = memory({
    request: request(),
    terms: [acceptance({ documentId: DOC_V1, termsVersion: 'v1.0' })],
    worldpay: [{ id: 'wp-1', gphcNumber: '7654321', tradingName: 'Shah Pharmacy', submittedAt: '2026-11-19T14:20:00.000Z', idempotencyKey: 'k1' }],
  });
  assert.deepEqual(await branchOnboardingView(repo, branch(), termsOn()), {
    live: false,
    submittedAt: '2026-11-19T14:05:00.000Z',
    termsRequired: true,
    currentTerms: { documentId: DOC_V1, version: 'v1.0' },
    termsAccepted: true,
    termsAcceptedAt: '2026-11-19T14:10:00.000Z',
    worldpaySubmittedAt: '2026-11-19T14:20:00.000Z',
    registeredCompanyName: 'Shah Health Limited',
  });
});

test('a branch HHH added by hand has no submission date, no Terms and no Worldpay yet', async () => {
  const { repo } = memory({ request: null });
  assert.deepEqual(await branchOnboardingView(repo, branch({ status: 'LIVE' }), termsOn()), {
    live: true,
    submittedAt: null,
    termsRequired: true,
    currentTerms: { documentId: DOC_V1, version: 'v1.0' },
    termsAccepted: false,
    termsAcceptedAt: null,
    worldpaySubmittedAt: null,
    registeredCompanyName: 'Shah Health Ltd',
  });
});

test('an older branch with no request accepts the Terms from its portal', async () => {
  const { repo, terms } = memory({ request: null });
  const { acceptance: row, created } = await acceptBranchPartnerTerms(
    { repo, terms: V1 },
    branch(),
    signer,
    { ipHash: 'hash', now: new Date('2026-11-20T09:00:00Z') },
  );
  assert.equal(created, true);
  assert.equal(row.organisationId, BRANCH_ID);
  assert.equal(row.onboardingRequestId, null);
  assert.equal(row.registeredCompanyName, 'Shah Health Ltd');
  assert.equal(row.signerEmail, 'asha@shah.test');
  assert.equal(row.signerGphcNumber, '2012345');
  assert.equal(row.source, 'reacceptance');
  assert.equal(row.documentId, DOC_V1);
  assert.equal(row.nameMatchesPharmsmart, null);
  assert.equal(terms.length, 1);

  const view = await branchOnboardingView(repo, branch(), termsOn());
  assert.equal(view.termsAccepted, true);
});

test('a public-page pharmacy that left before the Terms accepts them against its request from the portal', async () => {
  const { repo, terms } = memory({ request: request() });
  const { acceptance: row } = await acceptBranchPartnerTerms({ repo, terms: V1 }, branch(), signer, { ipHash: null });
  assert.equal(row.onboardingRequestId, 'req-1');
  assert.equal(row.organisationId, BRANCH_ID);
  assert.equal(row.registeredCompanyName, 'Shah Health Limited');
  assert.equal(terms.length, 1);
});

test('signing the same version again returns the signature already there and writes nothing', async () => {
  const { repo, terms } = memory({ request: request(), terms: [acceptance({ organisationId: null, documentId: DOC_V1 })] });
  const result = await acceptBranchPartnerTerms({ repo, terms: V1 }, branch(), signer, { ipHash: null });
  assert.equal(result.created, false);
  assert.equal(result.acceptance.id, 'terms-1');
  assert.equal(terms.length, 1);
});

test('a new version needs a new signature, even after signing an earlier one', async () => {
  const { repo, terms } = memory({ request: request(), terms: [acceptance({ documentId: DOC_V1 })] });
  const before = await branchOnboardingView(repo, branch(), termsOn(DOC_V2, 'v2.0'));
  assert.equal(before.termsAccepted, false, 'v1 does not cover v2');
  const result = await acceptBranchPartnerTerms({ repo, terms: { version: 'v2.0', documentId: DOC_V2 } }, branch(), signer, { ipHash: null });
  assert.equal(result.created, true);
  assert.equal(terms.length, 2);
  assert.equal((await branchOnboardingView(repo, branch(), termsOn(DOC_V2, 'v2.0'))).termsAccepted, true);
});

test('while the Terms are off nothing waits on them, and signing is refused', async () => {
  const { repo, terms } = memory({ request: null });
  const view = await branchOnboardingView(repo, branch(), TERMS_OFF);
  assert.equal(view.termsRequired, false);
  assert.equal(view.currentTerms, null);
  assert.equal(view.termsAccepted, true);
  await assert.rejects(
    acceptBranchPartnerTerms({ repo, terms: null }, branch(), signer, { ipHash: null }),
    (error: unknown) => error instanceof HttpError && error.code === 'PARTNER_TERMS_OFF',
  );
  assert.equal(terms.length, 0);
});

test('a suspended or held branch cannot accept the Terms', async () => {
  for (const status of ['PAUSED', 'ON_HOLD'] as const) {
    const { repo, terms } = memory({ request: null });
    await assert.rejects(
      acceptBranchPartnerTerms({ repo, terms: V1 }, branch({ status }), signer, { ipHash: null }),
      (error: unknown) => error instanceof HttpError && error.code === 'TERMS_NOT_ALLOWED',
    );
    assert.equal(terms.length, 0);
  }
});

test('the portal Terms need the declaration, and a pharmacist signer needs their GPhC number', () => {
  assert.throws(() => branchPartnerTermsAcceptanceSchema.parse({ ...signer, authorised: false }));
  assert.throws(() => branchPartnerTermsAcceptanceSchema.parse({ ...signer, signerGphcNumber: '' }));
  // The branch comes from the session, never from the body.
  assert.throws(() => branchPartnerTermsAcceptanceSchema.parse({ ...signer, onboardingRequestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab' }));
});
