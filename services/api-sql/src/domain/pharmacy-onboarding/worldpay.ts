import { z } from 'zod';

/**
 * Worldpay card processing questionnaire, filled in on the onboarding page.
 *
 * These answers hold bank details and the principals' identity details. They are
 * turned into a PDF, emailed, and dropped (decided 16 Nov 2026). Only a note that
 * the form was sent is stored, never the answers.
 */

const text = (max: number) => z.string().trim().max(max);
const required = (max: number) => z.string().trim().min(1).max(max);
const optional = (max: number) => text(max).optional().default('');
const percent = z.coerce.number().int().min(0).max(100);

export const WORLDPAY_DEFAULTS = {
  natureOfBusiness: '47730 - Dispensing chemist in specialised stores',
  terminalConnection: 'Not required',
  faceToFacePercent: 0,
  phonePercent: 0,
  internetPercent: 100,
  immediatePercent: 0,
  oneToThreeDaysPercent: 100,
  threeToFiveDaysPercent: 0,
  fivePlusDaysPercent: 0,
  annualCardTurnover: '250000',
  averageTransaction: '187',
  takeAmex: 'No',
  salesCountries: 'Sales are limited to the UK only.',
  noUsSales: 'Confirmed.',
  complianceConfirmations: 'All confirmed.',
  registrationFees: 'Confirmed. However, Mastercard will not be used. Pharmacy GPhC registration number found above.',
  onlineConsultations: 'No online consultations are provided by the pharmacy.',
} as const;

export const worldpayPrincipalSchema = z.object({
  title: optional(20),
  firstNames: required(120),
  surname: required(120),
  dateOfBirth: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date of birth.'),
  nationality: required(80),
  homeAddress: required(300),
  countryOfResidence: required(80),
  yearsAtAddress: required(20),
  previousAddress: optional(300),
  mobile: required(40),
  email: z.string().trim().email().max(254),
  shareholding: required(20),
});

export const worldpayFormSchema = z.object({
  legalName: required(160),
  tradingName: required(160),
  contactName: required(160),
  contactPosition: required(120),
  contactPhone: required(40),
  businessType: required(80),
  registrationNumber: optional(40),
  registeredAddress: required(300),
  natureOfBusiness: required(160),
  gphcNumber: z.string().trim().min(3).max(40),
  tradingAddress: required(300),
  landline: optional(40),
  mobile: optional(40),
  businessEmail: z.string().trim().email().max(254),
  website: optional(200),
  vatNumber: optional(40),
  tradingSince: optional(40),

  principals: z.array(worldpayPrincipalSchema).min(1).max(4),

  terminalConnection: required(80),
  faceToFacePercent: percent,
  phonePercent: percent,
  internetPercent: percent,
  immediatePercent: percent,
  oneToThreeDaysPercent: percent,
  threeToFiveDaysPercent: percent,
  fivePlusDaysPercent: percent,

  annualTurnover: required(40),
  annualCardTurnover: required(40),
  averageTransaction: required(40),
  takeAmex: z.enum(['Yes', 'No']),

  bankName: required(120),
  accountName: required(160),
  accountNumber: z.string().trim().transform(value => value.replace(/\s/g, '')).pipe(z.string().regex(/^\d{8}$/, 'Enter the 8-digit account number.')),
  sortCode: z.string().trim().transform(value => value.replace(/[\s-]/g, '')).pipe(z.string().regex(/^\d{6}$/, 'Enter the 6-digit sort code.')),

  salesCountries: required(500),
  noUsSales: required(200),
  complianceConfirmations: required(500),
  registrationFees: required(500),
  onlineConsultations: required(800),

  idempotencyKey: z.string().trim().min(8).max(128),
}).superRefine((form, ctx) => {
  if (form.faceToFacePercent + form.phonePercent + form.internetPercent !== 100) {
    ctx.addIssue({ code: 'custom', path: ['internetPercent'], message: 'How transactions are taken must add up to 100%.' });
  }
  if (form.immediatePercent + form.oneToThreeDaysPercent + form.threeToFiveDaysPercent + form.fivePlusDaysPercent !== 100) {
    ctx.addIssue({ code: 'custom', path: ['fivePlusDaysPercent'], message: 'When customers receive their goods must add up to 100%.' });
  }
});

export type WorldpayForm = z.infer<typeof worldpayFormSchema>;
export type WorldpayPrincipal = z.infer<typeof worldpayPrincipalSchema>;

/** The only thing kept about a Worldpay form: who sent it and when. */
export type WorldpaySubmissionNote = {
  id: string;
  gphcNumber: string;
  /** The branch, when the form was sent from the pharmacy portal. */
  organisationId?: string | null;
  tradingName: string;
  submittedAt: string;
  idempotencyKey: string;
};

export function formatSortCode(sortCode: string) {
  return sortCode.replace(/^(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3');
}
