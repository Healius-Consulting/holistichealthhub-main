import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applicationWebsite,
  HHH_WEBSITE,
  tidyCompanyNumber,
  withGphc,
  withoutSensitive,
  worldpayAnswersDraftSchema,
  worldpayProblems,
  worldpayWarnings,
  type WorldpayAnswers,
} from './answers.js';

const TODAY = new Date('2026-11-18T12:00:00Z');

export function completeAnswers(overrides: Partial<WorldpayAnswers> = {}): WorldpayAnswers {
  const base = worldpayAnswersDraftSchema.parse({
    existingAccount: 'no',
    business: {
      businessType: 'Limited company', legalName: 'SHAH HEALTH LIMITED', companyNumber: '1234567',
      registeredAddress: '12 High Street, Leicester, LE1 1AA', tradingSince: '2015-03-02', vatNumber: 'GB 123456789',
      natureOfBusiness: '47730 - Dispensing chemist in specialised stores', businessDescription: 'Community pharmacy.',
      tradingName: 'Shah Pharmacy', gphcNumber: '1234567', tradingAddress: '12 High Street, Leicester, LE1 1AA',
      landline: '0116 200 0000', mobile: '07700 900000', businessEmail: 'shop@example.test', hasOwnWebsite: 'no',
      contactName: 'Priya Shah', contactPosition: 'Director', contactPhone: '07700 900000',
    },
    principals: [{
      key: 'a', roles: ['director', 'shareholder'], title: 'Mrs', firstNames: 'Priya', surname: 'Shah', dateOfBirth: '1980-04-12',
      nationality: 'British', homeAddress: '1 Home Road, Leicester, LE2 2BB', countryOfResidence: 'England', yearsAtAddress: 5,
      mobile: '07700 900001', email: 'priya@example.test', shareholding: 100, ownershipBand: '75-100',
    }],
    principalsConfirmed: true,
    financials: {
      turnoverBand: '£500,000 to £1m', expectedCardPayments: 100000, averageTransaction: 187,
      bankName: 'Barclays', accountName: 'SHAH HEALTH LIMITED', accountNumber: '12345678', sortCode: '20-00-00',
    },
    transactions: { terminalConnection: 'Not required', faceToFace: 0, phone: 0, internet: 100, immediate: 0, oneToThreeDays: 100, threeToFiveDays: 0, fivePlusDays: 0 },
    scheme: { s01: 'Yes.', s02: 'Confirmed.', s03: 'Confirmed [B-09].', s04: 'Confirmed.', s05: 'No.' },
  });
  return { ...base, ...overrides };
}

const paths = (answers: WorldpayAnswers) => worldpayProblems(answers, TODAY).map(p => p.path);

describe('Worldpay application answers', () => {
  it('accepts a complete application', () => {
    assert.deepEqual(worldpayProblems(completeAnswers(), TODAY), []);
  });

  it('lets a draft hold half-typed answers', () => {
    const draft = worldpayAnswersDraftSchema.parse({ business: { legalName: 'Shah' }, principals: [{ key: 'x', shareholding: '' }] });
    assert.equal(draft.business.legalName, 'Shah');
    assert.equal(draft.principals[0]?.shareholding, undefined);
    assert.ok(paths(draft).includes('business.tradingName'));
  });

  it('blocks the rules the spec lists', () => {
    const a = completeAnswers();
    a.transactions.internet = 90;
    a.principals.push({ ...a.principals[0]!, key: 'b', firstNames: 'Sam', shareholding: 10, yearsAtAddress: 2, previousAddress: '' });
    a.financials.accountNumber = '1234567';
    const found = paths(a);
    assert.ok(found.includes('transactions.how'));
    assert.ok(found.includes('principals'), 'shareholdings over 100');
    assert.ok(found.includes('financials.accountNumber'));
    assert.ok(found.includes('principals.1.previousAddress'));
  });

  it('checks dates: real, 18 or over, trading start not in the future', () => {
    const a = completeAnswers();
    a.principals[0]!.dateOfBirth = '2010-02-30';
    a.business.tradingSince = '2027-01-01';
    assert.ok(paths(a).includes('principals.0.dateOfBirth'));
    assert.ok(paths(a).includes('business.tradingSince'));
    a.principals[0]!.dateOfBirth = '2010-02-01';
    assert.match(worldpayProblems(a, TODAY).find(p => p.path === 'principals.0.dateOfBirth')!.message, /18 or over/);
  });

  it('needs a company number only for companies, and roles only for companies', () => {
    const a = completeAnswers();
    a.business.businessType = 'Sole trader';
    a.business.companyNumber = '';
    a.principals[0]!.roles = [];
    assert.ok(!paths(a).includes('business.companyNumber'));
    assert.ok(!paths(a).some(p => p.endsWith('.roles')));
    a.business.businessType = 'LLP';
    assert.ok(paths(a).includes('business.companyNumber'));
  });

  it('warns without blocking', () => {
    const a = completeAnswers();
    a.business.gphcNumber = '123456';
    a.financials.expectedCardPayments = 1200000;
    a.principals[0]!.shareholding = 50;
    assert.deepEqual(worldpayWarnings(a).map(w => w.path), ['business.gphcNumber', 'financials.expectedCardPayments', 'principals.0.shareholding']);
    assert.ok(!paths(a).includes('business.gphcNumber'));
  });

  it('quotes the HHH website when the pharmacy has none, and fills in the GPhC number', () => {
    assert.equal(applicationWebsite(completeAnswers()), HHH_WEBSITE);
    const own = completeAnswers();
    own.business.hasOwnWebsite = 'yes';
    own.business.website = 'https://shahpharmacy.example';
    assert.equal(applicationWebsite(own), 'https://shahpharmacy.example');
    assert.equal(withGphc('premises number [B-09]. Again [B-09].', '1234567'), 'premises number 1234567. Again 1234567.');
    assert.equal(tidyCompanyNumber(' sc 123456'), 'SC123456');
    assert.equal(tidyCompanyNumber('1234567'), '01234567');
  });

  it('drops the principals and bank details for retention', () => {
    const kept = withoutSensitive(completeAnswers());
    assert.deepEqual(kept.principals, []);
    assert.equal(kept.financials.accountNumber, '');
    assert.equal(kept.financials.sortCode, '');
    assert.equal(kept.business.legalName, 'SHAH HEALTH LIMITED');
  });
});
