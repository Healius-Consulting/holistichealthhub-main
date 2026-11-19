import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { config } from '../../bootstrap/config.js';
import { HttpError } from '../../domain/common/errors.js';

/**
 * Companies House's public register, used to fill in an onboarding pharmacy's company
 * details from its company number. The API key lives in Secret Manager as
 * `hhh-companies-house-key-europe-west2` (pinned to London) and never leaves the server.
 *
 * Three resources are read: the company profile, the officers list and the persons with
 * significant control list. Only the profile is required; the lists are a bonus, so a
 * failure there still returns the company.
 */
const API_BASE = 'https://api.company-information.service.gov.uk';
const DIRECTOR_ROLES = new Set(['director', 'nominee-director', 'llp-member', 'llp-designated-member']);
const TITLES = new Map([['mr', 'Mr'], ['mrs', 'Mrs'], ['miss', 'Miss'], ['ms', 'Ms'], ['dr', 'Dr']]);

export type CompanyRole = 'director' | 'shareholder';
/** The ownership band Companies House records; never an exact figure. */
export type OwnershipBand = '25-50' | '50-75' | '75-100';

/** A person who can be a principal on the Worldpay application. */
export interface CompanyPerson {
  roles: CompanyRole[];
  /** Mr, Mrs, Miss, Ms or Dr; `Other` with `titleOther` for anything else; null when not given. */
  title: 'Mr' | 'Mrs' | 'Miss' | 'Ms' | 'Dr' | 'Other' | null;
  titleOther: string;
  firstNames: string;
  surname: string;
  /** Companies House never gives the day of birth. */
  birthMonth: number | null;
  birthYear: number | null;
  nationality: string;
  countryOfResidence: string;
  ownershipBand: OwnershipBand | null;
}

/** What a lookup gives the onboarding forms. Every field can be changed by the pharmacy. */
export interface CompanyLookup {
  companyNumber: string;
  companyName: string;
  /** Companies House's own status, e.g. `active`, `dissolved`, `liquidation`. */
  status: string;
  active: boolean;
  /** Companies House's own company type, e.g. `ltd`, `plc`, `llp`. */
  companyType: string;
  /** The current Worldpay form's business type, or null when none fits. */
  businessType: 'Ltd Co' | 'LLP' | 'PLC' | null;
  /** `YYYY-MM-DD`, the date the company was incorporated. */
  incorporatedOn: string | null;
  registeredAddress: string;
  /** Current directors and owners, one entry per person (a director who is also an owner appears once). */
  people: CompanyPerson[];
  /** Current directors only, kept for the forms that predate `people`. */
  directors: CompanyDirector[];
  /** Officers and owners that cannot be a person card (companies, legal bodies, protected persons). */
  notListed: string[];
  /** True when the owners list was read and holds no current entry. */
  noSignificantOwners: boolean;
}

export interface CompanyDirector {
  firstNames: string;
  surname: string;
  nationality: string;
  countryOfResidence: string;
}

type RawAddress = {
  care_of?: string;
  po_box?: string;
  premises?: string;
  address_line_1?: string;
  address_line_2?: string;
  locality?: string;
  region?: string;
  postal_code?: string;
  country?: string;
};

type RawDateOfBirth = { month?: number; year?: number };

type RawProfile = {
  company_number?: string;
  company_name?: string;
  company_status?: string;
  type?: string;
  date_of_creation?: string;
  registered_office_address?: RawAddress;
};

type RawOfficer = {
  name?: string;
  officer_role?: string;
  resigned_on?: string;
  nationality?: string;
  country_of_residence?: string;
  date_of_birth?: RawDateOfBirth;
};

type RawPsc = {
  kind?: string;
  name?: string;
  name_elements?: { title?: string; forename?: string; middle_name?: string; surname?: string };
  ceased_on?: string;
  ceased?: boolean;
  nationality?: string;
  country_of_residence?: string;
  date_of_birth?: RawDateOfBirth;
  natures_of_control?: string[];
  description?: string;
};

/**
 * Accepts what people type ("1234567", "sc 123456", "01234567 ") and returns the
 * 8-character number Companies House uses, or null when it can't be one.
 */
export function normaliseCompanyNumber(input: string): string | null {
  const compact = input.replace(/\s+/g, '').toUpperCase();
  if (/^\d{1,8}$/.test(compact)) return compact.padStart(8, '0');
  if (/^[A-Z]{2}\d{1,6}$/.test(compact)) return compact.slice(0, 2) + compact.slice(2).padStart(6, '0');
  return null;
}

/** Companies House stores names in capitals; "SMITH-JONES" reads better as "Smith-Jones". */
function titleCase(value: string) {
  return value.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_, gap: string, letter: string) => gap + letter.toUpperCase());
}

/** Only shouting names are re-cased; "McDonald" as given stays as given. */
function tidyName(value: string) {
  const text = value.trim();
  return text && text === text.toUpperCase() ? titleCase(text) : text;
}

function line(value: string | undefined) {
  return value?.trim() ?? '';
}

export function formatAddress(address: RawAddress | undefined): string {
  if (!address) return '';
  const street = [line(address.premises), line(address.address_line_1)].filter(Boolean).join(' ');
  return [
    line(address.care_of) && `c/o ${line(address.care_of)}`,
    line(address.po_box) && `PO Box ${line(address.po_box).replace(/^po\s*box\s*/i, '')}`,
    street,
    line(address.address_line_2),
    line(address.locality),
    line(address.region),
    line(address.postal_code),
  ].filter(Boolean).join(', ');
}

function businessType(type: string | undefined): CompanyLookup['businessType'] {
  if (type === 'plc') return 'PLC';
  if (type === 'llp') return 'LLP';
  if (type === 'ltd' || type === 'private-unlimited') return 'Ltd Co';
  return null;
}

/** "SMITH, John Paul" → { firstNames: "John Paul", surname: "Smith" }. With no comma the whole name is the surname. */
export function splitOfficerName(name: string): Pick<CompanyDirector, 'firstNames' | 'surname'> {
  const comma = name.indexOf(',');
  if (comma < 0) return { firstNames: '', surname: tidyName(name) };
  return { firstNames: tidyName(name.slice(comma + 1)), surname: tidyName(name.slice(0, comma)) };
}

function birth(value: RawDateOfBirth | undefined) {
  const month = Number(value?.month);
  const year = Number(value?.year);
  return {
    birthMonth: Number.isInteger(month) && month >= 1 && month <= 12 ? month : null,
    birthYear: Number.isInteger(year) && year > 1900 ? year : null,
  };
}

function title(raw: string | undefined): Pick<CompanyPerson, 'title' | 'titleOther'> {
  const text = raw?.trim().replace(/\.$/, '') ?? '';
  if (!text) return { title: null, titleOther: '' };
  const known = TITLES.get(text.toLowerCase());
  return known ? { title: known as CompanyPerson['title'], titleOther: '' } : { title: 'Other', titleOther: text };
}

/** The share band in a PSC's natures of control, including the `-as-trust` and `-as-firm` forms. */
export function ownershipBand(natures: string[] | undefined): OwnershipBand | null {
  for (const nature of natures ?? []) {
    const match = nature.match(/^ownership-of-shares-(25-to-50|50-to-75|75-to-100)-percent(?:-as-(?:trust|firm))?$/);
    if (match?.[1]) return match[1].replace(/-to-/, '-') as OwnershipBand;
  }
  return null;
}

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const firstOf = (names: string) => names.trim().split(/\s+/)[0] ?? '';

/** Same surname, first forename, and birth month and year, ignoring case. */
function samePerson(a: CompanyPerson, b: CompanyPerson) {
  return sameText(a.surname, b.surname)
    && sameText(firstOf(a.firstNames), firstOf(b.firstNames))
    && a.birthMonth === b.birthMonth
    && a.birthYear === b.birthYear;
}

export function mapCompany(profile: RawProfile, officers: RawOfficer[], pscs: RawPsc[] | null): CompanyLookup {
  const status = profile.company_status ?? 'unknown';
  const people: CompanyPerson[] = [];
  const notListed: string[] = [];

  for (const officer of officers) {
    if (officer.resigned_on || !officer.name) continue;
    const role = officer.officer_role ?? '';
    if (role.startsWith('corporate-')) {
      notListed.push(`${officer.name.trim()} (a company acting as an officer)`);
      continue;
    }
    if (!DIRECTOR_ROLES.has(role)) continue;
    people.push({
      roles: ['director'],
      title: null,
      titleOther: '',
      ...splitOfficerName(officer.name),
      ...birth(officer.date_of_birth),
      nationality: officer.nationality?.trim() ?? '',
      countryOfResidence: officer.country_of_residence?.trim() ?? '',
      ownershipBand: null,
    });
  }

  const current = (pscs ?? []).filter(psc => !psc.ceased_on && !psc.ceased);
  for (const psc of current) {
    if (psc.kind !== 'individual-person-with-significant-control') {
      notListed.push(psc.kind?.startsWith('super-secure')
        ? 'A person with significant control (details protected)'
        : `${psc.name?.trim() || 'A person with significant control'} (a company or other body)`);
      continue;
    }
    const elements = psc.name_elements ?? {};
    const owner: CompanyPerson = {
      roles: ['shareholder'],
      ...title(elements.title),
      firstNames: tidyName([elements.forename, elements.middle_name].filter(Boolean).join(' ')),
      surname: tidyName(elements.surname ?? ''),
      ...birth(psc.date_of_birth),
      nationality: psc.nationality?.trim() ?? '',
      countryOfResidence: psc.country_of_residence?.trim() ?? '',
      ownershipBand: ownershipBand(psc.natures_of_control),
    };
    if (!owner.surname && psc.name) Object.assign(owner, splitOfficerName(psc.name.replace(/^(mr|mrs|miss|ms|dr)\.?\s+/i, '')));
    const director = people.find(person => person.roles.includes('director') && samePerson(person, owner));
    if (director) {
      director.roles = ['director', 'shareholder'];
      director.ownershipBand = owner.ownershipBand;
      if (!director.title) Object.assign(director, { title: owner.title, titleOther: owner.titleOther });
      continue;
    }
    people.push(owner);
  }

  return {
    companyNumber: profile.company_number ?? '',
    companyName: profile.company_name?.trim() ?? '',
    status,
    active: status === 'active',
    companyType: profile.type ?? '',
    businessType: businessType(profile.type),
    incorporatedOn: profile.date_of_creation && /^\d{4}-\d{2}-\d{2}$/.test(profile.date_of_creation) ? profile.date_of_creation : null,
    registeredAddress: formatAddress(profile.registered_office_address),
    people,
    directors: people
      .filter(person => person.roles.includes('director'))
      .map(({ firstNames, surname, nationality, countryOfResidence }) => ({ firstNames, surname, nationality, countryOfResidence })),
    notListed,
    noSignificantOwners: pscs !== null && current.length === 0,
  };
}

let secretClient: SecretManagerServiceClient | null = null;
let cachedKey: string | null = null;

export function companiesHouseSecretResource() {
  return `projects/${config.FIREBASE_PROJECT_ID}/secrets/hhh-companies-house-key-europe-west2`;
}

async function readApiKey(): Promise<string | null> {
  if (cachedKey) return cachedKey;
  try {
    secretClient ??= new SecretManagerServiceClient();
    const [version] = await secretClient.accessSecretVersion({ name: `${companiesHouseSecretResource()}/versions/latest` });
    cachedKey = version.payload?.data?.toString().trim() || null;
    return cachedKey;
  } catch (error) {
    console.warn('Companies House key could not be read', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}

const UNAVAILABLE = 'Companies House is not available right now. You can type your details below and carry on.';

export async function lookUpCompany(
  input: string,
  deps: { apiKey?: () => Promise<string | null>; fetchImpl?: typeof fetch } = {},
): Promise<CompanyLookup> {
  const number = normaliseCompanyNumber(input);
  if (!number) {
    throw new HttpError(400, 'A company number is 8 characters, like 01234567 or SC123456.', 'INVALID_COMPANY_NUMBER');
  }
  const key = await (deps.apiKey ?? readApiKey)();
  if (!key) throw new HttpError(503, UNAVAILABLE, 'COMPANIES_HOUSE_UNAVAILABLE');
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const get = async (path: string) => {
    try {
      return await fetchImpl(`${API_BASE}${path}`, {
        headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString('base64')}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      });
    } catch {
      throw new HttpError(503, UNAVAILABLE, 'COMPANIES_HOUSE_UNAVAILABLE');
    }
  };

  const profileResponse = await get(`/company/${number}`);
  if (profileResponse.status === 404) {
    throw new HttpError(404, 'We could not find that company number at Companies House. Check it, or type your details below.', 'COMPANY_NOT_FOUND');
  }
  if (!profileResponse.ok) throw new HttpError(503, UNAVAILABLE, 'COMPANIES_HOUSE_UNAVAILABLE');
  const profile = await profileResponse.json() as RawProfile;

  // The lists are a bonus: without them the company details still fill in.
  const list = async <T>(path: string): Promise<T[] | null> => {
    const response = await get(path).catch(() => null);
    // A company with no PSC register entries answers 404, which means an empty list.
    if (response?.status === 404) return [];
    if (!response?.ok) return null;
    const body = await response.json().catch(() => null) as { items?: T[] } | null;
    return Array.isArray(body?.items) ? body.items : null;
  };
  const [officers, pscs] = await Promise.all([
    list<RawOfficer>(`/company/${number}/officers?items_per_page=100`),
    list<RawPsc>(`/company/${number}/persons-with-significant-control?items_per_page=100`),
  ]);
  return mapCompany(profile, officers ?? [], pscs);
}
