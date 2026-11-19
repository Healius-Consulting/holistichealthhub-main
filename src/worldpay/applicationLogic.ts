import {
  tidyCompanyNumber,
  worldpayProblems,
  worldpayWarnings,
  type WorldpayAnswers,
  type WorldpayPrincipalAnswers,
  type WorldpayProblem,
  type WorldpayStep,
} from '../../services/api-sql/src/domain/worldpay-application/answers.ts';
import type { CompanyLookup } from '../shared/api';

/**
 * The Worldpay application form's rules that run in the browser. Validation is the
 * server's own (imported above), so the form and the API can never disagree.
 */

export type { WorldpayAnswers, WorldpayPrincipalAnswers, WorldpayProblem, WorldpayStep };
export { worldpayProblems, worldpayWarnings, tidyCompanyNumber };

/** The screens: 0 is "Before you start", then the spec's five steps. */
export const STEP_KEYS: Array<WorldpayStep | 'start'> = ['start', 'business', 'principals', 'financials', 'completed', 'declaration'];

export function isCompany(answers: WorldpayAnswers) {
  const type = answers.business.businessType;
  return type === 'Limited company' || type === 'PLC' || type === 'LLP' || type === '';
}

export function peopleStepName(answers: WorldpayAnswers) {
  if (answers.business.businessType === 'Sole trader') return 'Owner';
  if (answers.business.businessType === 'Partnership') return 'Partners';
  return 'Directors and owners';
}

export function stepNames(answers: WorldpayAnswers) {
  return ['Before you start', 'Your business', peopleStepName(answers), 'Financials', 'Pre-filled', 'Check and send'];
}

export function peopleConfirmText(answers: WorldpayAnswers) {
  if (answers.business.businessType === 'Sole trader') return 'I am the only owner of this business.';
  if (answers.business.businessType === 'Partnership') return 'I have listed every partner.';
  return 'I have listed every director, and every shareholder with 25% or more (or every shareholder, if no one has 25% or more).';
}

/** What blocks leaving a step. Step 0 is the existing-account question. */
export function stepProblems(answers: WorldpayAnswers, stepIndex: number, today = new Date()): WorldpayProblem[] {
  if (stepIndex === 0) {
    return answers.existingAccount ? [] : [{ step: 'business', path: 'existingAccount', message: 'Choose an answer to the Worldpay account question.' }];
  }
  const key = STEP_KEYS[stepIndex];
  return worldpayProblems(answers, today).filter(problem => problem.step === key);
}

/** The first step (1-5) with something to fix, for sending the pharmacy back from Check and send. */
export function firstStepWithProblems(answers: WorldpayAnswers, today = new Date()) {
  for (let index = 1; index <= 4; index += 1) if (stepProblems(answers, index, today).length) return index;
  return null;
}

// --- Date of birth: three boxes, stored as YYYY-MM-DD (parts may be blank) -------------

export function splitDob(value: string) {
  const [year = '', month = '', day = ''] = value.split('-');
  return { day: day.replace(/^0(?=\d)/, ''), month: month.replace(/^0(?=\d)/, ''), year };
}

export function joinDob(parts: { day: string; month: string; year: string }) {
  const pad = (part: string) => (part.trim() && /^\d+$/.test(part.trim()) ? part.trim().padStart(2, '0') : part.trim());
  const joined = `${parts.year.trim()}-${pad(parts.month)}-${pad(parts.day)}`;
  return joined === '--' ? '' : joined.slice(0, 10);
}

// --- Companies House --------------------------------------------------------------

export const BAND_TEXT: Record<string, string> = {
  '25-50': 'more than 25% and up to 50%',
  '50-75': 'more than 50% and less than 75%',
  '75-100': '75% or more',
};

const BUSINESS_TYPE_FOR: Record<string, WorldpayAnswers['business']['businessType']> = {
  ltd: 'Limited company',
  'private-unlimited': 'Limited company',
  plc: 'PLC',
  llp: 'LLP',
};

export function newPrincipal(overrides: Partial<WorldpayPrincipalAnswers> = {}): WorldpayPrincipalAnswers {
  return {
    key: typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `p-${Math.random().toString(36).slice(2)}`,
    roles: ['director'],
    title: '',
    titleOther: '',
    firstNames: '',
    surname: '',
    dateOfBirth: '',
    nationality: '',
    homeAddress: '',
    countryOfResidence: 'United Kingdom',
    yearsAtAddress: undefined,
    previousAddress: '',
    mobile: '',
    email: '',
    shareholding: undefined,
    fromCompaniesHouse: false,
    ownershipBand: '',
    ...overrides,
  };
}

/** Something the pharmacy typed on a card that is not from Companies House. */
function handTyped(person: WorldpayPrincipalAnswers) {
  return !person.fromCompaniesHouse && Boolean(person.firstNames.trim() || person.surname.trim() || person.homeAddress.trim() || person.email.trim());
}

const COMPANY_FIELDS = ['business.legalName', 'business.registeredAddress', 'business.tradingSince', 'business.businessType'] as const;

/**
 * Applies a lookup (spec §3.3 overwrite rules):
 * - a company field fills only when blank or still holding a looked-up value; on the
 *   first lookup the legal name also replaces the name carried over from the Curaleaf form;
 * - the same number again leaves the people alone, so nothing typed on them is lost;
 * - a different number replaces the looked-up people and keeps those added by hand.
 * Officers' correspondence addresses are never used (the lookup never sends them).
 */
export function applyCompanyLookup(answers: WorldpayAnswers, company: CompanyLookup, now = new Date()): WorldpayAnswers {
  const previous = answers.companyLookup;
  const sameCompany = Boolean(previous && previous.companyNumber === company.companyNumber);
  const filled = new Set(previous?.filled ?? []);
  const business = { ...answers.business, companyNumber: company.companyNumber };
  const values: Record<(typeof COMPANY_FIELDS)[number], string> = {
    'business.legalName': company.companyName,
    'business.registeredAddress': company.registeredAddress,
    'business.tradingSince': company.incorporatedOn ?? '',
    'business.businessType': BUSINESS_TYPE_FOR[company.companyType] ?? '',
  };
  const oldLegalName = business.legalName;
  for (const path of COMPANY_FIELDS) {
    const value = values[path];
    if (!value) continue;
    const field = path.slice('business.'.length) as 'legalName' | 'registeredAddress' | 'tradingSince' | 'businessType';
    const current = String(business[field] ?? '').trim();
    const replaceable = !current || filled.has(path) || (path === 'business.legalName' && !previous) || path === 'business.businessType';
    if (!replaceable) continue;
    (business as Record<string, string>)[field] = value;
    filled.add(path);
  }

  const financials = { ...answers.financials };
  if (business.legalName !== oldLegalName && (!financials.accountName.trim() || financials.accountName === oldLegalName)) {
    financials.accountName = business.legalName;
  }

  let principals = answers.principals;
  const looked = company.people.map(person => newPrincipal({
    roles: person.roles,
    title: person.title ?? '',
    titleOther: person.titleOther,
    firstNames: person.firstNames,
    surname: person.surname,
    dateOfBirth: person.birthYear && person.birthMonth ? joinDob({ day: '', month: String(person.birthMonth), year: String(person.birthYear) }) : '',
    nationality: person.nationality,
    countryOfResidence: person.countryOfResidence || 'United Kingdom',
    fromCompaniesHouse: true,
    ownershipBand: person.ownershipBand ?? '',
  }));
  const hasLookedUpPeople = answers.principals.some(person => person.fromCompaniesHouse);
  if (looked.length && !(sameCompany && hasLookedUpPeople)) {
    principals = [...looked, ...answers.principals.filter(handTyped)];
  }

  return {
    ...answers,
    business,
    financials,
    principals,
    companyLookup: {
      companyNumber: company.companyNumber,
      companyName: company.companyName,
      status: company.status,
      lookedUpAt: now.toISOString(),
      filled: [...filled],
      notListed: company.notListed,
      noSignificantOwners: company.noSignificantOwners,
    },
  };
}

/** The pharmacy changed a field by hand: it is no longer "From Companies House". */
export function markEdited(answers: WorldpayAnswers, path: string): WorldpayAnswers {
  if (!answers.companyLookup?.filled.includes(path)) return answers;
  return { ...answers, companyLookup: { ...answers.companyLookup, filled: answers.companyLookup.filled.filter(item => item !== path) } };
}

/** Puts the GPhC premises number into the scheme answers for display (the PDF does the same at submission). */
export function withGphcShown(answer: string, gphcNumber: string) {
  return gphcNumber.trim() ? answer.split('[B-09]').join(gphcNumber.trim()) : answer;
}

export function shareTotal(answers: WorldpayAnswers) {
  return Math.round(answers.principals.reduce((sum, person) => sum + (person.shareholding ?? 0), 0) * 100) / 100;
}

/** Backoff between autosave retries after a server or network failure; then it waits for the next edit. */
export const SAVE_RETRY_DELAYS_MS = [5_000, 15_000, 60_000];

export type SaveFailure =
  | { kind: 'conflict' }
  /** The server refused these answers; retrying the same request cannot help. */
  | { kind: 'refused'; message: string }
  /** A server or network problem: try again after `retryIn`, or (null) only once the answers change. */
  | { kind: 'retry'; retryIn: number | null };

/**
 * What a failed autosave should do next. `failures` counts the failed saves in a row, this one included.
 * A refused save never loops: before this, every failure re-armed the 1.2 s autosave, so one
 * rejected id produced a save every couple of seconds until the rate limiter stepped in.
 */
export function nextSaveDelay(error: { status?: number; code?: string; message?: string } | null | undefined, failures: number): SaveFailure {
  const code = error?.code ?? '';
  if (code === 'WORLDPAY_DRAFT_CONFLICT' || code === 'WORLDPAY_APPLICATION_CONFLICT') return { kind: 'conflict' };
  const status = typeof error?.status === 'number' ? error.status : 0;
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return { kind: 'refused', message: error?.message?.trim() || 'The answers could not be saved.' };
  }
  return { kind: 'retry', retryIn: SAVE_RETRY_DELAYS_MS[failures - 1] ?? null };
}
