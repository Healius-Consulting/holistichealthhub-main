import { z } from 'zod';
import { HttpError } from '../../domain/common/errors.js';
import { isEligibleAge } from '../../domain/eligibility/age.js';
import { normaliseUkPostcode } from '../../domain/geography/postcode.js';
import type { PatientRecord } from '../../repositories/ports/patient.port.js';

/**
 * HHH admin correcting a patient's own details: name, date of birth, email,
 * mobile and postcode. Same rules as the public form, so an edit can never
 * produce a record the form would have refused.
 */
export const patientDetailsInputSchema = z.object({
  firstName: z.string().trim().min(1, 'Enter a first name.').max(100),
  surname: z.string().trim().min(1, 'Enter a surname.').max(100),
  dob: z.iso.date().refine(value => isEligibleAge(value), { message: 'The patient must be 18 or over.' }),
  email: z.string().trim().pipe(z.email('Enter a valid email address.').max(254)),
  mobile: z.string().trim().min(7, 'Enter a valid mobile number.').max(30),
  postcode: z.string().trim().min(2).max(16),
}).strict();

export type PatientDetailsInput = z.infer<typeof patientDetailsInputSchema>;
export type PatientDetails = Pick<PatientRecord, 'firstName' | 'surname' | 'dob' | 'email' | 'mobile' | 'postcode'>;

const FIELDS = ['firstName', 'surname', 'dob', 'email', 'mobile', 'postcode'] as const;

/** Trim, lower-case the email and format the postcode the way the public form stores them. */
export function normalisePatientDetails(input: PatientDetailsInput): PatientDetails {
  return {
    firstName: input.firstName.trim(),
    surname: input.surname.trim(),
    dob: input.dob,
    email: input.email.trim().toLowerCase(),
    mobile: input.mobile.trim(),
    postcode: normaliseUkPostcode(input.postcode),
  };
}

/** Which fields actually differ, for the audit log. Email compares case-blind. */
export function changedPatientFields(before: PatientDetails, after: PatientDetails): Array<(typeof FIELDS)[number]> {
  return FIELDS.filter(field => {
    const left = String(before[field] ?? '').trim();
    const right = String(after[field] ?? '').trim();
    return field === 'email' ? left.toLowerCase() !== right.toLowerCase() : left !== right;
  });
}

/**
 * The pharmacy holds one record per person, keyed on email and date of birth.
 * Refuse an edit that would make this patient look like another of its patients.
 */
export function assertNoIdentityClash(patientId: string, next: PatientDetails, others: PatientRecord[]) {
  const clash = others.find(other => other.id !== patientId
    && other.email.trim().toLowerCase() === next.email
    && other.dob === next.dob);
  if (clash) {
    throw new HttpError(409, 'Another patient at this pharmacy already has that email and date of birth.', 'PATIENT_IDENTITY_CLASH');
  }
}
