import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { normaliseGphcNumber } from '../identity/pharmsmart-sso.js';

export const PARTNER_TERMS_SIGNER_ROLES = [
  'SUPERINTENDENT_PHARMACIST',
  'PHARMACIST',
  'DIRECTOR',
  'PHARMACY_MANAGER',
  'OTHER',
] as const;

export type PartnerTermsSignerRole = (typeof PARTNER_TERMS_SIGNER_ROLES)[number];

/** A pharmacist signs with their own GPhC registration number. */
export function signerRoleIsPharmacist(role: PartnerTermsSignerRole) {
  return role === 'SUPERINTENDENT_PHARMACIST' || role === 'PHARMACIST';
}

export const partnerTermsAcceptanceSchema = z.object({
  onboardingRequestId: z.uuid(),
  /** The typed-name e-signature. */
  signerName: z.string().trim().min(2).max(160),
  signerRole: z.enum(PARTNER_TERMS_SIGNER_ROLES),
  signerEmail: z.string().trim().toLowerCase().email().max(254),
  signerGphcNumber: z.string().trim().max(40).optional().or(z.literal('')),
  /** "I confirm I am authorised to accept these terms on behalf of [registered company name]". */
  authorised: z.literal(true, { message: 'Confirm you are authorised to accept the terms.' }),
  /** Signed by the PharmSmart welcome; carries PharmSmart's names for the soft check. */
  pharmsmartTicket: z.string().max(4000).optional().or(z.literal('')),
}).superRefine((input, context) => {
  if (!signerRoleIsPharmacist(input.signerRole)) return;
  const gphc = normaliseGphcNumber(input.signerGphcNumber ?? '');
  if (!gphc || !/^\d{7}$/.test(gphc)) {
    context.addIssue({ code: 'custom', path: ['signerGphcNumber'], message: 'Enter your 7-digit GPhC registration number.' });
  }
});

export type PartnerTermsAcceptanceInput = z.infer<typeof partnerTermsAcceptanceSchema>;

export type PartnerTermsAcceptanceRecord = {
  id: string;
  onboardingRequestId: string;
  organisationId: string | null;
  termsVersion: string;
  signerName: string;
  signerRole: string;
  signerEmail: string;
  signerGphcNumber: string | null;
  registeredCompanyName: string;
  acceptedAt: string;
  ipAddress: string | null;
  source: 'signup' | 'reacceptance';
  nameMatchesPharmsmart: boolean | null;
};

function nameTokens(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/[\s'-]+/)
    .filter(Boolean);
}

/**
 * Soft check only: does the signer's typed name carry the first and last name of
 * PharmSmart's superintendent or manager? Null when PharmSmart gave no names, so
 * admin can tell "not checked" from "did not match". Never blocks the acceptance.
 */
export function signerMatchesPharmsmart(
  signerName: string,
  people: Array<{ firstName?: string | null; lastName?: string | null }>,
): boolean | null {
  const known = people
    .map(person => ({ first: nameTokens(person.firstName ?? ''), last: nameTokens(person.lastName ?? '') }))
    .filter(person => person.first.length > 0 && person.last.length > 0);
  if (known.length === 0) return null;
  const signer = new Set(nameTokens(signerName));
  return known.some(person => signer.has(person.first[0]!) && person.last.every(part => signer.has(part)));
}

/**
 * PharmSmart's superintendent and manager names, signed by the server when it builds
 * the welcome page, so the Terms step can run the soft check without trusting the
 * browser and without storing PharmSmart's response.
 */
export type PharmsmartNamesClaims = {
  gphcNumber: string;
  people: Array<{ firstName: string | null; lastName: string | null }>;
  exp: number;
};

const NAMES_TICKET_MS = 24 * 60 * 60 * 1000;

export function issuePharmsmartNamesTicket(
  claims: Omit<PharmsmartNamesClaims, 'exp'>,
  secret: string,
  now = Date.now(),
) {
  const body = Buffer.from(JSON.stringify({ ...claims, kind: 'terms-names', exp: now + NAMES_TICKET_MS })).toString('base64url');
  const signature = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function readPharmsmartNamesTicket(ticket: string, secret: string, now = Date.now()): PharmsmartNamesClaims | null {
  const [body, signature, extra] = ticket.split('.');
  if (!body || !signature || extra) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<PharmsmartNamesClaims> & { kind?: string };
    if (parsed.kind !== 'terms-names' || typeof parsed.exp !== 'number' || parsed.exp < now) return null;
    if (typeof parsed.gphcNumber !== 'string' || !Array.isArray(parsed.people)) return null;
    return {
      gphcNumber: parsed.gphcNumber,
      people: parsed.people.map(person => ({ firstName: person?.firstName ?? null, lastName: person?.lastName ?? null })),
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}
