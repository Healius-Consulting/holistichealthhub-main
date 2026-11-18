import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { HttpError } from '../../domain/common/errors.js';
import { submitWorldpayForm, type WorldpayNoteRepository } from './submit-worldpay.js';
import { worldpaySections } from './worldpay-pdf.js';
import { WORLDPAY_DEFAULTS, worldpayFormSchema, type WorldpaySubmissionNote } from '../../domain/pharmacy-onboarding/worldpay.js';
import type { ImmediateEmail } from '../workers/deliver-messages.js';

function sample(overrides: Record<string, unknown> = {}) {
  return worldpayFormSchema.parse({
    ...WORLDPAY_DEFAULTS,
    legalName: 'Shah Health Ltd',
    tradingName: 'Shah Pharmacy',
    contactName: 'Asha Shah',
    contactPosition: 'Superintendent',
    contactPhone: '07700 900123',
    businessType: 'Ltd Co',
    registeredAddress: '1 High Street, Leeds, LS1 1AA',
    gphcNumber: '123 4567',
    tradingAddress: '1 High Street, Leeds, LS1 1AA',
    businessEmail: 'shop@shah.test',
    principals: [{
      firstNames: 'Asha', surname: 'Shah', dateOfBirth: '1980-04-02', nationality: 'British',
      homeAddress: '2 Low Road, Leeds, LS2 2BB', countryOfResidence: 'United Kingdom', yearsAtAddress: '6',
      mobile: '07700 900123', email: 'asha@shah.test', shareholding: '100',
    }],
    annualTurnover: '1200000',
    bankName: 'Example Bank',
    accountName: 'Shah Health Ltd',
    accountNumber: '1234 5678',
    sortCode: '12-34-56',
    idempotencyKey: 'worldpay-key-1',
    ...overrides,
  });
}

function memory(termsAcceptedFor: string[] = ['1234567']) {
  const notes: WorldpaySubmissionNote[] = [];
  const sent: ImmediateEmail[] = [];
  const repo: WorldpayNoteRepository = {
    async findWorldpaySubmissionByIdempotencyKey(key) { return notes.find(note => note.idempotencyKey === key) ?? null; },
    async insertWorldpaySubmission(note) { notes.push(note); },
    async hasAcceptedTermsForGphc(gphcNumber) { return termsAcceptedFor.includes(gphcNumber); },
  };
  return { notes, sent, repo, send: async (email: ImmediateEmail) => { sent.push(email); } };
}

test('emails the Worldpay form as a PDF to the admin inbox only, and keeps only a note', async () => {
  const { notes, sent, repo, send } = memory();
  await submitWorldpayForm(repo, send, sample(), new Date('2026-11-16T10:00:00Z'));
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.to, ['admin@healiusconsulting.com']);
  assert.equal(sent[0]!.templateCode, 'admin_worldpay_form_submitted');
  const attachment = sent[0]!.attachments[0]!;
  assert.equal(attachment.contentType, 'application/pdf');
  assert.equal(attachment.filename, 'worldpay-shah-pharmacy.pdf');
  const pdf = await PDFDocument.load(attachment.content);
  assert.ok(pdf.getPageCount() >= 1);
  // The email body names the pharmacy but carries no bank or identity details.
  assert.equal(JSON.stringify(sent[0]!.payload).includes('12345678'), false);
  assert.equal(JSON.stringify(sent[0]!.payload).includes('1980'), false);
  // The stored note has no form answers in it.
  assert.deepEqual(Object.keys(notes[0]!).sort(), ['gphcNumber', 'id', 'idempotencyKey', 'submittedAt', 'tradingName']);
  assert.equal(notes[0]!.gphcNumber, '1234567');
});

test('refuses the Worldpay form until the Curaleaf form is in and the Partner Terms are accepted', async () => {
  const { notes, sent, repo, send } = memory([]);
  await assert.rejects(
    submitWorldpayForm(repo, send, sample()),
    (error: unknown) => error instanceof HttpError && error.statusCode === 409 && error.code === 'ONBOARDING_TERMS_REQUIRED',
  );
  assert.equal(sent.length, 0);
  assert.equal(notes.length, 0);
});

test('from the portal, a branch whose Terms were accepted there sends the form under its own GPhC and id', async () => {
  const { notes, sent, repo, send } = memory([]);
  const branch = { organisationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', gphcNumber: '765 4321' };
  repo.findTermsAcceptancesForOrganisation = async id => (id === branch.organisationId ? [{ id: 'terms-1' }] : []);
  // The form's own GPhC box is ignored: the branch's account says which pharmacy this is.
  await submitWorldpayForm(repo, send, sample({ gphcNumber: '111 1111' }), new Date('2026-11-18T10:00:00Z'), branch);
  assert.equal(sent.length, 1);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.gphcNumber, '7654321');
  assert.equal(notes[0]!.organisationId, branch.organisationId);
  assert.equal((sent[0]!.payload as { gphcNumber: string }).gphcNumber, '7654321');
});

test('from the portal, a branch with no accepted Terms is still refused', async () => {
  const { notes, sent, repo, send } = memory([]);
  repo.findTermsAcceptancesForOrganisation = async () => [];
  await assert.rejects(
    submitWorldpayForm(repo, send, sample(), new Date(), { organisationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', gphcNumber: '7654321' }),
    (error: unknown) => error instanceof HttpError && error.code === 'ONBOARDING_TERMS_REQUIRED',
  );
  assert.equal(sent.length, 0);
  assert.equal(notes.length, 0);
});

test('from the portal, Terms accepted on the onboarding page under the GPhC count too', async () => {
  const { notes, repo, send } = memory(['7654321']);
  await submitWorldpayForm(repo, send, sample(), new Date(), { organisationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', gphcNumber: '765 4321' });
  assert.equal(notes.length, 1);
});

test('a retry with the same key sends nothing more', async () => {
  const { notes, sent, repo, send } = memory();
  await submitWorldpayForm(repo, send, sample());
  await submitWorldpayForm(repo, send, sample());
  assert.equal(sent.length, 1);
  assert.equal(notes.length, 1);
});

test('stores no note when the email fails, so the pharmacy can try again', async () => {
  const { notes, repo } = memory();
  await assert.rejects(submitWorldpayForm(repo, async () => { throw new Error('provider down'); }, sample()));
  assert.equal(notes.length, 0);
});

test('rejects percentages that do not add up to 100 and bad bank numbers', () => {
  assert.throws(() => sample({ internetPercent: 90 }), /100%/);
  assert.throws(() => sample({ accountNumber: '1234' }), /8-digit/);
  assert.throws(() => sample({ sortCode: '12-34' }), /6-digit/);
  assert.throws(() => sample({ principals: [] }));
});

test('lays the PDF out in the spreadsheet order with every principal', () => {
  const form = sample({
    principals: [
      ...sample().principals,
      { ...sample().principals[0]!, firstNames: 'Ravi', shareholding: '50%' },
    ],
  });
  const titles = worldpaySections(form).map(section => section.title);
  assert.deepEqual(titles, ['About your business', 'Principal 1', 'Principal 2', 'Nature of transactions', 'Financials', 'Visa / Mastercard additional information']);
  const financials = worldpaySections(form).find(section => section.title === 'Financials')!;
  assert.deepEqual(financials.rows.find(([label]) => label === 'Sort code'), ['Sort code', '12-34-56']);
});
