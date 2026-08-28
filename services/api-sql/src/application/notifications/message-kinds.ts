export const EMAIL_TEMPLATE_CODES = [
  'patient_referred',
  'patient_payment_request',
  'patient_payment_confirmation',
  'patient_refunded',
  'patient_ready_for_collection',
  'admin_new_enquiry_received',
  'pharmacy_staff_invite',
  'pharmacy_password_reset',
  'pharmacy_2fa_enabled',
  'pharmacy_2fa_disabled',
  'pharmacy_new_patient_referred',
  'pharmacy_payment_received',
  'pharmacy_order_accepted',
  'pharmacy_order_cancelled',
  'pharmacy_delivery_issue',
  'pharmacy_order_dispatched',
  'pharmacy_prescription_close_to_expiry',
  'pharmacy_collection_completed',
] as const;

export type EmailTemplateCode = (typeof EMAIL_TEMPLATE_CODES)[number];

export const PATIENT_MESSAGE_KINDS = [
  'patient_referred',
  'patient_payment_request',
  'patient_payment_confirmation',
  'patient_refunded',
  'patient_ready_for_collection',
] as const;

export type PatientMessageKind = (typeof PATIENT_MESSAGE_KINDS)[number];

export function isEmailTemplateCode(value: string): value is EmailTemplateCode {
  return (EMAIL_TEMPLATE_CODES as readonly string[]).includes(value);
}

export function isPatientMessageKind(value: string): value is PatientMessageKind {
  return (PATIENT_MESSAGE_KINDS as readonly string[]).includes(value);
}

export function messageIdempotencyKey(parts: Array<string | number | null | undefined>) {
  return parts.map(part => String(part ?? '')).join(':').slice(0, 180);
}

export const patientMessageIdempotencyKey = messageIdempotencyKey;
