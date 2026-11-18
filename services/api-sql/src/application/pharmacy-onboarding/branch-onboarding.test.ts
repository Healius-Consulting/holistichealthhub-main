import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpError } from '../../domain/common/errors.js';
import type { PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';
import { branchPartnerTermsAcceptanceSchema, type PartnerTermsAcceptanceRecord } from '../../domain/pharmacy-onboarding/terms.js';
import type { WorldpaySubmissionNote } from '../../domain/pharmacy-onboarding/worldpay.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import { acceptBranchPartnerTerms, branchOnboardingView, type BranchOnboardingRepo } from './branch-onboarding.js';
import { submitWorldpayForm } from './submit-worldpay.js';
import { WORLDPAY_DEFAULTS, worldpayFormSchema } from '../../domain/pharmacy-onboarding/worldpay.js';

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
  const repo: BranchOnboardingRepo & {
    findWorldpaySubmissionByIdempotencyKey(key: string): Promise<WorldpaySubmissionNote | null>;
    insertWorldpaySubmission(note: WorldpaySubmissionNote): Promise<void>;
  } = {
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
    async findWorldpaySubmissionByIdempotencyKey(key) { return worldpay.find(note => note.idempotencyKey === key) ?? null; },
    async insertWorldpaySubmission(note) { worldpay.push(note); },
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
  signerEmail: 'asha@shah.test',
  signerGphcNumber: null,
  registeredCompanyName: 'Shah Health Limited',
  acceptedAt: '2026-11-19T14:10:00.000Z',
  ipAddress: null,
  source: 'signup',
  nameMatchesPharmsmart: null,
  ...overrides,
});

test('a branch awaiting Curaleaf with everything done shows the submission, Terms and Worldpay dates', async () => {
  const { repo } = memory({
    request: request(),
    terms: [acceptance()],
    worldpay: [{ id: 'wp-1', gphcNumber: '7654321', tradingName: 'Shah Pharmacy', submittedAt: '2026-11-19T14:20:00.000Z', idempotencyKey: 'k1' }],
  });
  assert.deepEqual(await branchOnboardingView(repo, branch()), {
    live: false,
    submittedAt: '2026-11-19T14:05:00.000Z',
    termsAccepted: true,
    termsAcceptedAt: '2026-11-19T14:10:00.000Z',
    worldpaySubmittedAt: '2026-11-19T14:20:00.000Z',
    registeredCompanyName: 'Shah Health Limited',
  });
});

test('a branch HHH added by hand has no submission date, no Terms and no Worldpay yet', async () => {
  const { repo } = memory({ request: null });
  assert.deepEqual(await branchOnboardingView(repo, branch({ status: 'LIVE' })), {
    live: true,
    submittedAt: null,
    termsAccepted: false,
    termsAcceptedAt: null,
    worldpaySubmittedAt: null,
    registeredCompanyName: 'Shah Health Ltd',
  });
});

test('an older branch with no request accepts the Terms from its portal, then its Worldpay form goes through', async () => {
  const { repo, terms, worldpay } = memory({ request: null });
  const form = worldpayFormSchema.parse({
    ...WORLDPAY_DEFAULTS,
    legalName: 'Shah Health Ltd', tradingName: 'Shah Pharmacy', contactName: 'Asha Shah', contactPosition: 'Owner',
    contactPhone: '07700 900123', businessType: 'Ltd Co', registeredAddress: '1 High Street, Leeds, LS1 1AA',
    gphcNumber: '765 4321', tradingAddress: '1 High Street, Leeds, LS1 1AA', businessEmail: 'shop@shah.test',
    principals: [{
      firstNames: 'Asha', surname: 'Shah', dateOfBirth: '1980-04-02', nationality: 'British',
      homeAddress: '2 Low Road, Leeds, LS2 2BB', countryOfResidence: 'United Kingdom', yearsAtAddress: '6',
      mobile: '07700 900123', email: 'asha@shah.test', shareholding: '100',
    }],
    annualTurnover: '1200000', bankName: 'Example Bank', accountName: 'Shah Health Ltd', accountNumber: '12345678',
    sortCode: '123456', idempotencyKey: 'portal-worldpay-1',
  });
  const forBranch = { organisationId: BRANCH_ID, gphcNumber: '765 4321' };
  const send = async () => {};

  await assert.rejects(
    submitWorldpayForm(repo, send, form, new Date(), forBranch),
    (error: unknown) => error instanceof HttpError && error.code === 'ONBOARDING_TERMS_REQUIRED',
  );

  const { acceptance: row, created } = await acceptBranchPartnerTerms(
    { repo, termsVersion: '2026-11-draft' },
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
  assert.equal(row.source, 'signup');
  assert.equal(row.nameMatchesPharmsmart, null);
  assert.equal(terms.length, 1);

  await submitWorldpayForm(repo, send, form, new Date('2026-11-20T09:05:00Z'), forBranch);
  assert.equal(worldpay[0]!.organisationId, BRANCH_ID);
  const view = await branchOnboardingView(repo, branch());
  assert.equal(view.termsAccepted, true);
  assert.equal(view.worldpaySubmittedAt, '2026-11-20T09:05:00.000Z');
});

test('a public-page pharmacy that left before the Terms accepts them against its request from the portal', async () => {
  const { repo, terms } = memory({ request: request() });
  const { acceptance: row } = await acceptBranchPartnerTerms({ repo, termsVersion: 'v1' }, branch(), signer, { ipHash: null });
  assert.equal(row.onboardingRequestId, 'req-1');
  assert.equal(row.organisationId, BRANCH_ID);
  assert.equal(row.registeredCompanyName, 'Shah Health Limited');
  assert.equal(terms.length, 1);
});

test('accepting again returns the Terms already there and writes nothing', async () => {
  const { repo, terms } = memory({ request: request(), terms: [acceptance({ organisationId: null })] });
  const result = await acceptBranchPartnerTerms({ repo, termsVersion: 'v2' }, branch(), signer, { ipHash: null });
  assert.equal(result.created, false);
  assert.equal(result.acceptance.id, 'terms-1');
  assert.equal(terms.length, 1);
});

test('a suspended or Not available branch cannot accept the Terms', async () => {
  for (const status of ['PAUSED', 'NOT_AVAILABLE'] as const) {
    const { repo, terms } = memory({ request: null });
    await assert.rejects(
      acceptBranchPartnerTerms({ repo, termsVersion: 'v1' }, branch({ status }), signer, { ipHash: null }),
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
