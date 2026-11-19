import { z } from 'zod';
import type { EmailTemplateCode } from '../../application/notifications/email-catalog.js';

/**
 * Admin-editable wording for the platform's emails (Onboarding settings → Emails).
 *
 * Each email names the pieces of its wording an admin can change. A piece nobody has
 * edited is sent exactly as the code writes it today; a saved piece replaces that
 * part of the email and nothing else. Order details, amounts, buttons' links, patient
 * details and the pharmacy's signature and footer stay automatic.
 *
 * Saved wording uses the same `[Merge field]` and `[If flag]…[/If]` syntax as the
 * onboarding content, plus `**bold**`. The defaults below are today's wording in that
 * syntax: they are where the editor starts, not what is sent while unedited.
 *
 * The five partner onboarding emails and the Curaleaf application have their own
 * content (domain/pharmacy-onboarding/content.ts), and WP-01 its own (Worldpay
 * content), so they are not listed here.
 */

export const EMAIL_COPY_SLOTS = ['subject', 'preheader', 'title', 'body', 'button', 'steps', 'footer'] as const;
export type EmailCopySlot = (typeof EMAIL_COPY_SLOTS)[number];

export const EMAIL_COPY_SLOT_LABEL: Record<EmailCopySlot, string> = {
  subject: 'Subject',
  preheader: 'Inbox preview text',
  title: 'Heading',
  body: 'Message',
  button: 'Button label',
  steps: 'Steps',
  footer: 'Closing note',
};

export const EMAIL_COPY_SLOT_HINT: Partial<Record<EmailCopySlot, string>> = {
  preheader: 'The grey line most inboxes show after the subject.',
  body: 'A blank line starts a new paragraph. **Two asterisks** make text bold.',
  steps: 'A blank line starts a new step.',
  footer: 'A blank line starts a new paragraph.',
};

/** One line, or paragraphs. */
export const MULTILINE_SLOTS = new Set<EmailCopySlot>(['body', 'steps', 'footer']);

export type EmailCopyGroup = 'patient' | 'pharmacy' | 'staff' | 'admin';

export type EmailCopySpec = {
  name: string;
  group: EmailCopyGroup;
  /** When it is sent, in plain words. */
  when: string;
  /** Today's wording, as editable templates. Only these pieces can be edited. */
  defaults: Partial<Record<EmailCopySlot, string>>;
  /** Merge fields the wording can use. */
  fields: string[];
  /** Conditions the wording can use, with what each means. */
  flags?: Record<string, string>;
  /** Each step is a title line, then its text. */
  stepTitles?: boolean;
  /** The pharmacy's name is put before the subject ("Kirkgate Pharmacy: …"). */
  subjectPrefix?: boolean;
  /** Where the pharmacy's signature goes, after the edited wording. */
  signature?: 'body' | 'footer';
  /** The data the preview is drawn with. Made up: never a real patient or pharmacy. */
  sample: Record<string, unknown>;
};

const PHARMACY_SAMPLE = {
  organisationId: 'preview',
  pharmacyName: 'Kirkgate Pharmacy',
  pharmacyAddress: '12 Kirkgate, Leeds, LS1 6BY',
  pharmacyGphcNumber: '1123456',
  pharmacyPhone: '0113 496 0001',
  pharmacyPublicEmail: 'hello@kirkgate.example',
  pharmacyWebsite: 'kirkgate.example',
};

const PATIENT_SAMPLE = { ...PHARMACY_SAMPLE, firstName: 'Sam' };

const ORDER_SAMPLE = {
  ...PATIENT_SAMPLE,
  orderNumber: 'ORD-MWDPQ7RK-6EDC74',
  currency: 'GBP',
  amountPence: 14250,
  medicineTotalPence: 13000,
  dispensingFeePence: 1250,
};

const CLOSURE_FLAGS = {
  declined: 'Closed as not eligible',
  incomplete: 'Closed for missing information',
  withdrawn: 'Closed because the patient withdrew',
};

const HELP = 'For help signing in, email [Help email].';

export const EMAIL_COPY_SPECS = {
  patient_enquiry_declined: {
    name: 'Enquiry closed',
    group: 'patient',
    when: 'When HHH declines or closes a patient’s enquiry. One email with three versions; the reason recorded is never quoted.',
    subjectPrefix: true,
    signature: 'body',
    fields: ['First name', 'Pharmacy name'],
    flags: CLOSURE_FLAGS,
    defaults: {
      subject: 'Your referral enquiry',
      preheader: '[If withdrawn]Your enquiry is closed, as you asked.[/If][If declined]An update on the referral enquiry you made.[/If][If incomplete]An update on the referral enquiry you made.[/If]',
      title: 'Your referral enquiry',
      body: [
        'Dear [First name],',
        '[If declined]Thank you for your enquiry. We have looked carefully at the information you gave us and the medical records you allowed us to check, and on this occasion we are not able to refer you to our partner clinic.\n\nThis is about whether our service can refer you. It is not a diagnosis, and no one has assessed your health.\n\nWe would encourage you to speak to your GP. They know your medical history and can discuss the options available to you, including specialist referral where appropriate. If your health gets worse or you need help urgently, contact your GP or call NHS 111.\n\nIf your circumstances change, you are welcome to enquire again. If you have any questions about this email, call us or reply to it.[/If]',
        '[If incomplete]Thank you for your enquiry. We asked for some further information and have not heard back, so we have closed your enquiry for now. Nothing has been decided about your eligibility.\n\nIf you would still like to be considered, reply to this email or call us and we will pick it up where we left off. If you have any concerns about your health in the meantime, speak to your GP.[/If]',
        '[If withdrawn]As you asked, we have closed your enquiry and will not take it any further. Thank you for letting us know. If you change your mind, you are welcome to enquire again at any time. If you have any concerns about your health, speak to your GP.[/If]',
      ].join('\n\n'),
    },
    sample: { ...PATIENT_SAMPLE, variant: 'declined' },
  },
  patient_referred: {
    name: 'Referred to the clinic',
    group: 'patient',
    when: 'When HHH completes a referral to Curaleaf Clinic.',
    subjectPrefix: true,
    signature: 'footer',
    stepTitles: true,
    fields: ['First name', 'Pharmacy name'],
    defaults: {
      subject: 'Your referral — what happens next',
      preheader: 'Curaleaf Clinic will email you within two working days.',
      title: 'Your referral — what happens next',
      body: 'Dear [First name],\n\nWe have reviewed your medical records and referred you to our partner clinic, Curaleaf Clinic. Here is what happens next:',
      steps: [
        'The clinic will email you\nWithin two working days you will get an email from Curaleaf Clinic asking you to register. Check your junk or spam folder if you cannot see it. If nothing arrives, call us or reply to this email and we will chase it for you.',
        'Register and confirm who you are\nFollow the instructions in the clinic’s email to set up your Curaleaf Clinic login. You will need photo ID — a passport or driving licence — before an appointment can be booked, so have one to hand. The clinic may also ask about your health or current medicines.',
        'Book your appointment\nBook through the clinic’s website. It is a video call with a consultant doctor, so you will need a phone, tablet or computer with a camera. The doctor decides whether treatment is suitable for you. You can pay per appointment or choose one of the clinic’s payment plans — medicine is charged separately by us.',
        'We take it from there\nThe clinic sends your prescription to us. We will email you to arrange payment, and again when your medicine is ready. You do not need to do anything until you hear from us.',
      ].join('\n\n'),
      footer: '**Ongoing care.** Once you start treatment, we work with Curaleaf Clinic to keep your repeat prescriptions coming without gaps. For questions about your treatment, contact the clinic; for questions about your order or collection, contact us.\n\nIf anything is unclear, pop into the pharmacy and ask at the counter, call us, or reply to this email. We are happy to help.',
    },
    sample: PATIENT_SAMPLE,
  },
  patient_existing_clinic: {
    name: 'Already a Curaleaf Clinic patient',
    group: 'patient',
    when: 'When HHH refers a patient who already has a Curaleaf Clinic account.',
    subjectPrefix: true,
    signature: 'footer',
    stepTitles: true,
    fields: ['First name', 'Pharmacy name', 'Pharmacy address', 'Pharmacy GPhC', 'Clinic sign-in link', 'Clinic phone', 'Clinic hours', 'Clinic email'],
    defaults: {
      subject: 'Your referral — one step for you',
      preheader: 'You already have a Curaleaf Clinic account. Sign in and ask them to send prescriptions to us.',
      title: 'Your referral — one step for you',
      body: 'Dear [First name],\n\nThank you for your enquiry and for choosing us as your pharmacy. We have reviewed your information, and our partner clinic, Curaleaf Clinic, tells us **you already have an account with them, registered to this email address.** You do not need to register again.',
      steps: [
        'Sign in to your Curaleaf Clinic account\nGo to [Clinic sign-in link] and sign in with this email address. If you have forgotten your password, use the Forgotten password button on the sign-in page. If you still cannot get in, call Curaleaf Clinic on [Clinic phone] ([Clinic hours]) or email [Clinic email].',
        'Ask the clinic to send your prescriptions to us\nWhen you sign in or speak to the clinic, ask for your prescriptions to be sent to: [Pharmacy name], [Pharmacy address], GPhC number [Pharmacy GPhC]',
        'Book an appointment if you need one\nIf you have not seen a clinic doctor recently, book an appointment through the clinic’s website. The doctor will decide whether treatment is suitable for you. Medicine is charged separately by us.',
        'We take it from there\nWhen the clinic sends a prescription to us, we will email you to arrange payment, and again when your medicine is ready to collect. You do not need to do anything else.',
      ].join('\n\n'),
      footer: 'For questions about your account, treatment or appointments, contact the clinic. For questions about your order or collection, contact us or reply to this email.',
    },
    sample: PATIENT_SAMPLE,
  },
  patient_payment_request: {
    name: 'Payment needed',
    group: 'patient',
    when: 'When a card payment link is created or resent, and once more 72 hours later if it is still unpaid.',
    fields: ['First name', 'Order number', 'Amount', 'Pharmacy name'],
    defaults: {
      subject: 'Payment needed for your order',
      preheader: 'Complete payment securely so your pharmacy can continue the order.',
      title: 'Payment needed',
      body: 'Hi [First name],\n\nYour order is ready to move forward. Complete payment below and the pharmacy can continue preparing it for you.',
      button: 'Pay now',
      steps: 'Use the secure link above to complete payment.\n\nWe will confirm as soon as payment is received.\n\nThe pharmacy will continue processing your order.',
      footer: 'This is a secure payment link. If you were not expecting this email, you can ignore it.',
    },
    sample: { ...ORDER_SAMPLE, paymentUrl: 'https://payments.example/pay' },
  },
  patient_payment_confirmation: {
    name: 'Payment received (patient)',
    group: 'patient',
    when: 'When a payment is received, by card or recorded in the pharmacy.',
    fields: ['First name', 'Order number', 'Amount', 'Pharmacy name'],
    defaults: {
      subject: 'Payment received',
      preheader: 'Your payment has been confirmed.',
      title: 'Payment received',
      body: 'Hi [First name],\n\nWe have received your payment and the pharmacy can now continue processing your order.',
      button: 'Here is your receipt',
    },
    sample: { ...ORDER_SAMPLE, receiptHash: 'preview' },
  },
  patient_refunded: {
    name: 'Refund completed',
    group: 'patient',
    when: 'When the pharmacy confirms a completed refund.',
    fields: ['First name', 'Order number', 'Amount', 'Clinic', 'Clinic email', 'Clinic phone', 'Clinic hours'],
    flags: { amount: 'An amount is known', 'order number': 'An order number is known' },
    defaults: {
      subject: 'Your payment has been refunded',
      preheader: 'A refund has been completed for your order.',
      title: 'Payment refunded',
      body: 'Hi [First name],\n\nA refund[If amount] of **[Amount]**[/If] has been completed[If order number] for order **[Order number]**[/If]. It can take a few working days to appear on the original payment method.\n\nIf you need a new prescription because an item was unavailable or your prescription has expired, contact [Clinic] at [Clinic email] or [Clinic phone], [Clinic hours]. Your pharmacy can contact the clinic instead.',
      button: 'View receipt',
    },
    sample: { ...ORDER_SAMPLE, receiptHash: 'preview' },
  },
  patient_ready_for_collection: {
    name: 'Ready to collect',
    group: 'patient',
    when: 'When the order is marked ready to collect. Held until 9am the next working day if after 3pm.',
    fields: ['First name', 'Order number', 'Pharmacy name', 'Ready packs', 'Total packs'],
    flags: { partial: 'Only some packs are ready', 'all ready': 'Every pack is ready' },
    defaults: {
      subject: '[If partial]Part of your prescription is ready to collect[/If][If all ready]Your prescription is ready to collect[/If]',
      preheader: '[If partial][Ready packs] of [Total packs] packs are ready at the pharmacy.[/If][If all ready]Your order is ready at the pharmacy.[/If]',
      title: '[If partial]Part ready to collect[/If][If all ready]Ready to collect[/If]',
      body: 'Hi [First name],\n\n[If partial]**[Ready packs] of [Total packs] packs** for order **[Order number]** are ready to collect from **[Pharmacy name]**. The remaining packs are not ready yet.[/If][If all ready]Your prescription for order **[Order number]** is ready to collect from **[Pharmacy name]**. Please bring photo ID.[/If]',
      steps: 'Bring photo ID when you collect.\n\nAsk at the pharmacy counter if you are unsure where to go.',
    },
    sample: ORDER_SAMPLE,
  },

  pharmacy_new_enquiry_assigned: {
    name: 'New enquiry assigned',
    group: 'pharmacy',
    when: 'To the pharmacy when an eligibility enquiry is assigned to it.',
    fields: ['Pharmacy name', 'Case reference'],
    flags: { 'case reference': 'A reference is known' },
    defaults: {
      subject: 'New enquiry assigned to your pharmacy',
      preheader: 'An eligibility enquiry is waiting in Patients.',
      title: 'New enquiry assigned',
      body: 'A new eligibility enquiry has been assigned to **[Pharmacy name]**[If case reference] (**[Case reference]**)[/If].\n\nOpen Patients to see the form answers. HHH may still move or complete this enquiry.',
      button: 'Open portal',
    },
    sample: { ...PHARMACY_SAMPLE, caseReference: 'HHH-24817' },
  },
  pharmacy_enquiry_declined: {
    name: 'Enquiry declined by HHH',
    group: 'pharmacy',
    when: 'To the pharmacy when HHH declines an enquiry that was assigned to it.',
    fields: ['Pharmacy name', 'Case reference'],
    flags: { 'case reference': 'A reference is known' },
    defaults: {
      subject: 'Enquiry declined by HHH',
      preheader: 'This enquiry is no longer assigned to your pharmacy.',
      title: 'Enquiry declined',
      body: 'HHH declined an eligibility enquiry previously assigned to **[Pharmacy name]**[If case reference] (**[Case reference]**)[/If].\n\nIt is no longer in New enquiries.',
      button: 'Open portal',
    },
    sample: { ...PHARMACY_SAMPLE, caseReference: 'HHH-24817' },
  },
  pharmacy_new_patient_referred: {
    name: 'New patient referred',
    group: 'pharmacy',
    when: 'To the pharmacy when HHH activates a referred patient for it. The patient’s details are added below the message automatically.',
    fields: ['Pharmacy name', 'Patient name'],
    flags: { 'patient name': 'The patient’s name is known', 'no patient name': 'The patient’s name is not known' },
    defaults: {
      subject: 'New patient referred[If patient name] — [Patient name][/If]',
      preheader: '[If patient name][Patient name] has been referred to your pharmacy.[/If][If no patient name]A new referral is waiting in the portal.[/If]',
      title: 'New patient referred',
      body: 'A new patient has been referred to **[Pharmacy name]**.',
      button: 'Open portal',
      footer: 'Their form answers and the full record are in the portal.',
    },
    sample: { ...PHARMACY_SAMPLE, firstName: 'Sam', surname: 'Taylor', dob: '1988-03-14', mobile: '07700 900123', email: 'sam@example.com', caseReference: 'HHH-24817' },
  },
  pharmacy_payment_received: {
    name: 'Payment received (pharmacy)',
    group: 'pharmacy',
    when: 'To the pharmacy when a patient payment is recorded.',
    fields: ['Order number', 'Amount'],
    flags: { amount: 'An amount is known', 'order number': 'An order number is known' },
    defaults: {
      subject: 'Payment received',
      preheader: 'A patient payment has been recorded.',
      title: 'Payment received',
      body: 'A patient payment has been recorded[If amount]: **[Amount]**[/If][If order number] for order **[Order number]**[/If].',
    },
    sample: ORDER_SAMPLE,
  },
  pharmacy_order_accepted: {
    name: 'Order accepted',
    group: 'pharmacy',
    when: 'To the pharmacy when it submits an order to Curaleaf.',
    fields: ['Order number'],
    flags: { 'order number': 'An order number is known' },
    defaults: {
      subject: 'Order accepted',
      preheader: 'An order is now with Curaleaf.',
      title: 'Order accepted',
      body: 'An order has been accepted[If order number]: **[Order number]**[/If].',
    },
    sample: ORDER_SAMPLE,
  },
  pharmacy_order_cancelled: {
    name: 'Supplier cancellation',
    group: 'pharmacy',
    when: 'To the pharmacy when Curaleaf reports a cancellation that needs action.',
    fields: ['Order number', 'Purchase order', 'Summary', 'Labs', 'Labs phone', 'Labs hours', 'Clinic', 'Clinic email', 'Clinic phone', 'Clinic hours'],
    flags: { 'order number': 'An order number is known', summary: 'Curaleaf gave a summary', 'purchase order': 'A purchase order is known', 'no purchase order': 'No purchase order is known' },
    defaults: {
      subject: 'Supplier cancellation',
      preheader: 'Phone Curaleaf Labs and quote the purchase order.',
      title: 'Supplier cancellation',
      body: [
        'Curaleaf has reported a cancellation for order[If order number]: **[Order number]**[/If].',
        '[If summary][Summary][/If]',
        'Phone [Labs] on [Labs phone] before speaking to the patient, and quote [If purchase order]purchase order **[Purchase order]**[/If][If no purchase order]order **[Order number]**[/If]. Lines are open [Labs hours].',
        'If a line needs a new prescription because the item is unavailable or the prescription has expired, you or the patient can contact [Clinic] at [Clinic email] or [Clinic phone]. The clinic is open [Clinic hours]. You decide which of you makes that call.',
      ].join('\n\n'),
    },
    sample: { ...ORDER_SAMPLE, purchaseOrderId: 'cd46befd-8fea-46ec', summary: 'One line is out of stock.' },
  },
  pharmacy_delivery_issue: {
    name: 'Delivery issue',
    group: 'pharmacy',
    when: 'To the pharmacy when a supplier delivery looks delayed.',
    fields: ['Order number', 'Summary'],
    flags: { 'order number': 'An order number is known', summary: 'There is a summary' },
    defaults: {
      subject: 'Delivery issue requires attention',
      preheader: 'A fulfilment delay needs pharmacy awareness.',
      title: 'Delivery issue',
      body: 'A delivery issue requires attention[If order number] for order **[Order number]**[/If].\n\n[If summary][Summary][/If]',
    },
    sample: { ...ORDER_SAMPLE, summary: 'Curaleaf has not dispatched the order 3 working days after it was placed.' },
  },
  pharmacy_order_dispatched: {
    name: 'Order dispatched',
    group: 'pharmacy',
    when: 'To the pharmacy when Curaleaf reports the order (or part of it) dispatched.',
    fields: ['Order number', 'Summary'],
    flags: { 'order number': 'An order number is known', summary: 'Curaleaf gave a summary', 'no summary': 'No summary was given' },
    defaults: {
      subject: 'Order dispatched update',
      preheader: 'A supplier consignment is on the way.',
      title: 'Order dispatched',
      body: '[If summary][Summary][/If][If no summary]An order has been dispatched.[/If]\n\n[If order number]Order: **[Order number]**[/If]',
    },
    sample: { ...ORDER_SAMPLE, summary: 'Your order has been dispatched by Curaleaf.' },
  },
  pharmacy_prescription_close_to_expiry: {
    name: 'Prescription close to expiry',
    group: 'pharmacy',
    when: 'To the pharmacy when a paid prescription nears its 28-day limit.',
    fields: ['Order number', 'Summary'],
    flags: { 'order number': 'An order number is known', summary: 'There is a summary' },
    defaults: {
      subject: 'Prescription close to expiry',
      preheader: 'A prescription is approaching its 28-day limit.',
      title: 'Prescription close to expiry',
      body: 'A prescription is close to expiry[If order number] for order **[Order number]**[/If].\n\n[If summary][Summary][/If]',
    },
    sample: { ...ORDER_SAMPLE, summary: 'The prescription expires in 3 days.' },
  },
  pharmacy_collection_completed: {
    name: 'Collection completed',
    group: 'pharmacy',
    when: 'To the pharmacy when it records a collection.',
    fields: ['Order number', 'Summary'],
    flags: { 'order number': 'An order number is known', summary: 'There is a summary', 'no summary': 'No summary was given' },
    defaults: {
      subject: 'Collection completed update',
      preheader: 'A collection has been recorded.',
      title: 'Collection completed',
      body: '[If summary][Summary][/If][If no summary]Collection has been completed.[/If]\n\n[If order number]Order: **[Order number]**[/If]',
    },
    sample: { ...ORDER_SAMPLE, summary: 'Collected by the patient.' },
  },

  pharmacy_staff_invite: {
    name: 'Staff invitation',
    group: 'staff',
    when: 'When HHH invites pharmacy staff or another admin.',
    fields: ['Pharmacy name', 'Help email'],
    flags: { 'pharmacy named': 'The invite is for a pharmacy' },
    defaults: {
      subject: 'Set up your Holistic Health Hub account',
      preheader: 'You have been invited to the staff portal.',
      title: 'Sign up',
      body: 'You have been invited to the Holistic Health Hub staff portal[If pharmacy named] for **[Pharmacy name]**[/If].\n\nUse the button below to set your password, then sign in and set up two-factor authentication.',
      button: 'Set your password',
      footer: `If you were not expecting this invitation, you can ignore this email. ${HELP}`,
    },
    sample: { ...PHARMACY_SAMPLE, actionLink: 'https://portal.holistichealthhub.live/' },
  },
  pharmacy_password_reset: {
    name: 'Password reset',
    group: 'staff',
    when: 'From the staff sign-in page, or when HHH sends a reset.',
    fields: ['Help email'],
    defaults: {
      subject: 'Reset your Holistic Health Hub password',
      preheader: 'Use this link to choose a new password.',
      title: 'Reset password',
      body: 'Use the button below to choose a new password for the Holistic Health Hub staff portal.',
      button: 'Reset password',
      footer: `If you did not request this, you can ignore this email. The link expires after a short time. ${HELP}`,
    },
    sample: { actionLink: 'https://portal.holistichealthhub.live/' },
  },
  pharmacy_2fa_enabled: {
    name: 'Authenticator app added',
    group: 'staff',
    when: 'After a staff member sets up an authenticator app.',
    fields: ['Help email'],
    defaults: {
      subject: 'Authenticator app added to your account',
      preheader: 'Two-factor authentication is now switched on.',
      title: '2FA set up',
      body: 'An authenticator app has been added to your Holistic Health Hub staff account.\n\nSign-in now needs your password and a six-digit code from that app.',
      footer: 'If you did not do this, email [Help email] immediately.',
    },
    sample: {},
  },
  pharmacy_2fa_disabled: {
    name: 'Authenticator app removed',
    group: 'staff',
    when: 'After HHH removes a staff member’s authenticator app.',
    fields: ['Help email'],
    defaults: {
      subject: 'Authenticator app removed from your account',
      preheader: 'Two-factor authentication has been turned off.',
      title: '2FA turned off',
      body: 'The authenticator app on your Holistic Health Hub staff account has been removed.\n\nYou will be asked to set it up again the next time you sign in.',
      footer: 'If you did not expect this, email [Help email] immediately.',
    },
    sample: {},
  },

  admin_new_enquiry_received: {
    name: 'New enquiry received',
    group: 'admin',
    when: 'To HHH admins when a patient submits an eligibility enquiry.',
    fields: [],
    defaults: {
      subject: 'New enquiry received',
      preheader: 'A new eligibility enquiry is waiting in the portal.',
      title: 'New enquiry received',
      body: 'A patient has submitted an eligibility enquiry. Open the case in the portal. Name, phone and email stay there.',
      button: 'Open portal',
      steps: 'Open the portal to continue the enquiry.\n\nDo not ask the patient to reply to this email.',
    },
    sample: { pharmacyName: 'HHH admin workspace', caseReference: 'HHH-24817', provisionalPharmacyName: 'Kirkgate Pharmacy', sourceType: 'PHARMACY_QR' },
  },
  admin_curaleaf_prescriber_stuck: {
    name: 'Prescriber stuck at Curaleaf',
    group: 'admin',
    when: 'To the HHH admin inbox when paid orders have waited 3 days for Curaleaf to verify their prescriber, and every 3 days after. The pharmacy, prescriber and order details are added between the message and the closing note automatically.',
    fields: ['Pharmacy', 'Prescriber', 'Order count', 'Orders word', 'Days'],
    defaults: {
      subject: 'Please verify prescriber [Prescriber] for [Pharmacy] ([Order count] [Orders word] waiting)',
      body: '[Pharmacy] has [Order count] paid [Orders word] waiting [Days] days for Curaleaf to verify the prescriber. Nothing can go to Curaleaf until they do. Forward this email to Curaleaf; everything they need is below.\n\nHello Curaleaf team,\n\nPlease could you verify the prescriber below on our account. We have [Order count] paid [Orders word] waiting on them.',
      footer: 'Once the prescriber is verified, the orders are sent to you automatically within the hour.\n\nThank you,\nHolistic Health Hub',
    },
    sample: {},
  },
} as const satisfies Partial<Record<EmailTemplateCode, EmailCopySpec>>;

export type EditableEmailCode = keyof typeof EMAIL_COPY_SPECS;
export const EDITABLE_EMAIL_CODES = Object.keys(EMAIL_COPY_SPECS) as EditableEmailCode[];

export function isEditableEmailCode(code: string): code is EditableEmailCode {
  return Object.prototype.hasOwnProperty.call(EMAIL_COPY_SPECS, code);
}

export function emailCopySpec(code: string): EmailCopySpec | null {
  return isEditableEmailCode(code) ? EMAIL_COPY_SPECS[code] as EmailCopySpec : null;
}

/** The pieces an email can edit, in the order the editor shows them. */
export function editableSlots(code: EditableEmailCode): EmailCopySlot[] {
  const defaults = (EMAIL_COPY_SPECS[code] as EmailCopySpec).defaults;
  return EMAIL_COPY_SLOTS.filter(slot => defaults[slot] !== undefined);
}

/** What an admin has saved: per email, only the pieces they changed. */
export type EmailCopyOverrides = Partial<Record<EditableEmailCode, Partial<Record<EmailCopySlot, string>>>>;

export const EMAIL_COPY_CONTENT_KEY = 'email.copy';

const slotText = z.string().max(6000);

/** One email's saved pieces. Blank pieces are dropped, so the email goes back to the code's wording. */
export function parseEmailCopy(code: EditableEmailCode, value: unknown): Partial<Record<EmailCopySlot, string>> {
  const allowed = new Set(editableSlots(code));
  const record = z.record(z.string(), slotText).parse(value ?? {});
  const out: Partial<Record<EmailCopySlot, string>> = {};
  for (const [slot, text] of Object.entries(record)) {
    if (!allowed.has(slot as EmailCopySlot)) throw new z.ZodError([{ code: 'custom', path: [slot], message: `${slot} cannot be edited on this email.` }]);
    if (text.trim()) out[slot as EmailCopySlot] = text.replace(/\r\n/g, '\n');
  }
  return out;
}

/** Stored overrides, dropping anything no longer valid rather than failing a send. */
export function emailCopyFrom(stored: unknown): EmailCopyOverrides {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const out: EmailCopyOverrides = {};
  for (const [code, value] of Object.entries(stored as Record<string, unknown>)) {
    if (!isEditableEmailCode(code)) continue;
    try {
      const parsed = parseEmailCopy(code, value);
      if (Object.keys(parsed).length) out[code] = parsed;
    } catch {
      // One bad entry must not stop every other email's wording.
    }
  }
  return out;
}

/**
 * Fills saved wording: `[If flag]…[/If]` kept only when the flag is set, then
 * `[Merge field]`s replaced (unknown ones stay as typed, so a typo shows). Unlike the
 * onboarding merge, `**bold**` is kept for the HTML. Returns paragraphs.
 */
export function mergeCopy(template: string, fields: Record<string, string>, flags: Record<string, boolean>): string[] {
  const lowerFlags = Object.fromEntries(Object.entries(flags).map(([key, on]) => [key.toLowerCase(), on]));
  const conditioned = template.replace(/\[If ([^\]]+)\]([\s\S]*?)\[\/If\]/gi, (_, flag: string, inner: string) => (lowerFlags[flag.trim().toLowerCase()] ? inner : ''));
  const lookup = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key.toLowerCase(), value]));
  const merged = conditioned.replace(/\[([^\]\n]{1,60})\]/g, (whole, name: string) => {
    const value = lookup[name.trim().toLowerCase()];
    return value === undefined ? whole : value;
  });
  return merged
    .split(/\n\s*\n/)
    .map(paragraph => paragraph.split('\n').map(line => line.trimEnd()).join('\n').trim())
    .filter(Boolean);
}

/** A one-line piece (subject, heading, button). */
export function mergeCopyLine(template: string, fields: Record<string, string>, flags: Record<string, boolean>) {
  return mergeCopy(template, fields, flags).join(' ').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}
