import { createHmac, timingSafeEqual } from 'node:crypto';
import { resolveOwnerUid } from './pharmacy-owner.js';

/**
 * A PharmSmart login is `https://portal.holistichealthhub.live/login?token={TOKEN}`.
 * This server posts that opaque token to PharmSmart and reads the pharmacy GPhC.
 * The GPhC is the match. PharmSmart's pharmacy id is their identifier, not ours.
 * Email and name in the query string are not a login.
 * They identify the PharmSmart person, who gets their own SSO account on that pharmacy.
 */

export type PharmsmartSsoContract = {
  redeemable: true;
  pharmacyDetailsAuthenticated: true;
  matchKey: 'gphc';
  pharmsmartPharmacyId: 'external';
  acceptsEmailNameQuery: false;
};

export function pharmsmartSsoContract(): PharmsmartSsoContract {
  return {
    redeemable: true,
    pharmacyDetailsAuthenticated: true,
    matchKey: 'gphc',
    pharmsmartPharmacyId: 'external',
    acceptsEmailNameQuery: false,
  };
}

/**
 * Curaleaf account form values PharmSmart can pass through. Only keys PharmSmart
 * actually sent are present, so the form leaves the rest for the pharmacy to type.
 */
export type PharmsmartPrefill = Partial<Record<
  | 'pharmacyName'
  | 'registeredCompanyName'
  | 'deliveryAddress'
  | 'invoiceAddress'
  | 'pharmacyPhone'
  | 'pharmacyEmail'
  | 'accountsEmail'
  | 'accountsPhone'
  | 'faxNumber'
  | 'wdaNumber'
  | 'licenceDetails'
  | 'superintendentFirstName'
  | 'superintendentLastName'
  | 'superintendentEmail'
  | 'superintendentPhone',
  string
>>;

export type PharmsmartPharmacyInfo =
  | {
    status: 'pharmacy';
    gphcNumber: string;
    pharmsmartPharmacyId: string | null;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    prefill: PharmsmartPrefill;
  }
  | { status: 'expired' }
  | { status: 'rejected' };

function responseText(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return value.trim();
  return '';
}

/**
 * PharmSmart returns HTTP 200 for both results. The body's status_code is the result.
 * Their JSON may start with a byte-order mark.
 * Email and name are the person, not the pharmacy match, and not a query-string login.
 */
export function parsePharmsmartPharmacyInfo(body: string): PharmsmartPharmacyInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.replace(/^\uFEFF/, '').trim());
  } catch {
    return { status: 'rejected' };
  }
  if (!parsed || typeof parsed !== 'object') return { status: 'rejected' };
  const record = parsed as { status_code?: unknown; data?: unknown };
  const statusCode = Number(record.status_code);
  if (statusCode === 401) return { status: 'expired' };
  if (statusCode !== 200 || !record.data || typeof record.data !== 'object') return { status: 'rejected' };
  const data = record.data as { gphc?: unknown; pharmacy_id?: unknown; email?: unknown; first_name?: unknown; last_name?: unknown };
  const gphcNumber = responseText(data.gphc);
  if (!gphcNumber) return { status: 'rejected' };
  const pharmsmartPharmacyId = responseText(data.pharmacy_id) || null;
  const email = responseText(data.email).toLowerCase() || null;
  return {
    status: 'pharmacy',
    gphcNumber,
    pharmsmartPharmacyId,
    email,
    firstName: responseText(data.first_name) || null,
    lastName: responseText(data.last_name) || null,
    prefill: parsePharmsmartPrefill(record.data as Record<string, unknown>),
  };
}

/**
 * Form field, then the PharmSmart keys that fill it in order of preference, then the length cap.
 * The first key of each row is what IIH sent on 18 Nov 2026; the rest are the names we asked
 * for on 16 Nov, kept so either works.
 */
const PREFILL_KEYS: ReadonlyArray<[keyof PharmsmartPrefill, readonly string[], number]> = [
  ['pharmacyName', ['trading_name', 'pharmacy_name'], 160],
  ['registeredCompanyName', ['company_name'], 160],
  ['pharmacyPhone', ['phone', 'pharmacy_phone'], 40],
  // IIH say the top-level `email` is the branch email. It is still also read as the person's
  // login email (see parsePharmsmartPharmacyInfo) until they confirm which it is.
  ['pharmacyEmail', ['pharmacy_email', 'email'], 254],
  ['accountsEmail', ['accounts_email'], 254],
  ['accountsPhone', ['accounts_phone'], 40],
  ['faxNumber', ['fax'], 40],
  ['wdaNumber', ['wda_number'], 40],
  ['licenceDetails', ['cd_licence_number'], 500],
];

const SUPERINTENDENT_KEYS: ReadonlyArray<[keyof PharmsmartPrefill, string, number]> = [
  ['superintendentFirstName', 'first_name', 80],
  ['superintendentLastName', 'last_name', 80],
  ['superintendentEmail', 'email', 254],
  ['superintendentPhone', 'pms_contact_no', 40],
];

function firstText(data: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const text = responseText(data[key]);
    if (text) return text;
  }
  return '';
}

/** Join address parts, dropping blanks and any part already included. */
function joinParts(parts: readonly string[]) {
  const kept: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (kept.some(existing => existing.toLowerCase() === part.toLowerCase())) continue;
    kept.push(part);
  }
  return kept.join(', ').slice(0, 500);
}

function joinAddress(data: Record<string, unknown>, prefix: 'branch' | 'invoice') {
  return joinParts([`${prefix}_address_line1`, `${prefix}_address_line2`, `${prefix}_town`, `${prefix}_postcode`]
    .map(key => responseText(data[key])));
}

/** IIH's branch address: address1-3, town, postcode. `country` is a UK nation; neither form asks for it. */
function branchAddress(data: Record<string, unknown>) {
  return joinParts(['address1', 'address2', 'address3', 'town', 'postcode'].map(key => responseText(data[key])));
}

/**
 * Missing, null, empty or non-text values are left out, so the form leaves that field blank.
 * Values are not checked for format: the forms ask the pharmacy to review what was filled in.
 */
export function parsePharmsmartPrefill(data: Record<string, unknown>): PharmsmartPrefill {
  const prefill: PharmsmartPrefill = {};
  for (const [field, keys, max] of PREFILL_KEYS) {
    const text = firstText(data, keys);
    if (text) prefill[field] = text.slice(0, max);
  }
  const deliveryAddress = branchAddress(data) || joinAddress(data, 'branch');
  if (deliveryAddress) prefill.deliveryAddress = deliveryAddress;
  const invoiceAddress = joinAddress(data, 'invoice');
  if (invoiceAddress) prefill.invoiceAddress = invoiceAddress;
  const superintendent = data.superintendent;
  if (superintendent && typeof superintendent === 'object') {
    for (const [field, key, max] of SUPERINTENDENT_KEYS) {
      const text = responseText((superintendent as Record<string, unknown>)[key]);
      if (text) prefill[field] = text.slice(0, max);
    }
  }
  return prefill;
}

export function pharmsmartDisplayName(person: { firstName: string | null; lastName: string | null }) {
  return [person.firstName, person.lastName].filter((part): part is string => Boolean(part)).join(' ').replace(/\s+/g, ' ').trim();
}

function personNameKey(value: string | null | undefined) {
  const compact = value?.replace(/\s+/g, ' ').trim().toLowerCase();
  return compact && compact.length >= 2 ? compact : null;
}

function personEmail(value: string | null | undefined) {
  const email = value?.trim().toLowerCase() ?? '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export type PharmsmartSetupGap = 'email' | 'name';

export function pharmsmartSetupGaps(person: { email: string | null; firstName: string | null; lastName: string | null }): PharmsmartSetupGap[] {
  const missing: PharmsmartSetupGap[] = [];
  if (!personEmail(person.email)) missing.push('email');
  if (!personNameKey(pharmsmartDisplayName(person))) missing.push('name');
  return missing;
}

export type PharmsmartStaffCandidate = {
  uid: string;
  organisationId?: string | null;
  email: string;
  displayName: string;
  role: 'HHH_ADMIN' | 'PHARMACY_STAFF';
  status: 'INVITED' | 'ACTIVE' | 'DISABLED' | 'REMOVED';
  disabled: boolean;
};

export type PharmsmartAccountChoice =
  | { action: 'use'; uid: string }
  | { action: 'create' }
  | { action: 'setup'; missing: PharmsmartSetupGap[] }
  | { action: 'blocked'; reason: 'EMAIL_IN_USE' | 'ACCOUNT_DISABLED' };

function usablePharmacyStaff(member: PharmsmartStaffCandidate, organisationId: string) {
  return member.organisationId === organisationId
    && member.role === 'PHARMACY_STAFF'
    && !member.disabled
    && member.status !== 'REMOVED'
    && member.status !== 'DISABLED';
}

/**
 * A PharmSmart person signs into their own account on the GPhC pharmacy.
 * The same email is the same person. A unique display name reuses that staff
 * record. Anyone else gets a new SSO account. The pharmacy inbox is not involved.
 */
export function choosePharmsmartAccount(input: {
  organisationId: string;
  person: { email: string | null; firstName: string | null; lastName: string | null };
  staff: readonly PharmsmartStaffCandidate[];
  emailOwner: PharmsmartStaffCandidate | 'unlinked' | null;
}): PharmsmartAccountChoice {
  const email = personEmail(input.person.email);
  if (input.emailOwner === 'unlinked') return { action: 'blocked', reason: 'EMAIL_IN_USE' };
  if (input.emailOwner) {
    if (input.emailOwner.disabled || input.emailOwner.status === 'DISABLED' || input.emailOwner.status === 'REMOVED') {
      return { action: 'blocked', reason: 'ACCOUNT_DISABLED' };
    }
    if (input.emailOwner.role !== 'PHARMACY_STAFF' || input.emailOwner.organisationId !== input.organisationId) {
      return { action: 'blocked', reason: 'EMAIL_IN_USE' };
    }
    return { action: 'use', uid: input.emailOwner.uid };
  }

  const nameKey = personNameKey(pharmsmartDisplayName(input.person));
  if (nameKey) {
    const named = input.staff.filter(member =>
      usablePharmacyStaff(member, input.organisationId) && personNameKey(member.displayName) === nameKey,
    );
    if (named.length === 1 && named[0]) return { action: 'use', uid: named[0].uid };
  }

  const missing = pharmsmartSetupGaps({ ...input.person, email });
  if (missing.length > 0) return { action: 'setup', missing };
  if (!email) return { action: 'setup', missing: ['email'] };
  return { action: 'create' };
}

const SETUP_TICKET_MS = 10 * 60 * 1000;

export type PharmsmartSetupClaims = {
  organisationId: string;
  pharmsmartPharmacyId: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  exp: number;
};

export function issuePharmsmartSetupTicket(claims: Omit<PharmsmartSetupClaims, 'exp'>, secret: string, now = Date.now()) {
  const payload: PharmsmartSetupClaims = { ...claims, exp: now + SETUP_TICKET_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function readPharmsmartSetupTicket(ticket: string, secret: string, now = Date.now()): PharmsmartSetupClaims | null {
  const [body, signature, extra] = ticket.split('.');
  if (!body || !signature || extra) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<PharmsmartSetupClaims>;
    if (!parsed.organisationId || typeof parsed.exp !== 'number' || parsed.exp < now) return null;
    return {
      organisationId: parsed.organisationId,
      pharmsmartPharmacyId: parsed.pharmsmartPharmacyId ?? null,
      email: parsed.email ?? null,
      firstName: parsed.firstName ?? null,
      lastName: parsed.lastName ?? null,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}

const PHARMSMART_SSO_MAX_AGE_MS = 5 * 60 * 1000;

/** PharmSmart already completed 2FA. A session from that redemption does not ask for TOTP again. */
export function isPharmsmartSsoSignIn(decoded: {
  pharmsmartSso?: unknown;
  auth_time?: number;
  firebase?: { sign_in_provider?: unknown };
}, now = Date.now()) {
  if (decoded.pharmsmartSso !== true) return false;
  if (decoded.firebase?.sign_in_provider !== 'custom') return false;
  if (typeof decoded.auth_time !== 'number' || !Number.isFinite(decoded.auth_time)) return false;
  const ageMs = now - decoded.auth_time * 1000;
  return ageMs >= 0 && ageMs <= PHARMSMART_SSO_MAX_AGE_MS;
}

export type ExistingPharmacyLink = {
  id: string;
  gphcNumber: string;
  pharmsmartPharmacyId?: string | null;
};

export type PharmacyLinkIdentity = {
  gphcNumber?: string | null;
  pharmsmartPharmacyId?: string | null;
};

export type ExistingPharmacyMatch =
  | { status: 'matched'; organisationId: string }
  | { status: 'unmatched'; reason: 'IDENTITY_REQUIRED' | 'NOT_FOUND' | 'AMBIGUOUS' };

function identityValue(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function uniqueMatch(pharmacies: readonly ExistingPharmacyLink[], predicate: (pharmacy: ExistingPharmacyLink) => boolean) {
  const matches = pharmacies.filter(predicate);
  if (matches.length === 0) return null;
  if (matches.length > 1) return 'ambiguous' as const;
  return matches[0] ?? null;
}

/**
 * Attach a Pharmsmart login to a pharmacy that already exists.
 * GPhC or a stored Pharmsmart pharmacy id are the only keys. A trading name is not an input,
 * and this never returns a new organisation to insert.
 */
export function matchExistingPharmacyForPharmsmart(
  pharmacies: readonly ExistingPharmacyLink[],
  identity: PharmacyLinkIdentity,
): ExistingPharmacyMatch {
  const gphcNumber = identityValue(identity.gphcNumber);
  const pharmsmartPharmacyId = identityValue(identity.pharmsmartPharmacyId);
  if (!gphcNumber && !pharmsmartPharmacyId) {
    return { status: 'unmatched', reason: 'IDENTITY_REQUIRED' };
  }

  const byGphc = gphcNumber
    ? uniqueMatch(pharmacies, pharmacy => identityValue(pharmacy.gphcNumber) === gphcNumber)
    : null;
  const byPharmsmartId = pharmsmartPharmacyId
    ? uniqueMatch(pharmacies, pharmacy => identityValue(pharmacy.pharmsmartPharmacyId) === pharmsmartPharmacyId)
    : null;

  if (byGphc === 'ambiguous' || byPharmsmartId === 'ambiguous') {
    return { status: 'unmatched', reason: 'AMBIGUOUS' };
  }
  if (byGphc && byPharmsmartId && byGphc.id !== byPharmsmartId.id) {
    return { status: 'unmatched', reason: 'AMBIGUOUS' };
  }
  const match = byGphc ?? byPharmsmartId;
  if (!match) return { status: 'unmatched', reason: 'NOT_FOUND' };
  return { status: 'matched', organisationId: match.id };
}

/** Compact a GPhC so "123 4471" and "1234471" are the same premises number. */
export function normaliseGphcNumber(value: string | null | undefined) {
  const compact = value?.replace(/\s+/g, '').trim().toLowerCase();
  return compact || null;
}

/**
 * Find the Holistic Health Hub pharmacy by GPhC.
 * PharmSmart's pharmacy id is not consulted: it is their identifier, not our organisation id.
 */
export function matchPharmacyByGphc(
  pharmacies: readonly ExistingPharmacyLink[],
  gphcNumber: string,
): ExistingPharmacyMatch {
  const wanted = normaliseGphcNumber(gphcNumber);
  if (!wanted) return { status: 'unmatched', reason: 'IDENTITY_REQUIRED' };
  return matchExistingPharmacyForPharmsmart(
    pharmacies.map(pharmacy => ({
      ...pharmacy,
      gphcNumber: normaliseGphcNumber(pharmacy.gphcNumber) ?? pharmacy.gphcNumber,
      pharmsmartPharmacyId: null,
    })),
    { gphcNumber: wanted },
  );
}

export type PharmacyLoginStaff = {
  uid: string;
  organisationId?: string | null;
  role: 'HHH_ADMIN' | 'PHARMACY_STAFF';
  status: 'INVITED' | 'ACTIVE' | 'DISABLED' | 'REMOVED';
  disabled: boolean;
  createdAt?: string | null;
};

/**
 * The session account is the pharmacy's existing login: the assigned owner when that
 * account is active, otherwise the earliest active pharmacy account. Invited, disabled,
 * and admin accounts are not signed in from a PharmSmart token.
 */
export function pharmacyLoginAccount(input: {
  organisationId: string;
  primaryContactUid?: string | null;
  staff: readonly PharmacyLoginStaff[];
}): { status: 'account'; uid: string } | { status: 'unavailable' } {
  const usable = input.staff.filter(member =>
    member.organisationId === input.organisationId
    && member.role === 'PHARMACY_STAFF'
    && member.status === 'ACTIVE'
    && !member.disabled,
  );
  const uid = resolveOwnerUid(usable, input.primaryContactUid);
  if (!uid) return { status: 'unavailable' };
  return { status: 'account', uid };
}

/**
 * The PharmSmart contact email does not become a Holistic Health Hub login.
 * The session uses the pharmacy's existing account.
 */
export function pharmacyStaffEmails(input: {
  invitedEmails: readonly string[];
  ssoEmail?: string | null;
  ssoRedeemable?: boolean;
}) {
  void input.ssoEmail;
  void input.ssoRedeemable;
  return input.invitedEmails
    .map(email => email.trim().toLowerCase())
    .filter(email => email.length > 0);
}
