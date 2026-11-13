import { z } from 'zod';
import { normaliseGphcNumber } from '../identity/pharmsmart-sso.js';

export const MAX_LICENCE_BYTES = 4_000_000;

export const PHARMACY_ONBOARDING_FIELDS = [
  'pharmacistName',
  'pharmacyName',
  'registeredCompanyName',
  'invoiceAddress',
  'deliveryAddress',
  'gphcNumber',
  'wdaNumber',
  'licenceDetails',
  'pharmacyEmail',
  'accountsEmail',
  'pharmacyPhone',
  'accountsPhone',
  'faxNumber',
  'signatureName',
  'idempotencyKey',
] as const;

const optionalFax = z.string().trim().max(40).optional().or(z.literal(''));

export const pharmacyOnboardingFieldsSchema = z.object({
  pharmacistName: z.string().trim().min(2).max(160),
  pharmacyName: z.string().trim().min(2).max(160),
  registeredCompanyName: z.string().trim().min(2).max(160),
  invoiceAddress: z.string().trim().min(5).max(500),
  deliveryAddress: z.string().trim().min(5).max(500),
  gphcNumber: z.string().trim().min(3).max(40),
  wdaNumber: z.string().trim().max(40).optional().or(z.literal('')),
  licenceDetails: z.string().trim().max(500).optional().or(z.literal('')),
  pharmacyEmail: z.string().trim().email().max(254),
  accountsEmail: z.string().trim().email().max(254),
  pharmacyPhone: z.string().trim().min(8).max(40),
  accountsPhone: z.string().trim().min(8).max(40),
  faxNumber: optionalFax,
  signatureName: z.string().trim().min(2).max(160),
  idempotencyKey: z.string().trim().min(8).max(128),
});

export type PharmacyOnboardingFields = z.infer<typeof pharmacyOnboardingFieldsSchema>;

export type PharmacyOnboardingStatus = 'PENDING' | 'ACTIVATED' | 'DECLINED';

export type PharmacyOnboardingRequestRecord = {
  id: string;
  status: PharmacyOnboardingStatus;
  pharmacistName: string;
  pharmacyName: string;
  registeredCompanyName: string;
  invoiceAddress: string;
  deliveryAddress: string;
  gphcNumber: string;
  wdaNumber: string;
  licenceDetails: string;
  pharmacyEmail: string;
  accountsEmail: string;
  pharmacyPhone: string;
  accountsPhone: string;
  faxNumber: string | null;
  signatureName: string;
  signedOn: string;
  licenceStoragePath: string;
  licenceContentType: string;
  licenceFilename: string;
  filledFormStoragePath: string;
  organisationId: string | null;
  declineReason: string | null;
  decidedAt: string | null;
  decidedByUid: string | null;
  idempotencyKey: string;
  createdAt: string | null;
};

/** Compact the GPhC the same way PharmSmart matching does, and keep it as stored. */
export function compactGphcNumber(value: string) {
  const compact = normaliseGphcNumber(value);
  if (!compact || compact.length < 3 || compact.length > 40) return null;
  return compact;
}

/** Two letters for the pharmacy mark, matching the admin onboarding form. */
export function onboardingLogoText(name: string) {
  const initials = name.split(/\s+/).map(part => part.replace(/[^A-Za-z0-9]/g, '').charAt(0)).filter(Boolean).join('');
  return (initials || name.replace(/[^A-Za-z0-9]/g, '') || 'RX').slice(0, 2).toUpperCase();
}

export function londonCalendarDate(now: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function londonLongDate(now: Date) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now);
}

export function publicOnboardingStatus(status: PharmacyOnboardingStatus): 'pending' | 'activated' | 'declined' {
  if (status === 'ACTIVATED') return 'activated';
  if (status === 'DECLINED') return 'declined';
  return 'pending';
}
