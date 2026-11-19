import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  CURALEAF_FIELD_RULES,
  curaleafFormProblems,
  curaleafProblemsFromServer,
  describeCuraleafProblems,
} from '../src/auth/curaleafFormRules.ts';

const valid = {
  pharmacistName: 'Amina Khan',
  pharmacyName: 'Eastwood Health',
  registeredCompanyName: 'Eastwood Health Ltd',
  invoiceAddress: '1 High Street, Leeds, LS1 1AA',
  deliveryAddress: '2 High Street, Leeds, LS1 1AB',
  gphcNumber: '2078912',
  pharmacyEmail: 'pharmacy@eastwood.co.uk',
  accountsEmail: 'accounts@eastwood.co.uk',
  pharmacyPhone: '0113 000 0000',
  accountsPhone: '0113 000 0001',
  faxNumber: '',
};

test('a complete form has no problems', () => {
  assert.deepEqual(curaleafFormProblems(valid), []);
});

test('the browser-accepted values the server refuses are caught before sending', () => {
  const problems = curaleafFormProblems({ ...valid, accountsPhone: '0113 22', pharmacyEmail: 'shop@eastwood', invoiceAddress: 'LS1 ' });
  assert.deepEqual(problems.map(item => item.field), ['invoiceAddress', 'pharmacyEmail', 'accountsPhone']);
  assert.equal(
    describeCuraleafProblems(problems),
    'Check these fields: Invoice address needs at least 5 characters; Pharmacy email isn\'t a full email address (for example name@pharmacy.co.uk); Accounts telephone needs at least 8 characters.',
  );
});

test('values are checked trimmed, as the server trims them', () => {
  assert.deepEqual(curaleafFormProblems({ ...valid, pharmacyPhone: '  1234567  ' }).map(item => item.field), ['pharmacyPhone']);
  assert.deepEqual(curaleafFormProblems({ ...valid, faxNumber: '   ' }), [], 'fax is optional');
});

test('a 400 from the server names the fields in the form\'s own words', () => {
  const issues = [
    { path: 'accountsPhone', message: 'Too small: expected string to have >=8 characters' },
    { path: 'accountsPhone', message: 'duplicate' },
    { path: 'somethingNew', message: 'Required' },
  ];
  const named = curaleafProblemsFromServer(issues, { ...valid, accountsPhone: '0113' });
  assert.equal(describeCuraleafProblems(named), 'Check these fields: Accounts telephone needs at least 8 characters; somethingNew Required.');
  assert.equal(describeCuraleafProblems([{ field: 'gphcNumber', problem: 'is missing' }]), 'Check this field: GPhC premises number is missing.');
});

test('the form rules match the server schema', () => {
  const server = readFileSync(new URL('../services/api-sql/src/domain/pharmacy-onboarding/request.ts', import.meta.url), 'utf8');
  for (const [field, rule] of Object.entries(CURALEAF_FIELD_RULES)) {
    if (field === 'faxNumber') {
      assert.match(server, /optionalFax = z\.string\(\)\.trim\(\)\.max\(40\)/);
      continue;
    }
    const line = new RegExp(`${field}: z\\.string\\(\\)\\.trim\\(\\)(?:\\.min\\((\\d+)\\))?(\\.email\\(\\))?\\.max\\((\\d+)\\)`).exec(server);
    assert.ok(line, `${field} is in the server schema`);
    if (rule.email) assert.ok(line[2], `${field} is an email on the server too`);
    else assert.equal(Number(line[1]), rule.min, `${field} minimum`);
    assert.equal(Number(line[3]), rule.max, `${field} maximum`);
  }
});

test('the Curaleaf, Terms and Worldpay forms show which fields the server refused', () => {
  const curaleaf = readFileSync(new URL('../src/auth/CuraleafAccountForm.tsx', import.meta.url), 'utf8');
  assert.match(curaleaf, /curaleafFormProblems\(fields\)/);
  assert.match(curaleaf, /curaleafProblemsFromServer\(cause\.details, fields\)/);
  assert.match(readFileSync(new URL('../src/auth/PartnerTermsForm.tsx', import.meta.url), 'utf8'), /describeApiError\(cause,/, 'PartnerTermsForm.tsx');
  // The Worldpay application runs the server's own rules before each step. A refused submit goes
  // back to the step concerned with the server's plain answer checks, never its raw text (FB-11).
  const worldpay = readFileSync(new URL('../src/worldpay/WorldpayApplicationForm.tsx', import.meta.url), 'utf8');
  assert.match(worldpay, /stepProblems\(answers, step\)/);
  assert.match(worldpay, /submitFailure\(error instanceof ApiRequestError \? error : null\)/);
  assert.doesNotMatch(worldpay, /error\.details\.map\(/);
});
