import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { config } from '../../bootstrap/config.js';
import { HttpError } from '../../domain/common/errors.js';

/**
 * Companies House's public register, used to fill in an onboarding pharmacy's company
 * details from its company number. The API key lives in Secret Manager as
 * `hhh-companies-house-key-europe-west2` (pinned to London) and never leaves the server.
 */
const API_BASE = 'https://api.company-information.service.gov.uk';
const DIRECTOR_ROLES = new Set(['director', 'llp-member', 'llp-designated-member']);

/** What a lookup gives the onboarding forms. Every field can be changed by the pharmacy. */
export interface CompanyLookup {
  companyNumber: string;
  companyName: string;
  /** Companies House's own status, e.g. `active`, `dissolved`, `liquidation`. */
  status: string;
  active: boolean;
  /** One of the Worldpay form's business types, or null when none fits. */
  businessType: 'Ltd Co' | 'LLP' | 'PLC' | null;
  /** `YYYY-MM-DD`, the date the company was incorporated. */
  incorporatedOn: string | null;
  registeredAddress: string;
  directors: CompanyDirector[];
}

export interface CompanyDirector {
  firstNames: string;
  surname: string;
  nationality: string;
  countryOfResidence: string;
}

type RawAddress = {
  care_of?: string;
  premises?: string;
  address_line_1?: string;
  address_line_2?: string;
  locality?: string;
  region?: string;
  postal_code?: string;
  country?: string;
};

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

function line(value: string | undefined) {
  return value?.trim() ?? '';
}

export function formatAddress(address: RawAddress | undefined): string {
  if (!address) return '';
  const street = [line(address.premises), line(address.address_line_1)].filter(Boolean).join(' ');
  return [line(address.care_of) && `c/o ${line(address.care_of)}`, street, line(address.address_line_2), line(address.locality), line(address.region), line(address.postal_code)]
    .filter(Boolean)
    .join(', ');
}

function businessType(type: string | undefined): CompanyLookup['businessType'] {
  if (type === 'plc') return 'PLC';
  if (type === 'llp') return 'LLP';
  if (type === 'ltd' || type === 'private-limited-guarant-nsc' || type === 'private-limited-guarant-nsc-limited-exemption' || type === 'private-limited-shares-section-30-exemption') return 'Ltd Co';
  return null;
}

/** "SMITH, John Paul" → { firstNames: "John Paul", surname: "Smith" }. */
export function splitOfficerName(name: string): Pick<CompanyDirector, 'firstNames' | 'surname'> {
  const [surname, ...rest] = name.split(',');
  return { firstNames: rest.join(',').trim(), surname: titleCase((surname ?? '').trim()) };
}

export function mapCompany(profile: RawProfile, officers: RawOfficer[]): CompanyLookup {
  const status = profile.company_status ?? 'unknown';
  return {
    companyNumber: profile.company_number ?? '',
    companyName: profile.company_name?.trim() ?? '',
    status,
    active: status === 'active',
    businessType: businessType(profile.type),
    incorporatedOn: profile.date_of_creation && /^\d{4}-\d{2}-\d{2}$/.test(profile.date_of_creation) ? profile.date_of_creation : null,
    registeredAddress: formatAddress(profile.registered_office_address),
    directors: officers
      .filter(officer => !officer.resigned_on && DIRECTOR_ROLES.has(officer.officer_role ?? '') && officer.name)
      .map(officer => ({
        ...splitOfficerName(officer.name ?? ''),
        nationality: officer.nationality?.trim() ?? '',
        countryOfResidence: officer.country_of_residence?.trim() ?? '',
      })),
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

const UNAVAILABLE = 'Companies House could not be reached just now. Fill the form in yourself, or try again in a minute.';

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
    throw new HttpError(404, `No company on Companies House has the number ${number}. Check it, or skip this and fill the form in.`, 'COMPANY_NOT_FOUND');
  }
  if (!profileResponse.ok) throw new HttpError(503, UNAVAILABLE, 'COMPANIES_HOUSE_UNAVAILABLE');
  const profile = await profileResponse.json() as RawProfile;

  // Directors are a bonus: without them the company details still fill in.
  let officers: RawOfficer[] = [];
  const officersResponse = await get(`/company/${number}/officers?items_per_page=100`).catch(() => null);
  if (officersResponse?.ok) {
    const body = await officersResponse.json().catch(() => null) as { items?: RawOfficer[] } | null;
    officers = Array.isArray(body?.items) ? body.items : [];
  }
  return mapCompany(profile, officers);
}
