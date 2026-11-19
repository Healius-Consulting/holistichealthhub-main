import { z } from 'zod';

/**
 * The Worldpay merchant application (spec 01, 18 Nov 2026): one per pharmacy branch,
 * saved as a draft while it is filled in and submitted once. Field ids in comments
 * (B-02, P-05 …) are the spec's.
 *
 * Sensitive answers: principals' dates of birth and home addresses (P-05, P-07, P-10)
 * and the bank account and sort code (F-07, F-08). They never go into logs, ClickUp or
 * email bodies, and the retention job removes them 30 days after the application closes.
 */

export const BUSINESS_TYPES = ['Limited company', 'PLC', 'LLP', 'Partnership', 'Sole trader'] as const;
export type BusinessType = typeof BUSINESS_TYPES[number];
export const TITLES = ['Mr', 'Mrs', 'Miss', 'Ms', 'Dr', 'Other'] as const;
export const TURNOVER_BANDS = ['Under £500,000', '£500,000 to £1m', '£1m to £2m', '£2m to £5m', 'Over £5m'] as const;
/** The top of each turnover band in pounds, for the "card payments above turnover" warning. */
export const TURNOVER_BAND_TOP: Record<typeof TURNOVER_BANDS[number], number | null> = {
  'Under £500,000': 500_000,
  '£500,000 to £1m': 1_000_000,
  '£1m to £2m': 2_000_000,
  '£2m to £5m': 5_000_000,
  'Over £5m': null,
};
export const EXISTING_ACCOUNT = ['no', 'online', 'card_machine'] as const;
export const HHH_WEBSITE = 'https://www.holistichealthhub.live/';
/** Kept for Worldpay's Launchpad API later; never shown. */
export const MCC_CODE = '5912';

/** Answers the form starts with, the same for every HHH pharmacy. All editable except AMEX, which is never asked. */
export const WORLDPAY_APPLICATION_DEFAULTS = {
  businessType: 'Limited company' as BusinessType,
  natureOfBusiness: '47730 - Dispensing chemist in specialised stores',
  businessDescription: 'Community pharmacy. Dispenses prescription medicines against valid private prescriptions, collected by the patient or delivered by the pharmacy.',
  terminalConnection: 'Not required',
  faceToFace: 0,
  phone: 0,
  internet: 100,
  immediate: 0,
  oneToThreeDays: 100,
  threeToFiveDays: 0,
  fivePlusDays: 0,
  expectedCardPayments: 100_000,
  averageTransaction: 187,
} as const;

const s = (max: number) => z.string().trim().max(max);
const text = (max: number) => s(max).optional().default('');

/** A loose number: blank stays undefined so a draft can hold half-typed values. */
const num = z.preprocess(value => (value === '' || value === null ? undefined : value), z.coerce.number().finite().optional());

const principalDraft = z.object({
  /** Stable id for the card, so edits and Companies House re-lookups keep track of it. */
  key: text(64),
  roles: z.array(z.enum(['director', 'shareholder'])).max(2).optional().default([]),
  title: z.enum(['', ...TITLES]).optional().default(''),
  titleOther: text(40),
  firstNames: text(120),
  surname: text(120),
  dateOfBirth: text(10),
  nationality: text(80),
  homeAddress: text(400),
  countryOfResidence: text(80),
  yearsAtAddress: num,
  previousAddress: text(400),
  mobile: text(40),
  email: text(254),
  shareholding: num,
  /** Set when the card came from the Companies House lookup. */
  fromCompaniesHouse: z.boolean().optional().default(false),
  ownershipBand: z.enum(['', '25-50', '50-75', '75-100']).optional().default(''),
});

export const worldpayAnswersDraftSchema = z.object({
  existingAccount: z.enum(['', ...EXISTING_ACCOUNT]).optional().default(''),
  business: z.object({
    businessType: z.enum(['', ...BUSINESS_TYPES]).optional().default(''),
    legalName: text(160),
    companyNumber: text(12),
    registeredAddress: text(400),
    tradingSince: text(10),
    vatNumber: text(20),
    natureOfBusiness: text(200),
    businessDescription: text(1000),
    tradingName: text(160),
    gphcNumber: text(20),
    tradingAddress: text(400),
    landline: text(40),
    mobile: text(40),
    businessEmail: text(254),
    hasOwnWebsite: z.enum(['', 'yes', 'no']).optional().default(''),
    website: text(300),
    contactName: text(160),
    contactPosition: text(120),
    contactPhone: text(40),
    contactEmail: text(254),
  }).prefault({}),
  principals: z.array(principalDraft).max(12).optional().default([]),
  principalsConfirmed: z.boolean().optional().default(false),
  financials: z.object({
    turnoverBand: z.enum(['', ...TURNOVER_BANDS]).optional().default(''),
    turnoverFigure: num,
    expectedCardPayments: num,
    averageTransaction: num,
    bankName: text(120),
    accountName: text(160),
    accountNumber: text(20),
    sortCode: text(20),
  }).prefault({}),
  transactions: z.object({
    terminalConnection: text(200),
    faceToFace: num,
    phone: num,
    internet: num,
    immediate: num,
    oneToThreeDays: num,
    threeToFiveDays: num,
    fivePlusDays: num,
  }).prefault({}),
  scheme: z.object({
    s01: text(2000),
    s02: text(2000),
    s03: text(2000),
    s04: text(2000),
    s05: text(4000),
  }).prefault({}),
  /** The Companies House lookup the pharmacy ran. Stored for admin; not sent to Worldpay. */
  companyLookup: z.object({
    companyNumber: text(12),
    companyName: text(200),
    status: text(60),
    lookedUpAt: text(40),
    /** Answer paths that still hold the looked-up value: tagged "From Companies House" and refilled by a new lookup. */
    filled: z.array(z.string().max(60)).max(40).optional().default([]),
    /** Shown on step 2: entries Companies House holds that cannot be a person card. */
    notListed: z.array(z.string().max(200)).max(20).optional().default([]),
    noSignificantOwners: z.boolean().optional().default(false),
  }).nullable().optional().default(null),
});

export type WorldpayAnswers = z.infer<typeof worldpayAnswersDraftSchema>;
export type WorldpayPrincipalAnswers = WorldpayAnswers['principals'][number];

export const worldpayDeclarationSchema = z.object({
  accurate: z.literal(true, { message: 'Tick to confirm the application is accurate and complete.' }),
  consent: z.literal(true, { message: 'Tick to consent to the details being passed to Worldpay.' }),
  signerName: s(160).min(2, 'Type your name.'),
  signerPosition: s(120).min(2, 'Type your position.'),
});
export type WorldpayDeclaration = z.infer<typeof worldpayDeclarationSchema>;

export type WorldpayStep = 'business' | 'principals' | 'financials' | 'completed' | 'declaration';
export interface WorldpayProblem {
  step: WorldpayStep;
  /** Dotted path into the answers, e.g. `business.legalName`, `principals.0.dateOfBirth`. */
  path: string;
  message: string;
}

const UK_PHONE = /^(?:\+44\s?|0)(?:\d\s?){9,10}$/;
const UK_MOBILE = /^(?:\+44\s?7|07)(?:\d\s?){9}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL = /^https?:\/\/[^\s.]+\.[^\s]+$/i;
const POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;

export function tidyCompanyNumber(input: string): string {
  const compact = input.replace(/\s+/g, '').toUpperCase();
  if (/^\d{1,7}$/.test(compact)) return compact.padStart(8, '0');
  return compact;
}

const isCompany = (type: string) => type === 'Limited company' || type === 'PLC' || type === 'LLP';

function realDate(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCDate() === Number(match[3]) && date.getUTCMonth() === Number(match[2]) - 1 ? date : null;
}

function ageOn(birth: Date, today: Date) {
  let age = today.getUTCFullYear() - birth.getUTCFullYear();
  const beforeBirthday = today.getUTCMonth() < birth.getUTCMonth()
    || (today.getUTCMonth() === birth.getUTCMonth() && today.getUTCDate() < birth.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

const twoDecimals = (value: number) => Math.round(value * 100) === value * 100;

/** Everything that stops a submission, grouped by step so the form can send the pharmacy back to it. */
export function worldpayProblems(answers: WorldpayAnswers, today = new Date()): WorldpayProblem[] {
  const problems: WorldpayProblem[] = [];
  const add = (step: WorldpayStep, path: string, message: string) => problems.push({ step, path, message });
  const b = answers.business;
  const need = (path: keyof typeof b, message: string) => { if (!String(b[path] ?? '').trim()) add('business', `business.${path}`, message); };

  if (!b.businessType) add('business', 'business.businessType', 'Choose the business type.');
  need('legalName', 'Enter the legal name of the business.');
  if (isCompany(b.businessType)) {
    if (!/^(\d{8}|[A-Z]{2}\d{6})$/.test(tidyCompanyNumber(b.companyNumber))) add('business', 'business.companyNumber', 'Enter the 8-character company number, like 01234567 or SC123456.');
  }
  need('registeredAddress', 'Enter the registered address.');
  if (b.registeredAddress && !POSTCODE.test(b.registeredAddress)) add('business', 'business.registeredAddress', 'Include the postcode in the registered address.');
  const started = realDate(b.tradingSince);
  if (!started) add('business', 'business.tradingSince', 'Enter the date the business started trading.');
  else if (started > today) add('business', 'business.tradingSince', 'The trading start date cannot be in the future.');
  if (b.vatNumber && !/^GB\d{9}$/.test(b.vatNumber.replace(/\s+/g, '').toUpperCase())) add('business', 'business.vatNumber', 'A VAT number is GB followed by 9 digits.');
  need('natureOfBusiness', 'Enter the nature of business.');
  need('businessDescription', 'Enter a description of the business.');
  need('tradingName', 'Enter the trading name.');
  need('gphcNumber', 'Enter the GPhC premises number.');
  need('tradingAddress', 'Enter the trading address.');
  if (b.tradingAddress && !POSTCODE.test(b.tradingAddress)) add('business', 'business.tradingAddress', 'Include the postcode in the trading address.');
  if (!UK_PHONE.test(b.landline.trim())) add('business', 'business.landline', 'Enter a UK landline number.');
  if (!UK_MOBILE.test(b.mobile.trim())) add('business', 'business.mobile', 'Enter a UK mobile number.');
  if (!EMAIL.test(b.businessEmail.trim())) add('business', 'business.businessEmail', 'Enter the business email address.');
  if (!b.hasOwnWebsite) add('business', 'business.hasOwnWebsite', 'Say whether the pharmacy has its own website.');
  if (b.hasOwnWebsite === 'yes' && !URL.test(b.website.trim())) add('business', 'business.website', 'Enter the website address, starting https://.');
  need('contactName', 'Enter the contact name.');
  need('contactPosition', 'Enter the contact position.');
  if (!UK_PHONE.test(b.contactPhone.trim())) add('business', 'business.contactPhone', 'Enter a UK phone number for the contact.');
  if (b.contactEmail && !EMAIL.test(b.contactEmail.trim())) add('business', 'business.contactEmail', 'Enter a valid contact email, or leave it blank.');

  const soleTrader = b.businessType === 'Sole trader';
  const partnership = b.businessType === 'Partnership';
  const people = answers.principals;
  if (people.length === 0) add('principals', 'principals', soleTrader ? 'Add the owner.' : 'Add at least one person.');
  if (soleTrader && people.length > 1) add('principals', 'principals', 'A sole trader has one owner.');
  let total = 0;
  people.forEach((p, i) => {
    const at = (field: string) => `principals.${i}.${field}`;
    const who = [p.firstNames, p.surname].filter(Boolean).join(' ') || `Person ${i + 1}`;
    if (!soleTrader && !partnership && p.roles.length === 0) add('principals', at('roles'), `${who}: tick Director, Shareholder or both.`);
    if (!p.title) add('principals', at('title'), `${who}: choose a title.`);
    if (p.title === 'Other' && !p.titleOther.trim()) add('principals', at('titleOther'), `${who}: type the title.`);
    if (!p.firstNames.trim()) add('principals', at('firstNames'), `${who}: enter their first name(s).`);
    if (!p.surname.trim()) add('principals', at('surname'), `${who}: enter their surname.`);
    const born = realDate(p.dateOfBirth);
    if (!born) add('principals', at('dateOfBirth'), `${who}: enter a real date of birth (day, month and year).`);
    else if (ageOn(born, today) < 18) add('principals', at('dateOfBirth'), `${who}: must be 18 or over.`);
    if (!p.nationality.trim()) add('principals', at('nationality'), `${who}: enter their nationality.`);
    if (!p.homeAddress.trim()) add('principals', at('homeAddress'), `${who}: enter their home address.`);
    else if (!POSTCODE.test(p.homeAddress)) add('principals', at('homeAddress'), `${who}: include the postcode in their home address.`);
    if (!p.countryOfResidence.trim()) add('principals', at('countryOfResidence'), `${who}: enter their country of residence.`);
    if (p.yearsAtAddress === undefined || !Number.isInteger(p.yearsAtAddress) || p.yearsAtAddress < 0) add('principals', at('yearsAtAddress'), `${who}: enter the whole number of years at this address.`);
    else if (p.yearsAtAddress < 3 && !p.previousAddress.trim()) add('principals', at('previousAddress'), `${who}: enter their previous home address (less than 3 years at this one).`);
    if (!UK_MOBILE.test(p.mobile.trim())) add('principals', at('mobile'), `${who}: enter a UK mobile number.`);
    if (!EMAIL.test(p.email.trim())) add('principals', at('email'), `${who}: enter their email address.`);
    const share = p.shareholding;
    if (share === undefined || share < 0 || share > 100 || !twoDecimals(share)) add('principals', at('shareholding'), `${who}: enter a shareholding from 0 to 100 (up to 2 decimals). Type 0 for no shares.`);
    else {
      total += share;
      if (p.roles.includes('shareholder') && share <= 0) add('principals', at('shareholding'), `${who}: a shareholder's shareholding must be more than 0.`);
    }
  });
  if (total > 100.0001) add('principals', 'principals', `The shareholdings add up to ${Math.round(total * 100) / 100}%, more than 100%.`);
  if (!answers.principalsConfirmed) add('principals', 'principalsConfirmed', 'Tick to confirm you have listed everyone Worldpay need.');

  const f = answers.financials;
  if (!f.turnoverBand) add('financials', 'financials.turnoverBand', 'Choose the annual business turnover.');
  if (f.turnoverBand === 'Over £5m' && !(f.turnoverFigure && f.turnoverFigure > 0 && Number.isInteger(f.turnoverFigure))) add('financials', 'financials.turnoverFigure', 'Enter the turnover in whole pounds.');
  if (!(f.expectedCardPayments && f.expectedCardPayments > 0 && Number.isInteger(f.expectedCardPayments))) add('financials', 'financials.expectedCardPayments', 'Enter the expected card payments a year, in whole pounds.');
  if (!(f.averageTransaction && f.averageTransaction > 0)) add('financials', 'financials.averageTransaction', 'Enter the average transaction value.');
  if (!f.bankName.trim()) add('financials', 'financials.bankName', 'Enter the name of the bank.');
  if (!f.accountName.trim()) add('financials', 'financials.accountName', 'Enter the name on the account.');
  if (!/^\d{8}$/.test(f.accountNumber.replace(/\s+/g, ''))) add('financials', 'financials.accountNumber', 'The account number is exactly 8 digits.');
  if (!/^\d{6}$/.test(f.sortCode.replace(/[\s-]+/g, ''))) add('financials', 'financials.sortCode', 'The sort code is exactly 6 digits.');

  const t = answers.transactions;
  const pct = (value: number | undefined) => (value === undefined ? NaN : value);
  if (!t.terminalConnection.trim()) add('completed', 'transactions.terminalConnection', 'Enter the card machine connection.');
  const how = pct(t.faceToFace) + pct(t.phone) + pct(t.internet);
  const when = pct(t.immediate) + pct(t.oneToThreeDays) + pct(t.threeToFiveDays) + pct(t.fivePlusDays);
  if (how !== 100) add('completed', 'transactions.how', `Face to face, phone and internet must add up to 100% (now ${Number.isNaN(how) ? 'incomplete' : `${how}%`}).`);
  if (when !== 100) add('completed', 'transactions.when', `The four "pay and receive" figures must add up to 100% (now ${Number.isNaN(when) ? 'incomplete' : `${when}%`}).`);
  for (const key of ['s01', 's02', 's03', 's04', 's05'] as const) {
    if (!answers.scheme[key].trim()) add('completed', `scheme.${key}`, 'Answer every card scheme question.');
  }
  return problems;
}

/** Warnings that never block (spec: GPhC length, card payments above turnover, shareholding outside the Companies House band). */
export function worldpayWarnings(answers: WorldpayAnswers): WorldpayProblem[] {
  const warnings: WorldpayProblem[] = [];
  const gphc = answers.business.gphcNumber.replace(/\s+/g, '');
  if (gphc && !/^\d{7}$/.test(gphc)) warnings.push({ step: 'business', path: 'business.gphcNumber', message: 'A GPhC premises number is usually 7 digits. Please check.' });
  const band = answers.financials.turnoverBand;
  const top = band ? (band === 'Over £5m' ? answers.financials.turnoverFigure ?? null : TURNOVER_BAND_TOP[band]) : null;
  if (top && answers.financials.expectedCardPayments && answers.financials.expectedCardPayments > top) {
    warnings.push({ step: 'financials', path: 'financials.expectedCardPayments', message: 'This is higher than your total turnover. Please check.' });
  }
  answers.principals.forEach((p, i) => {
    const share = p.shareholding;
    if (share === undefined || !p.ownershipBand) return;
    const [low, high] = p.ownershipBand.split('-').map(Number) as [number, number];
    const inBand = high === 100 ? share >= low : share > low && share <= high;
    if (!inBand) warnings.push({ step: 'principals', path: `principals.${i}.shareholding`, message: 'This does not match Companies House. Please check.' });
  });
  return warnings;
}

/** The website quoted to Worldpay: the pharmacy's own, or HHH's when it has none. */
export function applicationWebsite(answers: WorldpayAnswers): string {
  return answers.business.hasOwnWebsite === 'yes' ? answers.business.website.trim() : HHH_WEBSITE;
}

export const usesHhhWebsite = (answers: WorldpayAnswers) => answers.business.hasOwnWebsite !== 'yes';

/** Where the GPhC premises number goes in the scheme answers. */
export const GPHC_PLACEHOLDER = '[B-09]';
export function withGphc(answer: string, gphcNumber: string) {
  return answer.split(GPHC_PLACEHOLDER).join(gphcNumber.trim() || GPHC_PLACEHOLDER);
}

/** The answers with the sensitive fields removed: what the retention job keeps. */
export function withoutSensitive(answers: WorldpayAnswers): WorldpayAnswers {
  return {
    ...answers,
    principals: [],
    financials: { ...answers.financials, bankName: '', accountName: '', accountNumber: '', sortCode: '' },
  };
}
