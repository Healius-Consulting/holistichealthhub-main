import test from 'node:test';
import assert from 'node:assert/strict';
import { curaleafFieldsFromCompany } from '../src/auth/company-prefill.ts';
import type { CompanyLookup } from '../src/shared/api.ts';

const company: CompanyLookup = {
  companyNumber: '01234567',
  companyName: 'SHAH HEALTH LIMITED',
  status: 'active',
  active: true,
  businessType: 'Ltd Co',
  incorporatedOn: '2015-03-02',
  registeredAddress: '12 High Street, Leicester, LE1 1AA',
  directors: [
    { firstNames: 'Priya Anjali', surname: 'Shah', nationality: 'British', countryOfResidence: 'England' },
    { firstNames: 'Sam', surname: 'Patel', nationality: 'British', countryOfResidence: 'United Kingdom' },
  ],
};

test('Companies House replaces the PharmSmart company name, and fills an empty invoice address', () => {
  const pharmsmart = { registeredCompanyName: 'Shah Health Ltd', invoiceAddress: '' };
  const result = curaleafFieldsFromCompany({ ...pharmsmart, pharmacyName: 'Shah Pharmacy' }, pharmsmart, company);
  assert.deepEqual(result.filled, ['registeredCompanyName', 'invoiceAddress']);
  assert.equal(result.fields.registeredCompanyName, 'SHAH HEALTH LIMITED');
  assert.equal(result.fields.invoiceAddress, '12 High Street, Leicester, LE1 1AA');
  assert.equal(result.fields.pharmacyName, 'Shah Pharmacy');
});

test('what the pharmacy typed, and an invoice address already there, are kept', () => {
  const pharmsmart = { registeredCompanyName: 'Shah Health Ltd', invoiceAddress: '1 Accountant Row, Leicester' };
  const typed = { registeredCompanyName: 'Shah Healthcare Group Ltd', invoiceAddress: pharmsmart.invoiceAddress };
  const result = curaleafFieldsFromCompany(typed, pharmsmart, company);
  assert.deepEqual(result.filled, []);
  assert.deepEqual(result.fields, typed);
});
