import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCompanyLookup,
  joinDob,
  markEdited,
  newPrincipal,
  splitDob,
  stepNames,
  stepProblems,
  resumeStep,
  submitFailure,
  WORLDPAY_HELP_LINE,
} from '../src/worldpay/applicationLogic.ts';
import { worldpayAnswersDraftSchema } from '../services/api-sql/src/domain/worldpay-application/answers.ts';
import type { CompanyLookup } from '../src/shared/api.ts';

const company = (overrides: Partial<CompanyLookup> = {}): CompanyLookup => ({
  companyNumber: '01234567',
  companyName: 'EXAMPLE PHARMACY LIMITED',
  status: 'active',
  active: true,
  companyType: 'ltd',
  businessType: 'Ltd Co',
  incorporatedOn: '2012-04-02',
  registeredAddress: '1 Sample Street, Exampletown, EX1 2MP',
  people: [
    { roles: ['director', 'shareholder'], title: 'Mr', titleOther: '', firstNames: 'Alex James', surname: 'Sample', birthMonth: 5, birthYear: 1980, nationality: 'British', countryOfResidence: 'England', ownershipBand: '75-100' },
    { roles: ['director'], title: null, titleOther: '', firstNames: 'Jordan', surname: 'Specimen', birthMonth: 11, birthYear: 1985, nationality: 'British', countryOfResidence: 'England', ownershipBand: null },
  ],
  directors: [],
  notListed: [],
  noSignificantOwners: false,
  ...overrides,
});

const start = () => worldpayAnswersDraftSchema.parse({ business: { businessType: 'Limited company', legalName: 'Example Pharmacy Ltd' }, financials: { accountName: 'Example Pharmacy Ltd' } });

test('a lookup fills the company fields and starts the people list, one card per person', () => {
  const answers = applyCompanyLookup(start(), company());
  assert.equal(answers.business.legalName, 'EXAMPLE PHARMACY LIMITED', 'the first lookup replaces the name carried over from the Curaleaf form');
  assert.equal(answers.financials.accountName, 'EXAMPLE PHARMACY LIMITED', 'the name on the account follows it');
  assert.equal(answers.business.registeredAddress, '1 Sample Street, Exampletown, EX1 2MP');
  assert.equal(answers.business.tradingSince, '2012-04-02');
  assert.equal(answers.principals.length, 2);
  const [alex, jordan] = answers.principals;
  assert.deepEqual(alex?.roles, ['director', 'shareholder']);
  assert.equal(alex?.title, 'Mr');
  assert.equal(alex?.dateOfBirth, '1980-05-', 'month and year only; the day is left for the pharmacy');
  assert.equal(alex?.ownershipBand, '75-100');
  assert.equal(alex?.homeAddress, '', 'no correspondence address is ever copied into a home address');
  assert.equal(jordan?.fromCompaniesHouse, true);
  assert.deepEqual(answers.companyLookup?.filled.sort(), ['business.businessType', 'business.legalName', 'business.registeredAddress', 'business.tradingSince']);
});

test('the same number again loses nothing typed; a different number replaces only looked-up people', () => {
  let answers = applyCompanyLookup(start(), company());
  answers = { ...answers, principals: [{ ...answers.principals[0]!, dateOfBirth: '1980-05-14', homeAddress: '5 Demo Close, EX3 4DC' }, answers.principals[1]!, newPrincipal({ firstNames: 'Sam', surname: 'Typed', email: 'sam@example.test' })] };
  answers = markEdited({ ...answers, business: { ...answers.business, registeredAddress: '9 Typed Road, EX9 9TT' } }, 'business.registeredAddress');

  const again = applyCompanyLookup(answers, company());
  assert.equal(again.principals[0]?.homeAddress, '5 Demo Close, EX3 4DC');
  assert.equal(again.principals[0]?.dateOfBirth, '1980-05-14');
  assert.equal(again.principals.length, 3);
  assert.equal(again.business.registeredAddress, '9 Typed Road, EX9 9TT', 'a typed field is never replaced');

  const other = applyCompanyLookup(answers, company({ companyNumber: 'SC123456', companyName: 'OTHER LTD', people: [{ ...company().people[1]!, firstNames: 'Robin', surname: 'Other' }] }));
  assert.deepEqual(other.principals.map(person => person.surname), ['Other', 'Typed']);
  assert.equal(other.business.legalName, 'OTHER LTD', 'a looked-up name is replaced by the next lookup');
  assert.equal(other.business.registeredAddress, '9 Typed Road, EX9 9TT');
});

test('a lookup never clears the people when Companies House lists none', () => {
  const answers = { ...start(), principals: [newPrincipal({ firstNames: 'Pat', surname: 'Owner' })] };
  const looked = applyCompanyLookup(answers, company({ people: [], noSignificantOwners: true }));
  assert.deepEqual(looked.principals.map(person => person.surname), ['Owner']);
  assert.equal(looked.companyLookup?.noSignificantOwners, true);
});

test('dates of birth are three boxes stored as one date', () => {
  assert.equal(joinDob({ day: '4', month: '5', year: '1980' }), '1980-05-04');
  assert.equal(joinDob({ day: '', month: '5', year: '1980' }), '1980-05-');
  assert.equal(joinDob({ day: '', month: '', year: '' }), '');
  assert.deepEqual(splitDob('1980-05-04'), { day: '4', month: '5', year: '1980' });
  assert.deepEqual(splitDob('1980-05-'), { day: '', month: '5', year: '1980' });
});

test('each step checks only its own answers, and names change for sole traders and partnerships', () => {
  const answers = start();
  assert.deepEqual(stepProblems(answers, 0).map(problem => problem.path), ['existingAccount']);
  assert.ok(stepProblems(answers, 1).every(problem => problem.path.startsWith('business.')));
  assert.ok(stepProblems(answers, 3).every(problem => problem.path.startsWith('financials.')));
  assert.equal(stepNames({ ...answers, business: { ...answers.business, businessType: 'Sole trader' } })[2], 'Owner');
  assert.equal(stepNames({ ...answers, business: { ...answers.business, businessType: 'Partnership' } })[2], 'Partners');
});

test('a failed autosave never loops: refusals stop, server and network failures back off and then wait for an edit', async () => {
  const { nextSaveDelay } = await import('../src/worldpay/applicationLogic.ts');
  assert.deepEqual(nextSaveDelay({ status: 409, code: 'WORLDPAY_DRAFT_CONFLICT' }, 1), { kind: 'conflict' });
  assert.deepEqual(nextSaveDelay({ status: 409, code: 'WORLDPAY_APPLICATION_CONFLICT' }, 1), { kind: 'conflict' });
  assert.deepEqual(nextSaveDelay({ status: 400, code: 'VALIDATION_ERROR', message: 'Invalid UUID' }, 1), { kind: 'refused', message: 'Invalid UUID' });
  assert.equal(nextSaveDelay({ status: 403, code: 'FORBIDDEN', message: '' }, 1).kind, 'refused');
  assert.deepEqual(nextSaveDelay({ status: 429, code: 'RATE_LIMITED' }, 1), { kind: 'retry', retryIn: 5_000 });
  assert.deepEqual(nextSaveDelay({ status: 503 }, 2), { kind: 'retry', retryIn: 15_000 });
  assert.deepEqual(nextSaveDelay(null, 3), { kind: 'retry', retryIn: 60_000 });
  assert.deepEqual(nextSaveDelay(null, 4), { kind: 'retry', retryIn: null });
});

test('a refused submit never shows server text: only plain answer checks name fields (FB-11)', () => {
  // The case Shay saw: request validation, with a technical detail.
  assert.deepEqual(submitFailure({ status: 400, code: 'INVALID_INPUT', details: [{ path: 'id', message: 'Invalid UUID' }] }), { kind: 'help' });
  assert.deepEqual(submitFailure({ status: 500, code: 'INTERNAL' }), { kind: 'help' });
  assert.deepEqual(submitFailure(null), { kind: 'help' });
  assert.equal(WORLDPAY_HELP_LINE.includes('Invalid UUID'), false);
  assert.deepEqual(submitFailure({ status: 409, code: 'WORLDPAY_DRAFT_CONFLICT' }), { kind: 'conflict' });
  const fields = submitFailure({
    status: 422,
    code: 'WORLDPAY_APPLICATION_INCOMPLETE',
    details: [
      { path: 'financials.sortCode', message: 'Enter the sort code.' },
      { path: 'business.legalName', message: 'Enter the legal name of the business.' },
      { path: 'mystery', message: 'ignored' },
    ],
  });
  assert.equal(fields.kind, 'fields');
  if (fields.kind === 'fields') {
    assert.equal(fields.stepIndex, 1);
    assert.deepEqual(fields.problems.map(problem => problem.path), ['business.legalName']);
  }
});

test('a refused Worldpay account answer goes back to "Before you start"', () => {
  const failure = submitFailure({ status: 422, code: 'WORLDPAY_APPLICATION_INCOMPLETE', details: [{ path: 'existingAccount', message: 'Choose an answer.' }, { path: 'business.legalName', message: 'Enter it.' }] });
  assert.equal(failure.kind === 'fields' && failure.stepIndex, 0);
});

test('a draft reopens at the screen the pharmacy reached (FB-10)', () => {
  assert.equal(resumeStep({ existingAccount: 'no', lastStep: 3 }), 3);
  assert.equal(resumeStep({ existingAccount: 'no' }), 0);
  assert.equal(resumeStep({ existingAccount: '', lastStep: 3 }), 0);
  assert.equal(resumeStep({ existingAccount: 'online', lastStep: 3 }), 0);
  assert.equal(resumeStep({ existingAccount: 'no', lastStep: 9 }), 0);
});

import { worldpayStatusLine } from '../src/worldpay/statusLine.ts';

test('a form recorded as received by email reads as that to the pharmacy', () => {
  const base = { status: 'WITH_WORLDPAY' as const, submittedAt: '2026-11-10T12:00:00.000Z', contactName: '', contactEmail: '', statusNote: null };
  assert.equal(worldpayStatusLine({ ...base, receivedByEmail: true }), 'We received your Worldpay form by email on 10 November 2026 and passed it to Worldpay.');
  assert.match(worldpayStatusLine({ ...base, receivedByEmail: false })!, /^Application sent on 10 November 2026/);
});
