import test from 'node:test';
import assert from 'node:assert/strict';
import { curaleafFieldsFromCompany, monthYear, worldpayFromCompany } from '../src/auth/company-prefill.ts';
import { worldpayPrincipalsFrom, worldpayStartFromWelcome } from '../src/auth/worldpay-start.ts';
import type { CompanyLookup } from '../src/shared/api.ts';
import type { PharmsmartWelcome } from '../src/auth/types.ts';

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

const welcome = {
  email: 'priya@example.test',
  firstName: 'Priya',
  lastName: 'Shah',
  gphcNumber: '1234567',
  prefill: {
    registeredCompanyName: 'Shah Health Ltd',
    pharmacyName: 'Shah Pharmacy',
    superintendentFirstName: 'Priya',
    superintendentLastName: 'SHAH',
    superintendentEmail: 'priya@example.test',
    superintendentPhone: '07700900000',
  },
} as unknown as PharmsmartWelcome;

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

test('the company carries into the Worldpay form', () => {
  const start = worldpayStartFromWelcome(welcome, null, company);
  assert.equal(start.legalName, 'SHAH HEALTH LIMITED');
  assert.equal(start.businessType, 'Ltd Co');
  assert.equal(start.registrationNumber, '01234567');
  assert.equal(start.tradingSince, 'March 2015');
  assert.equal(start.registeredAddress, '12 High Street, Leicester, LE1 1AA');
  // The Curaleaf form's name, as sent, still wins over the register's.
  assert.equal(worldpayStartFromWelcome(welcome, { registeredCompanyName: 'Shah Healthcare Group Ltd' }, company).legalName, 'Shah Healthcare Group Ltd');
  // Without a lookup nothing new appears.
  const plain = worldpayStartFromWelcome(welcome, null);
  assert.equal(plain.registrationNumber, undefined);
  assert.equal(plain.businessType, undefined);
});

test('directors become the principals, and the superintendent lends their contact details to their own row', () => {
  const principals = worldpayPrincipalsFrom(welcome, company);
  assert.equal(principals.length, 2);
  assert.deepEqual(principals[0], {
    firstNames: 'Priya Anjali', surname: 'Shah', nationality: 'British', countryOfResidence: 'England',
    email: 'priya@example.test', mobile: '07700900000',
  });
  assert.equal(principals[1].email, undefined);
  assert.equal(worldpayPrincipalsFrom(welcome, company, 1).length, 1);
  // No lookup: the superintendent starts alone, as before.
  assert.deepEqual(worldpayPrincipalsFrom(welcome, null), [{ firstNames: 'Priya', surname: 'SHAH', email: 'priya@example.test', mobile: '07700900000' }]);
});

test('incorporation dates read as month and year', () => {
  assert.equal(monthYear('2015-03-02'), 'March 2015');
  assert.equal(monthYear('1999-12-31'), 'December 1999');
  assert.equal(monthYear(null), undefined);
  assert.equal(monthYear('2015'), undefined);
});

const BLANK = { title: '', firstNames: '', surname: '', nationality: '', countryOfResidence: 'United Kingdom', email: '', mobile: '' };
const business = { legalName: '', businessType: '', registrationNumber: '', registeredAddress: '', tradingSince: '', accountName: '', tradingName: 'Shah Pharmacy' };

test('a Worldpay lookup fills every business field the register holds, and the directors', () => {
  const result = worldpayFromCompany({
    fields: business, startFields: business, principals: [{ ...BLANK }], startPrincipals: [{ ...BLANK }],
    blankPrincipal: BLANK, company, max: 4,
  });
  assert.deepEqual(
    { ...result.fields },
    { legalName: 'SHAH HEALTH LIMITED', businessType: 'Ltd Co', registrationNumber: '01234567', registeredAddress: '12 High Street, Leicester, LE1 1AA', tradingSince: 'March 2015', accountName: 'SHAH HEALTH LIMITED', tradingName: 'Shah Pharmacy' },
  );
  assert.deepEqual(result.principals.map(p => [p.firstNames, p.surname, p.nationality, p.countryOfResidence]), [
    ['Priya Anjali', 'Shah', 'British', 'England'],
    ['Sam', 'Patel', 'British', 'United Kingdom'],
  ]);
  assert.deepEqual(result.filled, ['Legal name', 'Business type', 'Company registration number', 'Registered address', 'Trading since', 'Name on account', '2 directors as principals']);
});

test('a Worldpay lookup keeps what the pharmacy changed, and merges into a principal already there', () => {
  const opened = { ...business, legalName: 'Shah Health Ltd', accountName: 'Shah Health Ltd', registeredAddress: '1 Old Road' };
  const changed = { ...opened, registeredAddress: '99 Their Own Road', accountName: 'Shah Health Ltd' };
  const superintendent = { ...BLANK, firstNames: 'Priya', surname: 'SHAH', email: 'priya@example.test', mobile: '07700900000' };
  const typed = { ...BLANK, firstNames: 'Sam', surname: 'Patel', nationality: 'Indian', email: 'sam@example.test' };
  const result = worldpayFromCompany({
    fields: changed, startFields: opened, principals: [superintendent, typed], startPrincipals: [superintendent],
    blankPrincipal: BLANK, company, max: 4,
  });
  assert.equal(result.fields.legalName, 'SHAH HEALTH LIMITED');
  assert.equal(result.fields.accountName, 'SHAH HEALTH LIMITED');
  assert.equal(result.fields.registeredAddress, '99 Their Own Road');
  // Priya is a director: she keeps PharmSmart's contact details and gains her nationality.
  assert.deepEqual(result.principals[0], { ...superintendent, nationality: 'British' });
  // Sam typed his own nationality; it stays.
  assert.equal(result.principals[1].nationality, 'Indian');
  assert.equal(result.principals[1].email, 'sam@example.test');
  assert.equal(result.principals.length, 2);
});

test('an untouched superintendent who is not a director gives way to the directors; an edited one stays', () => {
  const superintendent = { ...BLANK, firstNames: 'Alex', surname: 'Jones', email: 'alex@example.test' };
  const run = (rows: typeof BLANK[]) => worldpayFromCompany({
    fields: business, startFields: business, principals: rows, startPrincipals: [superintendent],
    blankPrincipal: BLANK, company, max: 4,
  }).principals.map(p => p.surname);
  assert.deepEqual(run([superintendent]), ['Shah', 'Patel']);
  assert.deepEqual(run([{ ...superintendent, mobile: '07700900001' }]), ['Jones', 'Shah', 'Patel']);
  // Never more than the form allows.
  assert.equal(worldpayFromCompany({
    fields: business, startFields: business, principals: [{ ...BLANK }], startPrincipals: [{ ...BLANK }],
    blankPrincipal: BLANK, company, max: 1,
  }).principals.length, 1);
});
