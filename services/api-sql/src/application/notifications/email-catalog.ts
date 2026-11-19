import { z } from 'zod';
import { brandedEmail, escapeHtml, resolveEmailHeader, safeHttpUrl } from './email-layout.js';
import { enquiryDisplayFields } from './email-mask.js';
import { keyContact, telHref, type KeyContact } from './key-contacts.js';
import {
  emailCopySpec,
  mergeCopy,
  mergeCopyLine,
  type EmailCopyOverrides,
  type EmailCopySlot,
  type EmailCopySpec,
} from '../../domain/notifications/email-copy.js';

export const EMAIL_EVENT_NAMES = [
  'enquiry.submitted',
  'enquiry.reassigned',
  'enquiry.declined',
  'enquiry.withdrawn',
  'referral.activated',
  'payment.link_created',
  'payment.reminder',
  'payment.settled',
  'payment.refunded',
  'order.accepted',
  'order.cancelled',
  'order.dispatched',
  'order.delivery_issue',
  'order.near_expiry',
  'collection.ready',
  'collection.completed',
  'staff.invited',
  'staff.password_reset',
  'staff.2fa_enabled',
  'staff.2fa_disabled',
  'pharmacy_onboarding.terms_accepted',
  'pharmacy_onboarding.held',
  'pharmacy_onboarding.activated',
  'pharmacy_onboarding.live',
  'worldpay_application.submitted',
  'curaleaf_placement.prescriber_stuck',
  'partner_terms.signed',
  'partner_terms.reminder',
] as const;

export type EmailEventName = (typeof EMAIL_EVENT_NAMES)[number];
export type EmailAudience = 'patient' | 'pharmacy_owner' | 'staff' | 'admin';

/**
 * Added to a copy of the payload at send time, never stored on the outbox row: a
 * logo uploaded after a message was queued must still reach the message.
 */
export const BRAND_LOGO_PAYLOAD_KEY = 'hasBrandLogo';
/** Header fill derived from that same logo at send time, so the banner suits the artwork. */
export const BRAND_HEADER_BACKGROUND_PAYLOAD_KEY = 'brandHeaderBackground';
export type EmailSchedule = 'immediate' | 'collection_hours' | 'payment_reminder';

export const EMAIL_TEMPLATE_CODES = [
  'patient_enquiry_declined',
  'patient_referred',
  'patient_existing_clinic',
  'patient_payment_request',
  'patient_payment_confirmation',
  'patient_refunded',
  'patient_ready_for_collection',
  'admin_new_enquiry_received',
  'pharmacy_new_enquiry_assigned',
  'pharmacy_enquiry_declined',
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
  'pharmacy_onboarding_submitted',
  'curaleaf_new_account_application',
  'pharmacy_onboarding_held',
  'pharmacy_onboarding_activated',
  'pharmacy_onboarding_live',
  'worldpay_application_to_worldpay',
  'admin_curaleaf_prescriber_stuck',
  'pharmacy_partner_terms_signed',
  'pharmacy_partner_terms_reminder',
] as const;

export type EmailTemplateCode = (typeof EMAIL_TEMPLATE_CODES)[number];

/**
 * Monitored mailboxes a patient may reply into. The From address stays a single
 * Holistic Health Hub sender — only Reply-To changes — so nothing here depends on
 * per-pharmacy sending domains. A template with no alias gets no Reply-To header,
 * which is the right default: most of this catalog tells the patient to phone.
 *
 * Copy must never invite a reply unless the template names an alias here, or the
 * patient is writing to a mailbox nobody reads.
 */
export type EmailAlias = 'referrals' | 'IT' | 'support' | 'onboarding';

export function emailAliasDomain() {
  return process.env.EMAIL_ALIAS_DOMAIN?.trim() || 'holistichealthhub.live';
}

export function replyToFor(kind: EmailTemplateCode): string | null {
  const definition: EmailDefinition = EMAILS[kind];
  return definition.replyTo ? `${definition.replyTo}@${emailAliasDomain()}` : null;
}

export type EmailFromAlias = 'referrals' | 'payments' | 'orders' | 'accounts' | 'enquiries' | 'onboarding';

const FROM_ALIAS: Record<EmailTemplateCode, EmailFromAlias> = {
  patient_enquiry_declined: 'referrals',
  patient_referred: 'referrals',
  patient_existing_clinic: 'referrals',
  patient_payment_request: 'payments',
  patient_payment_confirmation: 'payments',
  patient_refunded: 'payments',
  patient_ready_for_collection: 'orders',
  admin_new_enquiry_received: 'enquiries',
  pharmacy_new_enquiry_assigned: 'orders',
  pharmacy_enquiry_declined: 'orders',
  pharmacy_staff_invite: 'accounts',
  pharmacy_password_reset: 'accounts',
  pharmacy_2fa_enabled: 'accounts',
  pharmacy_2fa_disabled: 'accounts',
  pharmacy_new_patient_referred: 'orders',
  pharmacy_payment_received: 'payments',
  pharmacy_order_accepted: 'orders',
  pharmacy_order_cancelled: 'orders',
  pharmacy_delivery_issue: 'orders',
  pharmacy_order_dispatched: 'orders',
  pharmacy_prescription_close_to_expiry: 'orders',
  pharmacy_collection_completed: 'orders',
  pharmacy_onboarding_submitted: 'onboarding',
  curaleaf_new_account_application: 'onboarding',
  pharmacy_onboarding_held: 'onboarding',
  pharmacy_onboarding_activated: 'onboarding',
  pharmacy_onboarding_live: 'onboarding',
  worldpay_application_to_worldpay: 'onboarding',
  admin_curaleaf_prescriber_stuck: 'orders',
  pharmacy_partner_terms_signed: 'onboarding',
  pharmacy_partner_terms_reminder: 'onboarding',
};

/** Retired 24 Sep 2026. Still in the catalog so old outbox rows can render, but never queued. */
export const RETIRED_EMAIL_TEMPLATES = new Set<EmailTemplateCode>([
  'pharmacy_new_enquiry_assigned',
  'pharmacy_enquiry_declined',
  'pharmacy_new_patient_referred',
  'pharmacy_payment_received',
  'pharmacy_order_accepted',
  'pharmacy_collection_completed',
]);

export function fromAddressFor(kind: EmailTemplateCode): string {
  return `${FROM_ALIAS[kind]}@${emailAliasDomain()}`;
}

export const DEFAULT_FROM_NAME = 'Holistic Health Hub';

/**
 * The partner onboarding emails (Shay's build pack, 19 Nov 2026). Their sender name and
 * Reply-To are admin content, merged into the payload when queued (`fromName`, `replyTo`).
 * The From address itself never changes: it must stay a verified sending alias.
 */
export const SENDER_OVERRIDE_TEMPLATES: ReadonlySet<EmailTemplateCode> = new Set<EmailTemplateCode>([
  'pharmacy_onboarding_submitted',
  'curaleaf_new_account_application',
  'pharmacy_onboarding_activated',
  'pharmacy_onboarding_held',
  'pharmacy_onboarding_live',
]);

const overrideAddress = z.string().trim().toLowerCase().email().max(254);

/** A display name safe to put in a From header: no quotes, brackets, backslashes or line breaks. */
function cleanDisplayName(raw: string) {
  return raw.replace(/[\u0000-\u001f\u007f"<>\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
}

/**
 * Sender name and Reply-To for one message. Only SENDER_OVERRIDE_TEMPLATES read them
 * from the payload, and only when they are valid; anything else gets the catalog's own.
 */
export function senderFor(kind: EmailTemplateCode, payload: unknown): { fromName: string; replyTo: string | null } {
  const fallback = { fromName: DEFAULT_FROM_NAME, replyTo: replyToFor(kind) };
  if (!SENDER_OVERRIDE_TEMPLATES.has(kind)) return fallback;
  const replyTo = overrideAddress.safeParse(value(payload, 'replyTo'));
  const fromName = cleanDisplayName(value(payload, 'fromName'));
  return {
    fromName: fromName || fallback.fromName,
    replyTo: replyTo.success ? replyTo.data : fallback.replyTo,
  };
}

/** `Name <address>`, quoting the name when it holds a character the header treats specially. */
export function formatFromHeader(name: string, address: string) {
  const clean = cleanDisplayName(name) || DEFAULT_FROM_NAME;
  return /[()\[\]:;@,.]/.test(clean) ? `"${clean}" <${address}>` : `${clean} <${address}>`;
}

export type RenderedEmail = {
  subject: string;
  text: string;
  html: string;
};

type EmailDefinition = {
  audience: EmailAudience;
  events: readonly EmailEventName[];
  schedule: EmailSchedule;
  summary: string;
  /** Monitored mailbox for replies. Omit unless the copy invites one. */
  replyTo?: EmailAlias;
  render: (payload: unknown) => RenderedEmail;
};

function money(amountPence: unknown, currency = 'GBP') {
  const amount = Number(amountPence ?? 0) / 100;
  if (!Number.isFinite(amount)) return '';
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amount);
}

function value(payload: unknown, key: string) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const found = (payload as Record<string, unknown>)[key];
  return found == null ? '' : String(found);
}

function paymentBreakdown(payload: unknown) {
  const currency = value(payload, 'currency') || 'GBP';
  const medicine = Number(value(payload, 'medicineTotalPence') || 0);
  const amount = Number(value(payload, 'amountPence') || 0);
  const discount = Number(value(payload, 'discountPence') || 0);
  const medicineSubtotal = discount > 0 ? medicine + discount : medicine;
  const lines = [{ label: discount > 0 ? 'Medicines subtotal' : 'Medicine', value: money(medicineSubtotal, currency) }];
  if (discount > 0) lines.push({ label: 'Discount', value: `−${money(discount, currency)}` });
  const dispensing = Number(value(payload, 'dispensingFeePence') || 0);
  const delivery = Number(value(payload, 'pharmacyDeliveryPence') || 0);
  if (dispensing > 0) lines.push({ label: 'Dispensing charge', value: money(dispensing, currency) });
  if (delivery > 0) lines.push({ label: 'Delivery charge', value: money(delivery, currency) });
  const remainder = amount - medicine - dispensing - delivery;
  if (remainder > 0) lines.push({ label: 'Delivery', value: money(remainder, currency) });
  return lines;
}

function paymentReceiptUrl(receiptHash: string) {
  return `https://holistichealthhub.live/receipt/${encodeURIComponent(receiptHash)}`;
}

function primaryAddress(contact: KeyContact) {
  const address = contact.emails[0]?.address;
  if (!address) throw new Error(`Key contact ${contact.key} has no email.`);
  return address;
}

function mailLink(address: string) {
  return `<a href="mailto:${escapeHtml(address)}">${escapeHtml(address)}</a>`;
}

function phoneLink(phone: string) {
  return `<a href="${escapeHtml(telHref(phone))}">${escapeHtml(phone)}</a>`;
}

/** A stored date (YYYY-MM-DD) as "14/03/1988": how a date of birth is read against a record. */
function shortDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  return match ? `${match[3]}/${match[2]}/${match[1]}` : longDate(value);
}

/** A stored date (YYYY-MM-DD) as "14 March 1988". Read in UTC so the day never shifts. */
function longDate(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed);
  if (Number.isNaN(parsed.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(parsed);
}

function enquirySourceLabel(sourceType: string) {
  if (sourceType === 'GENERAL_HHH_WEBSITE') return 'Website';
  if (sourceType === 'PHARMACY_QR' || sourceType === 'LEGACY_PHARMACY_QR') return 'Pharmacy QR';
  return sourceType.replaceAll('_', ' ').toLowerCase();
}

export function emailUsesAdminHeader(kind: string, payload: unknown) {
  return kind === 'admin_new_enquiry_received'
    || kind === 'curaleaf_new_account_application'
    || value(payload, 'pharmacyName') === 'HHH admin workspace';
}

function isAdminAudience(kind: EmailTemplateCode, payload: unknown) {
  return emailUsesAdminHeader(kind, payload);
}

function eyebrowFor(kind: EmailTemplateCode, admin: boolean) {
  if (SENDER_OVERRIDE_TEMPLATES.has(kind)) return 'Partner onboarding';
  if (admin) return 'Admin alert';
  if (
    kind === 'pharmacy_staff_invite'
    || kind === 'pharmacy_password_reset'
    || kind === 'pharmacy_2fa_enabled'
    || kind === 'pharmacy_2fa_disabled'
  ) return 'Staff account';
  if (kind === 'patient_referred' || kind === 'patient_existing_clinic') return 'Your pharmacy';
  if (kind.startsWith('patient_')) return 'Patient order update';
  return 'Pharmacy update';
}

function paragraphsOf(payload: unknown) {
  const given = payload && typeof payload === 'object' ? (payload as { paragraphs?: unknown }).paragraphs : undefined;
  return Array.isArray(given) ? given.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
}

/** A short one-line paragraph with no closing punctuation reads as a heading ("What happens next"). */
function looksLikeHeading(paragraph: string, index: number) {
  return index > 0 && !paragraph.includes('\n') && paragraph.length <= 60 && !/[.,:;!?)]$/.test(paragraph) && !paragraph.startsWith('-');
}

/**
 * A partner onboarding email: subject and paragraphs merged from admin content when it
 * was queued (application/pharmacy-onboarding/onboarding-emails.service.ts), with the
 * Reply-To it was given. Every row is queued with both; `fallbackSubject` only keeps a
 * malformed payload renderable.
 */
function onboardingEmail(kind: EmailTemplateCode, payload: unknown, fallbackSubject: string): RenderedEmail {
  const subject = value(payload, 'subject') || fallbackSubject;
  const given = paragraphsOf(payload);
  const lines = given.length ? given : ['For anything about your Holistic Health Hub application, reply to this email.'];
  return render({
    kind,
    payload,
    subject,
    preheader: lines.find((line, index) => index > 0 && !looksLikeHeading(line, index)) ?? lines[0] ?? subject,
    title: subject.replace(/^DEMO, not sent to Curaleaf: /, ''),
    text: lines.join('\n\n'),
    paragraphs: lines.map((paragraph, index) => {
      const html = escapeHtml(paragraph).replace(/\n/g, '<br>');
      return looksLikeHeading(paragraph, index) ? `<strong>${html}</strong>` : html;
    }),
    replyTo: senderFor(kind, payload).replyTo,
  });
}

/**
 * An email whose subject and paragraphs were written in admin and merged before
 * sending (the Worldpay application emails). The payload carries `subject` and
 * `paragraphs`; anything missing falls back to the given wording.
 */
function contentEmail(kind: EmailTemplateCode, payload: unknown, fallbackSubject: string, fallbackParagraph: string): RenderedEmail {
  const subject = value(payload, 'subject') || fallbackSubject;
  const paragraphs = paragraphsOf(payload);
  const lines = paragraphs.length ? paragraphs : [fallbackParagraph];
  return render({
    kind,
    payload,
    subject,
    preheader: lines[0] ?? subject,
    title: subject,
    text: lines.join('\n\n'),
    paragraphs: lines.map(paragraph => escapeHtml(paragraph).replace(/\n/g, '<br>')),
  });
}

type RenderInput = {
  kind: EmailTemplateCode;
  payload: unknown;
  subject: string;
  preheader: string;
  title: string;
  text: string;
  paragraphs: string[];
  highlight?: { label: string; value: string };
  cta?: { label: string; href: string };
  detailsTitle?: string;
  details?: Array<{ label: string; value: string }>;
  nextSteps?: Array<string | { title: string; body?: string }>;
  footerNote?: string;
  /** The Reply-To this message is sent with, when it is not the template's own. */
  replyTo?: string | null;
};

function render(given: RenderInput): RenderedEmail {
  const input = applyEmailCopy(given);
  const admin = isAdminAudience(input.kind, input.payload);
  return {
    subject: input.subject,
    text: input.text,
    html: brandedEmail({
      preheader: input.preheader,
      eyebrow: eyebrowFor(input.kind, admin),
      title: input.title,
      paragraphs: input.paragraphs,
      highlight: input.highlight,
      cta: input.cta,
      detailsTitle: input.detailsTitle,
      details: input.details,
      nextSteps: input.nextSteps,
      footerNote: input.footerNote,
      // Keeps the footer honest about whether anyone reads a reply.
      replyTo: input.replyTo !== undefined ? input.replyTo : replyToFor(input.kind),
      header: resolveEmailHeader({
        audience: admin ? 'admin' : 'pharmacy',
        organisationId: value(input.payload, 'organisationId'),
        pharmacyName: value(input.payload, 'pharmacyName'),
        // Set by the delivery worker once it has the uploaded logo in hand, so the
        // markup and the attachment list can never disagree about whether one exists.
        hasBrandLogo: value(input.payload, BRAND_LOGO_PAYLOAD_KEY) === 'true',
        headerBackground: value(input.payload, BRAND_HEADER_BACKGROUND_PAYLOAD_KEY),
      }),
      // Staff and admin mail is internal; only a patient needs to be told who the
      // controller is, and an internal footer naming their own pharmacy reads oddly.
      controller: admin ? null : {
        pharmacyName: value(input.payload, 'pharmacyName'),
        pharmacyAddress: value(input.payload, 'pharmacyAddress'),
        gphcNumber: value(input.payload, 'pharmacyGphcNumber'),
        icoRegistrationNumber: value(input.payload, 'pharmacyIcoNumber'),
        privacyContactEmail: value(input.payload, 'pharmacyPrivacyEmail'),
        complaintsContactEmail: value(input.payload, 'pharmacyComplaintsEmail'),
        complaintsContactPhone: value(input.payload, 'pharmacyComplaintsPhone'),
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Admin-edited wording (domain/notifications/email-copy.ts). Set for the length of
// one renderEmailTemplate call: rendering is synchronous, so it cannot leak into
// another email.

let activeCopy: Partial<Record<EmailCopySlot, string>> | null = null;

/** The merge fields every editable email can draw on, from its payload. */
function copyVars(payload: unknown): Record<string, string> {
  const clinic = keyContact('clinic');
  const labs = keyContact('curaleafLabs');
  const amountPence = Number(value(payload, 'amountPence') || 0);
  return {
    'First name': value(payload, 'firstName') || value(payload, 'patientFirstName') || 'there',
    'Pharmacy name': value(payload, 'pharmacyName') || 'the pharmacy',
    'Pharmacy address': value(payload, 'pharmacyAddress'),
    'Pharmacy GPhC': value(payload, 'pharmacyGphcNumber'),
    'Order number': value(payload, 'orderNumber'),
    Amount: amountPence > 0 ? money(amountPence, value(payload, 'currency') || 'GBP') : '',
    'Case reference': value(payload, 'caseReference'),
    Summary: value(payload, 'summary'),
    'Ready packs': value(payload, 'readyPacks'),
    'Total packs': value(payload, 'totalPacks'),
    'Purchase order': value(payload, 'purchaseOrderId'),
    'Patient name': enquiryDisplayFields(payload).name,
    Clinic: clinic.org,
    'Clinic email': primaryAddress(clinic),
    'Clinic phone': clinic.phone ?? '',
    'Clinic hours': clinic.hours ?? '',
    'Clinic sign-in link': clinic.portalUrl ?? '',
    Labs: labs.org,
    'Labs phone': labs.phone ?? '',
    'Labs hours': labs.hours ?? '',
    'Help email': primaryAddress(keyContact('hhhPlatform')),
    'Terms version': value(payload, 'termsVersion'),
    'Signer name': value(payload, 'signerName'),
    'Signed on': value(payload, 'signedOn'),
  };
}

/** The conditions every editable email can use, from its payload. */
function copyFlags(payload: unknown): Record<string, boolean> {
  const ready = Number(value(payload, 'readyPacks') || 0);
  const total = Number(value(payload, 'totalPacks') || 0);
  const partial = value(payload, 'partialReady') === 'true' && ready > 0 && total > ready;
  const variant = value(payload, 'variant');
  const summary = Boolean(value(payload, 'summary').trim());
  const purchaseOrder = Boolean(value(payload, 'purchaseOrderId').trim());
  const patientName = Boolean(enquiryDisplayFields(payload).name);
  return {
    amount: Number(value(payload, 'amountPence') || 0) > 0,
    'order number': Boolean(value(payload, 'orderNumber').trim()),
    'case reference': Boolean(value(payload, 'caseReference').trim()),
    summary,
    'no summary': !summary,
    partial,
    'all ready': !partial,
    'purchase order': purchaseOrder,
    'no purchase order': !purchaseOrder,
    'patient name': patientName,
    'no patient name': !patientName,
    'pharmacy named': Boolean(value(payload, 'pharmacyName').trim()),
    declined: variant !== 'incomplete' && variant !== 'withdrawn',
    incomplete: variant === 'incomplete',
    withdrawn: variant === 'withdrawn',
  };
}

/** One merged paragraph as HTML: escaped, `**bold**`, addresses and links clickable, line breaks kept. */
function copyHtml(paragraph: string) {
  return escapeHtml(paragraph)
    .replace(/https?:\/\/[^\s<]+[^\s<.,;:)]/g, url => `<a href="${url}">${url}</a>`)
    .replace(/(^|[\s(>])([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g, (_, lead: string, address: string) => `${lead}<a href="mailto:${address}">${address}</a>`)
    .replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*\*/g, '')
    .replace(/\n/g, '<br>');
}

const plainCopy = (text: string) => text.replace(/\*\*/g, '').trim();

function htmlToText(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/** The plain-text part, rebuilt from the email's pieces once its wording has been edited. */
function textFromParts(input: RenderInput) {
  const steps = (input.nextSteps ?? []).map((step, index) => (typeof step === 'string'
    ? `${index + 1}. ${step}`
    : `${index + 1}. ${step.title}${step.body ? `\n   ${step.body}` : ''}`));
  return [
    ...input.paragraphs.map(htmlToText),
    input.highlight ? `${input.highlight.label}: ${input.highlight.value}` : '',
    input.cta ? `${input.cta.label}: ${input.cta.href}` : '',
    input.details?.length
      ? [input.detailsTitle ?? '', ...input.details.filter(row => row.value).map(row => `${row.label}: ${row.value}`)].filter(Boolean).join('\n')
      : '',
    ...steps,
    input.footerNote ? htmlToText(input.footerNote) : '',
  ].filter(Boolean).join('\n\n');
}

/** Swaps in each piece of wording an admin has saved for this email; the rest is untouched. */
function applyEmailCopy(input: RenderInput): RenderInput {
  const copy = activeCopy;
  const spec: EmailCopySpec | null = copy ? emailCopySpec(input.kind) : null;
  if (!copy || !spec || !Object.keys(copy).length) return input;
  const vars = copyVars(input.payload);
  const flags = copyFlags(input.payload);
  const line = (template: string) => mergeCopyLine(template, vars, flags);
  const next: RenderInput = { ...input };
  if (copy.subject) {
    const subject = line(copy.subject);
    next.subject = spec.subjectPrefix ? patientSubject(input.payload, subject) : subject;
  }
  if (copy.preheader) next.preheader = line(copy.preheader);
  if (copy.title) next.title = line(copy.title);
  if (copy.button && input.cta) next.cta = { ...input.cta, label: line(copy.button) };
  if (copy.body) {
    next.paragraphs = mergeCopy(copy.body, vars, flags).map(copyHtml);
    if (spec.signature === 'body') next.paragraphs.push(signatureHtml(input.payload));
  }
  if (copy.steps && input.nextSteps) {
    const steps = mergeCopy(copy.steps, vars, flags);
    next.nextSteps = spec.stepTitles
      ? steps.map(step => {
        const [title = '', ...rest] = step.split('\n');
        return { title: plainCopy(title), body: plainCopy(rest.join(' ')) };
      })
      : steps.map(plainCopy);
  }
  if (copy.footer) {
    const footer = mergeCopy(copy.footer, vars, flags).map(copyHtml);
    if (spec.signature === 'footer') footer.push(signatureHtml(input.payload));
    next.footerNote = footer.join('<br><br>');
  }
  if (copy.body || copy.steps || copy.footer || copy.button) next.text = textFromParts(next);
  return next;
}

function fields(payload: unknown) {
  const firstName = escapeHtml(value(payload, 'firstName') || value(payload, 'patientFirstName') || 'there');
  const pharmacyName = escapeHtml(value(payload, 'pharmacyName') || 'the pharmacy');
  const orderNumber = escapeHtml(value(payload, 'orderNumber'));
  const amount = money(value(payload, 'amountPence') || 0, value(payload, 'currency') || 'GBP');
  const paymentUrl = safeHttpUrl(value(payload, 'paymentUrl'));
  const receiptHash = value(payload, 'receiptHash');
  const actionLink = safeHttpUrl(value(payload, 'actionLink'));
  const caseReference = escapeHtml(value(payload, 'caseReference'));
  const summary = escapeHtml(value(payload, 'summary'));
  const readyPacks = Number(value(payload, 'readyPacks') || 0);
  const totalPacks = Number(value(payload, 'totalPacks') || 0);
  const partialReady = value(payload, 'partialReady') === 'true'
    && readyPacks > 0
    && totalPacks > readyPacks;
  const enquiry = enquiryDisplayFields(payload);
  const pharmacyDetails = [
    { label: 'Pharmacy', value: value(payload, 'pharmacyName') },
    { label: 'Phone', value: value(payload, 'pharmacyPhone') },
    { label: 'Email', value: value(payload, 'pharmacyPublicEmail') },
    { label: 'Address', value: value(payload, 'pharmacyAddress') },
  ];
  return {
    firstName,
    pharmacyName,
    orderNumber,
    amount,
    paymentUrl,
    receiptHash,
    actionLink,
    caseReference,
    summary,
    readyPacks,
    totalPacks,
    partialReady,
    enquiry,
    pharmacyDetails,
  };
}

/**
 * Who a patient-facing email is from. Referral-stage mail is sent in the pharmacy's
 * name, but an enquiry can be closed before one is assigned, and "the pharmacy" —
 * the neutral fallback used everywhere else — reads as a mistake in a subject line
 * or over a signature. HHH signs those itself.
 */
function patientSender(payload: unknown) {
  const name = value(payload, 'pharmacyName').trim();
  return name && name !== 'the pharmacy' ? name : 'Holistic Health Hub';
}

/** `[Pharmacy name]: <subject>`. The category term never appears — these land on lock screens. */
function patientSubject(payload: unknown, subject: string) {
  return `${patientSender(payload)}: ${subject}`;
}

/**
 * The sign-off patient mail carries: who wrote to them, and how to check that is
 * genuine. The website line is dropped when the pharmacy has no website recorded.
 * The controller block in the footer is a separate, legal identity statement.
 */
function signatureLines(payload: unknown) {
  return [
    patientSender(payload),
    value(payload, 'pharmacyGphcNumber').trim() ? `GPhC ${value(payload, 'pharmacyGphcNumber').trim()}` : '',
    value(payload, 'pharmacyPhone').trim(),
    value(payload, 'pharmacyPublicEmail').trim(),
    value(payload, 'pharmacyWebsite').trim(),
  ].filter(Boolean);
}

function signatureHtml(payload: unknown) {
  return `Best wishes,<br>${signatureLines(payload).map(line => escapeHtml(line)).join('<br>')}`;
}

function signatureText(payload: unknown) {
  return `Best wishes,\n${signatureLines(payload).join('\n')}\n`;
}

/** Which PT-00 wording a closure gets. The recorded reason itself is never sent. */
export type EnquiryClosureVariant = 'declined' | 'incomplete' | 'withdrawn';

export function closureVariantForReason(reason: string): EnquiryClosureVariant {
  return reason === 'INCOMPLETE_INFORMATION' || reason === 'NO_RESPONSE' ? 'incomplete' : 'declined';
}

const CLOSURE_COPY: Record<EnquiryClosureVariant, string[]> = {
  declined: [
    'Thank you for your enquiry. We have looked carefully at the information you gave us and the medical records you allowed us to check, and on this occasion we are not able to refer you to our partner clinic.',
    'This is about whether our service can refer you. It is not a diagnosis, and no one has assessed your health.',
    'We would encourage you to speak to your GP. They know your medical history and can discuss the options available to you, including specialist referral where appropriate. If your health gets worse or you need help urgently, contact your GP or call NHS 111.',
    'If your circumstances change, you are welcome to enquire again. If you have any questions about this email, call us or reply to it.',
  ],
  incomplete: [
    'Thank you for your enquiry. We asked for some further information and have not heard back, so we have closed your enquiry for now. Nothing has been decided about your eligibility.',
    'If you would still like to be considered, reply to this email or call us and we will pick it up where we left off. If you have any concerns about your health in the meantime, speak to your GP.',
  ],
  withdrawn: [
    'As you asked, we have closed your enquiry and will not take it any further. Thank you for letting us know. If you change your mind, you are welcome to enquire again at any time. If you have any concerns about your health, speak to your GP.',
  ],
};

export const EMAILS = {
  /**
   * PT-00. Sent when an administrator closes an enquiry by hand. Never sent for the
   * eligibility form's automatic on-screen decline: that patient was already told,
   * on the page, at the time.
   */
  patient_enquiry_declined: {
    audience: 'patient',
    events: ['enquiry.declined', 'enquiry.withdrawn'],
    schedule: 'immediate',
    replyTo: 'referrals',
    summary: 'Sent to the patient when HHH admin declines or closes their enquiry. Three variants; the recorded reason is never quoted.',
    render: (payload) => {
      const { firstName } = fields(payload);
      const raw = value(payload, 'variant');
      const variant: EnquiryClosureVariant = raw === 'incomplete' || raw === 'withdrawn' ? raw : 'declined';
      const body = CLOSURE_COPY[variant];
      return render({
        kind: 'patient_enquiry_declined',
        payload,
        subject: patientSubject(payload, 'Your referral enquiry'),
        preheader: variant === 'withdrawn'
          ? 'Your enquiry is closed, as you asked.'
          : 'An update on the referral enquiry you made.',
        title: 'Your referral enquiry',
        text: `Dear ${value(payload, 'firstName') || 'there'},\n\n${body.join('\n\n')}\n\n${signatureText(payload)}`,
        paragraphs: [
          `Dear ${firstName},`,
          ...body.map(escapeHtml),
          signatureHtml(payload),
        ],
      });
    },
  },
  /**
   * PT-01. Naming Curaleaf Clinic is a deliberate exception to the "clinic never
   * named" rule: this is transactional and post-referral, and the patient is about
   * to receive an email from a company they have never heard of.
   */
  patient_referred: {
    audience: 'patient',
    events: ['referral.activated'],
    schedule: 'immediate',
    replyTo: 'referrals',
    summary: 'Sent when HHH admin completes a referral and activates the pharmacy patient record.',
    render: (payload) => {
      const { firstName } = fields(payload);
      const closing = 'If anything is unclear, pop into the pharmacy and ask at the counter, call us, or reply to this email. We are happy to help.';
      const ongoingBody = 'Once you start treatment, we work with Curaleaf Clinic to keep your repeat prescriptions coming without gaps. For questions about your treatment, contact the clinic; for questions about your order or collection, contact us.';
      const ongoing = `Ongoing care. ${ongoingBody}`;
      const steps = [
        {
          title: 'The clinic will email you',
          body: 'Within two working days you will get an email from Curaleaf Clinic asking you to register. Check your junk or spam folder if you cannot see it. If nothing arrives, call us or reply to this email and we will chase it for you.',
        },
        {
          title: 'Register and confirm who you are',
          body: 'Follow the instructions in the clinic’s email to set up your Curaleaf Clinic login. You will need photo ID — a passport or driving licence — before an appointment can be booked, so have one to hand. The clinic may also ask about your health or current medicines.',
        },
        {
          title: 'Book your appointment',
          body: 'Book through the clinic’s website. It is a video call with a consultant doctor, so you will need a phone, tablet or computer with a camera. The doctor decides whether treatment is suitable for you. You can pay per appointment or choose one of the clinic’s payment plans — medicine is charged separately by us.',
        },
        {
          title: 'We take it from there',
          body: 'The clinic sends your prescription to us. We will email you to arrange payment, and again when your medicine is ready. You do not need to do anything until you hear from us.',
        },
      ];
      const opening = 'We have reviewed your medical records and referred you to our partner clinic, Curaleaf Clinic. Here is what happens next:';
      return render({
        kind: 'patient_referred',
        payload,
        subject: patientSubject(payload, 'Your referral — what happens next'),
        preheader: 'Curaleaf Clinic will email you within two working days.',
        title: 'Your referral — what happens next',
        text: [
          `Dear ${value(payload, 'firstName') || 'there'},`,
          opening,
          ...steps.map((step, index) => `${index + 1}. ${step.title}\n   ${step.body}`),
          ongoing,
          closing,
          signatureText(payload),
        ].join('\n\n'),
        paragraphs: [
          `Dear ${firstName},`,
          escapeHtml(opening),
        ],
        nextSteps: steps,
        footerNote: [
          `<p style="margin:0 0 14px; color:#4d5a56; font-size:15px; line-height:23px;"><strong style="color:#1f2725;">Ongoing care.</strong> ${escapeHtml(ongoingBody)}</p>`,
          `<p style="margin:0 0 20px; color:#4d5a56; font-size:15px; line-height:23px;">${escapeHtml(closing)}</p>`,
          `<p style="margin:0; color:#1f2725; font-size:15px; line-height:23px;">${signatureHtml(payload)}</p>`,
        ].join(''),
      });
    },
  },
  /**
   * PT-01B. Existing Curaleaf Clinic account under the eligibility email.
   * Mutually exclusive with PT-01 for one enquiry. Pharmacy status stays referred.
   */
  patient_existing_clinic: {
    audience: 'patient',
    events: ['referral.activated'],
    schedule: 'immediate',
    replyTo: 'referrals',
    summary: 'Sent when HHH admin refers a patient who already has a Curaleaf Clinic account.',
    render: (payload) => {
      const { firstName } = fields(payload);
      const clinic = keyContact('clinic');
      const clinicEmail = primaryAddress(clinic);
      const clinicPhone = clinic.phone ?? '';
      const clinicHours = clinic.hours ?? '';
      const portalUrl = clinic.portalUrl ?? '';
      const pharmacyName = value(payload, 'pharmacyName') || 'the pharmacy';
      const pharmacyAddress = value(payload, 'pharmacyAddress');
      const gphc = value(payload, 'pharmacyGphcNumber');
      const destination = [
        pharmacyName,
        pharmacyAddress,
        gphc ? `GPhC number ${gphc}` : '',
      ].filter(Boolean).join('\n');
      const opening = 'Thank you for your enquiry and for choosing us as your pharmacy. We have reviewed your information, and our partner clinic, Curaleaf Clinic, tells us you already have an account with them, registered to this email address. You do not need to register again.';
      const steps = [
        {
          title: 'Sign in to your Curaleaf Clinic account',
          body: `Go to ${portalUrl} and sign in with this email address. If you have forgotten your password, use the Forgotten password button on the sign-in page. If you still cannot get in, call Curaleaf Clinic on ${clinicPhone} (${clinicHours}) or email ${clinicEmail}.`,
        },
        {
          title: 'Ask the clinic to send your prescriptions to us',
          body: `When you sign in or speak to the clinic, ask for your prescriptions to be sent to:\n${destination}`,
        },
        {
          title: 'Book an appointment if you need one',
          body: 'If you have not seen a clinic doctor recently, book an appointment through the clinic’s website. The doctor will decide whether treatment is suitable for you. Medicine is charged separately by us.',
        },
        {
          title: 'We take it from there',
          body: 'When the clinic sends a prescription to us, we will email you to arrange payment, and again when your medicine is ready to collect. You do not need to do anything else.',
        },
      ];
      const closing = 'For questions about your account, treatment or appointments, contact the clinic. For questions about your order or collection, contact us or reply to this email.';
      return render({
        kind: 'patient_existing_clinic',
        payload,
        subject: patientSubject(payload, 'Your referral — one step for you'),
        preheader: 'You already have a Curaleaf Clinic account. Sign in and ask them to send prescriptions to us.',
        title: 'Your referral — one step for you',
        text: [
          `Dear ${value(payload, 'firstName') || 'there'},`,
          opening,
          ...steps.map((step, index) => `${index + 1}. ${step.title}\n   ${step.body}`),
          closing,
          signatureText(payload),
        ].join('\n\n'),
        paragraphs: [
          `Dear ${firstName},`,
          `${escapeHtml('Thank you for your enquiry and for choosing us as your pharmacy. We have reviewed your information, and our partner clinic, Curaleaf Clinic, tells us ')}<strong>you already have an account with them, registered to this email address.</strong> You do not need to register again.`,
        ],
        nextSteps: steps.map(step => ({ title: step.title, body: step.body.replaceAll('\n', ' ') })),
        footerNote: [
          `<p style="margin:0 0 20px; color:#4d5a56; font-size:15px; line-height:23px;">${escapeHtml(closing)}</p>`,
          `<p style="margin:0; color:#1f2725; font-size:15px; line-height:23px;">${signatureHtml(payload)}</p>`,
        ].join(''),
      });
    },
  },
  patient_payment_request: {
    audience: 'patient',
    events: ['payment.link_created', 'payment.reminder'],
    schedule: 'payment_reminder',
    summary: 'Sent when a Worldpay payment link is created or resent, and once more 72 hours later if it is still unpaid.',
    render: (payload) => {
      const { firstName, orderNumber, amount, paymentUrl, pharmacyDetails } = fields(payload);
      return render({
        kind: 'patient_payment_request',
        payload,
        subject: 'Payment needed for your order',
        preheader: 'Complete payment securely so your pharmacy can continue the order.',
        title: 'Payment needed',
        text: `Hi ${value(payload, 'firstName') || 'there'},\n\nPlease complete your payment${amount ? ` of ${amount}` : ''}${orderNumber ? ` for order ${value(payload, 'orderNumber')}` : ''} using this secure link:\n${paymentUrl}\n\n${paymentBreakdown(payload).map(line => `${line.label}: ${line.value}`).join('\n')}\n`,
        paragraphs: [
          `Hi ${firstName},`,
          'Your order is ready to move forward. Complete payment below and the pharmacy can continue preparing it for you.',
        ],
        highlight: amount ? { label: 'Amount due', value: amount } : undefined,
        cta: paymentUrl ? { label: 'Pay now', href: paymentUrl } : undefined,
        detailsTitle: 'Order breakdown',
        details: [
          { label: 'Order reference', value: value(payload, 'orderNumber') },
          ...paymentBreakdown(payload),
          ...pharmacyDetails,
        ],
        nextSteps: [
          'Use the secure link above to complete payment.',
          'We will confirm as soon as payment is received.',
          'The pharmacy will continue processing your order.',
        ],
        footerNote: 'This is a secure payment link. If you were not expecting this email, you can ignore it.',
      });
    },
  },
  patient_payment_confirmation: {
    audience: 'patient',
    events: ['payment.settled'],
    schedule: 'immediate',
    summary: 'Sent once payment has been received (Worldpay settlement or manual pay), with a receipt link when available.',
    render: (payload) => {
      const { firstName, orderNumber, amount, receiptHash, pharmacyDetails } = fields(payload);
      return render({
        kind: 'patient_payment_confirmation',
        payload,
        subject: 'Payment received',
        preheader: 'Your payment has been confirmed.',
        title: 'Payment received',
        text: `Hi ${value(payload, 'firstName') || 'there'},\n\nWe have received your payment${amount ? ` of ${amount}` : ''}${orderNumber ? ` for order ${value(payload, 'orderNumber')}` : ''}.\n${paymentBreakdown(payload).map(line => `${line.label}: ${line.value}`).join('\n')}\n${receiptHash ? `Receipt: ${paymentReceiptUrl(receiptHash)}\n` : ''}`,
        paragraphs: [
          `Hi ${firstName},`,
          'We have received your payment and the pharmacy can now continue processing your order.',
        ],
        highlight: amount ? { label: 'Receipt', value: amount } : undefined,
        cta: receiptHash ? { label: 'Here is your receipt', href: paymentReceiptUrl(receiptHash) } : undefined,
        detailsTitle: 'Order details',
        details: [
          { label: 'Order reference', value: value(payload, 'orderNumber') },
          ...paymentBreakdown(payload),
          ...pharmacyDetails,
        ],
      });
    },
  },
  patient_refunded: {
    audience: 'patient',
    events: ['payment.refunded'],
    schedule: 'immediate',
    summary: 'Sent when pharmacy confirms a completed refund.',
    render: (payload) => {
      const { firstName, orderNumber, amount, receiptHash, pharmacyDetails } = fields(payload);
      const clinic = keyContact('clinic');
      const clinicEmail = primaryAddress(clinic);
      const clinicPhone = clinic.phone ?? '';
      const rePrescribe = `If you need a new prescription because an item was unavailable or your prescription has expired, contact ${clinic.org} at ${clinicEmail} or ${clinicPhone}, ${clinic.hours}. Your pharmacy can contact the clinic instead.`;
      return render({
        kind: 'patient_refunded',
        payload,
        subject: 'Your payment has been refunded',
        preheader: 'A refund has been completed for your order.',
        title: 'Payment refunded',
        text: `Hi ${value(payload, 'firstName') || 'there'},\n\nA refund${amount ? ` of ${amount}` : ''} has been completed${orderNumber ? ` for order ${value(payload, 'orderNumber')}` : ''}. It can take a few working days to appear on the original payment method.\n\n${rePrescribe}\n${receiptHash ? `Receipt: ${paymentReceiptUrl(receiptHash)}\n` : ''}`,
        paragraphs: [
          `Hi ${firstName},`,
          `A refund${amount ? ` of <strong>${escapeHtml(amount)}</strong>` : ''} has been completed${orderNumber ? ` for order <strong>${orderNumber}</strong>` : ''}. It can take a few working days to appear on the original payment method.`,
          `If you need a new prescription because an item was unavailable or your prescription has expired, contact ${escapeHtml(clinic.org)} at ${mailLink(clinicEmail)} or ${phoneLink(clinicPhone)}, ${escapeHtml(clinic.hours ?? '')}. Your pharmacy can contact the clinic instead.`,
        ],
        highlight: amount ? { label: 'Refund', value: amount } : undefined,
        cta: receiptHash ? { label: 'View receipt', href: paymentReceiptUrl(receiptHash) } : undefined,
        detailsTitle: 'Pharmacy contact details',
        details: [
          ...(value(payload, 'orderNumber') ? [{ label: 'Order reference', value: value(payload, 'orderNumber') }] : []),
          ...pharmacyDetails,
        ],
      });
    },
  },
  patient_ready_for_collection: {
    audience: 'patient',
    events: ['collection.ready'],
    schedule: 'collection_hours',
    summary: 'Sent when the order is marked ready to collect. Held until 09:00 on the next working day if after 15:00 Europe/London.',
    render: (payload) => {
      const { firstName, pharmacyName, orderNumber, readyPacks, totalPacks, partialReady, pharmacyDetails } = fields(payload);
      return render({
        kind: 'patient_ready_for_collection',
        payload,
        subject: partialReady ? 'Part of your prescription is ready to collect' : 'Your prescription is ready to collect',
        preheader: partialReady ? `${readyPacks} of ${totalPacks} packs are ready at the pharmacy.` : 'Your order is ready at the pharmacy.',
        title: partialReady ? 'Part ready to collect' : 'Ready to collect',
        text: partialReady
          ? `Hi ${value(payload, 'firstName') || 'there'},\n\n${readyPacks} of ${totalPacks} packs for order ${value(payload, 'orderNumber') || ''} are ready to collect from ${value(payload, 'pharmacyName') || 'the pharmacy'}. The remaining packs are not ready yet.\n`
          : `Hi ${value(payload, 'firstName') || 'there'},\n\nYour order${orderNumber ? ` ${value(payload, 'orderNumber')}` : ''} is ready to collect from ${value(payload, 'pharmacyName') || 'the pharmacy'}.\n`,
        paragraphs: [
          `Hi ${firstName},`,
          partialReady
            ? `<strong>${readyPacks} of ${totalPacks} packs</strong>${orderNumber ? ` for order <strong>${orderNumber}</strong>` : ''} are ready to collect from <strong>${pharmacyName}</strong>. The remaining packs are not ready yet.`
            : `Your prescription${orderNumber ? ` for order <strong>${orderNumber}</strong>` : ''} is ready to collect from <strong>${pharmacyName}</strong>. Please bring photo ID.`,
        ],
        detailsTitle: 'Collection details',
        details: pharmacyDetails,
        nextSteps: [
          'Bring photo ID when you collect.',
          'Ask at the pharmacy counter if you are unsure where to go.',
        ],
      });
    },
  },
  admin_new_enquiry_received: {
    audience: 'admin',
    events: ['enquiry.submitted'],
    schedule: 'immediate',
    summary: 'Sent to platform admins when a patient submits an eligibility enquiry.',
    render: (payload) => {
      return render({
        kind: 'admin_new_enquiry_received',
        payload,
        subject: 'New enquiry received',
        preheader: 'A new eligibility enquiry is waiting in the portal.',
        title: 'New enquiry received',
        text: [
          'A new eligibility enquiry has been received.',
          value(payload, 'caseReference') ? `Reference: ${value(payload, 'caseReference')}` : '',
          value(payload, 'provisionalPharmacyName') ? `Provisional pharmacy: ${value(payload, 'provisionalPharmacyName')}` : '',
        ].filter(Boolean).join('\n'),
        paragraphs: [
          'A patient has submitted an eligibility enquiry. Open the case in the portal. Name, phone and email stay there.',
        ],
        cta: { label: 'Open portal', href: 'https://portal.holistichealthhub.live' },
        detailsTitle: 'Enquiry',
        details: [
          { label: 'Reference', value: value(payload, 'caseReference') },
          { label: 'Provisional pharmacy', value: value(payload, 'provisionalPharmacyName') },
          { label: 'Source', value: enquirySourceLabel(value(payload, 'sourceType')) },
        ],
        nextSteps: [
          'Open the portal to continue the enquiry.',
          'Do not ask the patient to reply to this email.',
        ],
      });
    },
  },
  pharmacy_new_enquiry_assigned: {
    audience: 'pharmacy_owner',
    events: ['enquiry.submitted', 'enquiry.reassigned'],
    schedule: 'immediate',
    summary: 'Sent to the pharmacy owner when an eligibility enquiry is assigned to them.',
    render: (payload) => {
      const { pharmacyName, caseReference } = fields(payload);
      return render({
        kind: 'pharmacy_new_enquiry_assigned',
        payload,
        subject: 'New enquiry assigned to your pharmacy',
        preheader: 'An eligibility enquiry is waiting in Patients.',
        title: 'New enquiry assigned',
        text: `A new eligibility enquiry has been assigned to ${value(payload, 'pharmacyName') || 'your pharmacy'}${caseReference ? ` (${value(payload, 'caseReference')})` : ''}. Open Patients to review it.`,
        paragraphs: [
          `A new eligibility enquiry has been assigned to <strong>${pharmacyName}</strong>${caseReference ? ` (<strong>${caseReference}</strong>)` : ''}.`,
          'Open Patients to see the form answers. HHH may still move or complete this enquiry.',
        ],
        cta: { label: 'Open portal', href: 'https://portal.holistichealthhub.live' },
        detailsTitle: 'Enquiry',
        details: [{ label: 'Reference', value: value(payload, 'caseReference') }],
      });
    },
  },
  pharmacy_enquiry_declined: {
    audience: 'pharmacy_owner',
    events: ['enquiry.declined'],
    schedule: 'immediate',
    summary: 'Sent to the pharmacy owner when HHH declines an enquiry that was assigned to them.',
    render: (payload) => {
      const { pharmacyName, caseReference } = fields(payload);
      return render({
        kind: 'pharmacy_enquiry_declined',
        payload,
        subject: 'Enquiry declined by HHH',
        preheader: 'This enquiry is no longer assigned to your pharmacy.',
        title: 'Enquiry declined',
        text: `HHH declined an eligibility enquiry previously assigned to ${value(payload, 'pharmacyName') || 'your pharmacy'}${caseReference ? ` (${value(payload, 'caseReference')})` : ''}. It is no longer in New enquiries.`,
        paragraphs: [
          `HHH declined an eligibility enquiry previously assigned to <strong>${pharmacyName}</strong>${caseReference ? ` (<strong>${caseReference}</strong>)` : ''}.`,
          'It is no longer in New enquiries.',
        ],
        cta: { label: 'Open portal', href: 'https://portal.holistichealthhub.live' },
        detailsTitle: 'Enquiry',
        details: [{ label: 'Reference', value: value(payload, 'caseReference') }],
      });
    },
  },
  pharmacy_staff_invite: {
    audience: 'staff',
    events: ['staff.invited'],
    schedule: 'immediate',
    summary: 'Sent when an HHH admin invites pharmacy staff or a platform admin.',
    replyTo: 'IT',
    render: (payload) => {
      const { pharmacyName, actionLink } = fields(payload);
      return render({
        kind: 'pharmacy_staff_invite',
        payload,
        subject: 'Set up your Holistic Health Hub account',
        preheader: 'You have been invited to the staff portal.',
        title: 'Sign up',
        text: `You have been invited to access the Holistic Health Hub portal for ${value(payload, 'pharmacyName') || 'your pharmacy'}.\n\nSet your password:\n${actionLink}\n\nFor help signing in, email ${primaryAddress(keyContact('hhhPlatform'))}.`,
        paragraphs: [
          `You have been invited to the Holistic Health Hub staff portal${value(payload, 'pharmacyName') ? ` for <strong>${pharmacyName}</strong>` : ''}.`,
          'Use the button below to set your password, then sign in and set up two-factor authentication.',
        ],
        cta: actionLink ? { label: 'Set your password', href: actionLink } : undefined,
        footerNote: `If you were not expecting this invitation, you can ignore this email. For help signing in, email ${mailLink(primaryAddress(keyContact('hhhPlatform')))}.`,
      });
    },
  },
  pharmacy_password_reset: {
    audience: 'staff',
    events: ['staff.password_reset'],
    schedule: 'immediate',
    summary: 'Sent from the staff login form, or when an HHH admin queues a reset.',
    replyTo: 'IT',
    render: (payload) => {
      const { actionLink } = fields(payload);
      return render({
        kind: 'pharmacy_password_reset',
        payload,
        subject: 'Reset your Holistic Health Hub password',
        preheader: 'Use this link to choose a new password.',
        title: 'Reset password',
        text: `Use this link to reset your Holistic Health Hub password:\n${actionLink}\n\nFor help signing in, email ${primaryAddress(keyContact('hhhPlatform'))}.`,
        paragraphs: ['Use the button below to choose a new password for the Holistic Health Hub staff portal.'],
        cta: actionLink ? { label: 'Reset password', href: actionLink } : undefined,
        footerNote: `If you did not request this, you can ignore this email. The link expires after a short time. For help signing in, email ${mailLink(primaryAddress(keyContact('hhhPlatform')))}.`,
      });
    },
  },
  pharmacy_2fa_enabled: {
    audience: 'staff',
    events: ['staff.2fa_enabled'],
    schedule: 'immediate',
    summary: 'Sent after a staff member enrols an authenticator app.',
    replyTo: 'IT',
    render: (payload) => render({
      kind: 'pharmacy_2fa_enabled',
      payload,
      subject: 'Authenticator app added to your account',
      preheader: 'Two-factor authentication is now switched on.',
      title: '2FA set up',
      text: `An authenticator app has been added to your Holistic Health Hub staff account. Sign-in now needs your password and a six-digit code.\n\nIf you did not do this, email ${primaryAddress(keyContact('hhhPlatform'))} immediately.`,
      paragraphs: [
        'An authenticator app has been added to your Holistic Health Hub staff account.',
        'Sign-in now needs your password and a six-digit code from that app.',
      ],
      footerNote: `If you did not do this, email ${mailLink(primaryAddress(keyContact('hhhPlatform')))} immediately.`,
    }),
  },
  pharmacy_2fa_disabled: {
    audience: 'staff',
    events: ['staff.2fa_disabled'],
    schedule: 'immediate',
    summary: 'Sent after an HHH admin removes the authenticator app.',
    replyTo: 'IT',
    render: (payload) => render({
      kind: 'pharmacy_2fa_disabled',
      payload,
      subject: 'Authenticator app removed from your account',
      preheader: 'Two-factor authentication has been turned off.',
      title: '2FA turned off',
      text: `The authenticator app on your Holistic Health Hub staff account has been removed. You will be asked to set it up again the next time you sign in.\n\nIf you did not expect this, email ${primaryAddress(keyContact('hhhPlatform'))} immediately.`,
      paragraphs: [
        'The authenticator app on your Holistic Health Hub staff account has been removed.',
        'You will be asked to set it up again the next time you sign in.',
      ],
      footerNote: `If you did not expect this, email ${mailLink(primaryAddress(keyContact('hhhPlatform')))} immediately.`,
    }),
  },
  /**
   * Goes to the pharmacy's own operational mailbox, and the pharmacy is the
   * controller for this patient — these are its own records, not a disclosure.
   * It still carries no health information: who has been referred and how to
   * reach them, with the form answers left in the portal.
   */
  pharmacy_new_patient_referred: {
    audience: 'pharmacy_owner',
    events: ['referral.activated'],
    schedule: 'immediate',
    summary: 'Sent when HHH admin activates a referred patient for that pharmacy. Carries the patient name and contact details.',
    render: (payload) => {
      const { pharmacyName, enquiry } = fields(payload);
      // An identifier the pharmacy checks against its own records, so it is written the way they store it.
      const dob = shortDate(value(payload, 'dob'));
      const patientDetails = [
        { label: 'Name', value: enquiry.name },
        { label: 'Date of birth', value: dob },
        { label: 'Phone', value: enquiry.phone },
        { label: 'Email', value: enquiry.email },
        { label: 'Reference', value: value(payload, 'caseReference') },
      ];
      const plainDetails = patientDetails
        .filter(item => item.value)
        .map(item => `${item.label}: ${item.value}`)
        .join('\n');
      return render({
        kind: 'pharmacy_new_patient_referred',
        payload,
        subject: `New patient referred${enquiry.name ? ` — ${enquiry.name}` : ''}`,
        preheader: enquiry.name ? `${enquiry.name} has been referred to your pharmacy.` : 'A new referral is waiting in the portal.',
        title: 'New patient referred',
        text: `A new patient has been referred to ${value(payload, 'pharmacyName') || 'your pharmacy'}.\n\n${plainDetails}\n\nOpen the portal for their form answers.`,
        paragraphs: [`A new patient has been referred to <strong>${pharmacyName}</strong>.`],
        detailsTitle: 'Patient',
        details: patientDetails,
        cta: { label: 'Open portal', href: 'https://portal.holistichealthhub.live' },
        footerNote: 'Their form answers and the full record are in the portal.',
      });
    },
  },
  pharmacy_payment_received: {
    audience: 'pharmacy_owner',
    events: ['payment.settled'],
    schedule: 'immediate',
    summary: 'Sent when a patient payment is recorded (Worldpay settlement or manual pay).',
    render: (payload) => {
      const { orderNumber, amount } = fields(payload);
      return render({
        kind: 'pharmacy_payment_received',
        payload,
        subject: 'Payment received',
        preheader: 'A patient payment has been recorded.',
        title: 'Payment received',
        text: `Payment received${amount ? `: ${amount}` : ''}${orderNumber ? ` for order ${value(payload, 'orderNumber')}` : ''}.`,
        paragraphs: [`A patient payment has been recorded${amount ? `: <strong>${escapeHtml(amount)}</strong>` : ''}${orderNumber ? ` for order <strong>${orderNumber}</strong>` : ''}.`],
        highlight: amount ? { label: 'Amount received', value: amount } : undefined,
        detailsTitle: 'Order details',
        details: [{ label: 'Order reference', value: value(payload, 'orderNumber') }],
      });
    },
  },
  pharmacy_order_accepted: {
    audience: 'pharmacy_owner',
    events: ['order.accepted'],
    schedule: 'immediate',
    summary: 'Sent when the pharmacy submits / accepts an order.',
    render: (payload) => {
      const { orderNumber } = fields(payload);
      return render({
        kind: 'pharmacy_order_accepted',
        payload,
        subject: 'Order accepted',
        preheader: 'An order is now with Curaleaf.',
        title: 'Order accepted',
        text: `An order has been accepted${orderNumber ? `: ${value(payload, 'orderNumber')}` : ''}.`,
        paragraphs: [`An order has been accepted${orderNumber ? `: <strong>${orderNumber}</strong>` : ''}.`],
      });
    },
  },
  pharmacy_order_cancelled: {
    audience: 'pharmacy_owner',
    events: ['order.cancelled'],
    schedule: 'immediate',
    summary: 'Sent when Curaleaf reports a cancellation that needs pharmacy action.',
    render: (payload) => {
      const { orderNumber, summary } = fields(payload);
      const labs = keyContact('curaleafLabs');
      const clinic = keyContact('clinic');
      const labsPhone = labs.phone ?? '';
      const clinicPhone = clinic.phone ?? '';
      const clinicEmail = primaryAddress(clinic);
      const purchaseOrderId = value(payload, 'purchaseOrderId');
      const quote = purchaseOrderId
        ? `purchase order ${purchaseOrderId}`
        : (value(payload, 'orderNumber') ? `order ${value(payload, 'orderNumber')}` : 'the order reference');
      const quoteHtml = purchaseOrderId
        ? `purchase order <strong>${escapeHtml(purchaseOrderId)}</strong>`
        : (orderNumber ? `order <strong>${orderNumber}</strong>` : 'the order reference');
      const callLabs = `Phone ${labs.org} on ${labsPhone} before speaking to the patient, and quote ${quote}. Lines are open ${labs.hours}.`;
      const rePrescribe = `If a line needs a new prescription because the item is unavailable or the prescription has expired, you or the patient can contact ${clinic.org} at ${clinicEmail} or ${clinicPhone}. The clinic is open ${clinic.hours}. You decide which of you makes that call.`;
      return render({
        kind: 'pharmacy_order_cancelled',
        payload,
        subject: 'Supplier cancellation',
        preheader: 'Phone Curaleaf Labs and quote the purchase order.',
        title: 'Supplier cancellation',
        text: `Curaleaf has reported a cancellation for order${orderNumber ? `: ${value(payload, 'orderNumber')}` : ''}.${value(payload, 'summary') ? `\n\n${value(payload, 'summary')}` : ''}\n\n${callLabs}\n\n${rePrescribe}`,
        paragraphs: [
          `Curaleaf has reported a cancellation for order${orderNumber ? `: <strong>${orderNumber}</strong>` : ''}.`,
          ...(summary ? [summary] : []),
          `Phone ${escapeHtml(labs.org)} on ${phoneLink(labsPhone)} before speaking to the patient, and quote ${quoteHtml}. Lines are open ${escapeHtml(labs.hours ?? '')}.`,
          `If a line needs a new prescription because the item is unavailable or the prescription has expired, you or the patient can contact ${escapeHtml(clinic.org)} at ${mailLink(clinicEmail)} or ${phoneLink(clinicPhone)}. The clinic is open ${escapeHtml(clinic.hours ?? '')}. You decide which of you makes that call.`,
        ],
      });
    },
  },
  pharmacy_delivery_issue: {
    audience: 'pharmacy_owner',
    events: ['order.delivery_issue'],
    schedule: 'immediate',
    summary: 'Sent when fulfilment maintenance detects a delay.',
    render: (payload) => {
      const { orderNumber, summary } = fields(payload);
      return render({
        kind: 'pharmacy_delivery_issue',
        payload,
        subject: 'Delivery issue requires attention',
        preheader: 'A fulfilment delay needs pharmacy awareness.',
        title: 'Delivery issue',
        text: `A delivery issue requires attention${orderNumber ? ` for order ${value(payload, 'orderNumber')}` : ''}.${value(payload, 'summary') ? `\n\n${value(payload, 'summary')}` : ''}`,
        paragraphs: [
          `A delivery issue requires attention${orderNumber ? ` for order <strong>${orderNumber}</strong>` : ''}.`,
          ...(summary ? [summary] : []),
        ],
      });
    },
  },
  pharmacy_order_dispatched: {
    audience: 'pharmacy_owner',
    events: ['order.dispatched'],
    schedule: 'immediate',
    summary: 'Sent when Curaleaf reports the consignment as dispatched (or partially dispatched) to the pharmacy.',
    render: (payload) => {
      const { orderNumber, summary } = fields(payload);
      return render({
        kind: 'pharmacy_order_dispatched',
        payload,
        subject: 'Order dispatched update',
        preheader: 'A supplier consignment is on the way.',
        title: 'Order dispatched',
        text: `${value(payload, 'summary') || 'An order has been dispatched.'}${orderNumber ? `\nOrder: ${value(payload, 'orderNumber')}` : ''}`,
        paragraphs: [
          summary || 'An order has been dispatched.',
          ...(orderNumber ? [`Order: <strong>${orderNumber}</strong>`] : []),
        ],
      });
    },
  },
  pharmacy_prescription_close_to_expiry: {
    audience: 'pharmacy_owner',
    events: ['order.near_expiry'],
    schedule: 'immediate',
    summary: 'Sent when a paid prescription is approaching its 28-day limit.',
    render: (payload) => {
      const { orderNumber, summary } = fields(payload);
      return render({
        kind: 'pharmacy_prescription_close_to_expiry',
        payload,
        subject: 'Prescription close to expiry',
        preheader: 'A prescription is approaching its 28-day limit.',
        title: 'Prescription close to expiry',
        text: `A prescription is close to expiry${orderNumber ? ` for order ${value(payload, 'orderNumber')}` : ''}.${value(payload, 'summary') ? `\n\n${value(payload, 'summary')}` : ''}`,
        paragraphs: [
          `A prescription is close to expiry${orderNumber ? ` for order <strong>${orderNumber}</strong>` : ''}.`,
          ...(summary ? [summary] : []),
        ],
      });
    },
  },
  pharmacy_onboarding_submitted: {
    audience: 'pharmacy_owner',
    events: ['pharmacy_onboarding.terms_accepted'],
    schedule: 'immediate',
    summary: 'Sent: once per request, when the pharmacy accepts the Partner Terms (nothing is sent for the Curaleaf form alone). One email to the Terms signer and the request\'s pharmacy email (one address when they match). Wording, sender name and Reply-To are admin content (onboarding.email.sent); it mentions Worldpay by whether an application has been submitted, and links the Partner Terms only once they are published.',
    replyTo: 'onboarding',
    render: (payload) => onboardingEmail('pharmacy_onboarding_submitted', payload, 'Your Holistic Health Hub application'),
  },
  pharmacy_onboarding_held: {
    audience: 'pharmacy_owner',
    events: ['pharmacy_onboarding.held'],
    schedule: 'immediate',
    summary: 'Hold: each time HHH puts a request on hold or changes the hold reason (lifting a hold sends nothing). To the Terms signer and the pharmacy email. Carries only the chosen reason\'s paragraphs (A existing Curaleaf customer, B more information needed, C Curaleaf declined), plus a Worldpay line when an application has been submitted. Admin content: onboarding.email.hold.',
    replyTo: 'onboarding',
    render: (payload) => onboardingEmail('pharmacy_onboarding_held', payload, 'Your Holistic Health Hub application is on hold'),
  },
  pharmacy_onboarding_activated: {
    audience: 'pharmacy_owner',
    events: ['pharmacy_onboarding.activated'],
    schedule: 'immediate',
    summary: 'Activation: once per request, when HHH activates it and the branch is created in demonstration mode ("ready to try"). To the Terms signer and the pharmacy email. Includes the training booking link when one is set. Admin content: onboarding.email.activation.',
    replyTo: 'onboarding',
    render: (payload) => onboardingEmail('pharmacy_onboarding_activated', payload, 'Your Holistic Health Hub account is ready to try'),
  },
  pharmacy_onboarding_live: {
    audience: 'pharmacy_owner',
    events: ['pharmacy_onboarding.live'],
    schedule: 'immediate',
    summary: 'Live: once per branch, the first time it goes live (Curaleaf PHAR code and API key saved); editing either later sends nothing. To the Terms signer and the pharmacy email. Gives the PHAR code (never the API key), how payment is taken (by whether live Worldpay credentials are validated) and the go-live checklist items still open at sending, each block left out when empty. Admin content: onboarding.email.live.',
    replyTo: 'onboarding',
    render: (payload) => onboardingEmail('pharmacy_onboarding_live', payload, 'You are live on Holistic Health Hub'),
  },
  curaleaf_new_account_application: {
    audience: 'admin',
    events: ['pharmacy_onboarding.terms_accepted'],
    schedule: 'immediate',
    summary: 'One email to Curaleaf Laboratories (To) with partner success copied (CC), sent once per request when the pharmacy accepts the Partner Terms, never at Curaleaf form submission alone. Attached: the filled form as Curaleaf-new-account_[GPhC]_[Branch]_[YYYY-MM-DD].pdf and the controlled drug licence. A demo GPhC goes to the CC list only, marked DEMO. Recipients are set in config; wording, sender name and Reply-To (Healius) are admin content (onboarding.email.curaleafApplication).',
    replyTo: 'onboarding',
    render: (payload) => onboardingEmail('curaleaf_new_account_application', payload, 'New account application'),
  },
  worldpay_application_to_worldpay: {
    audience: 'admin',
    events: ['worldpay_application.submitted'],
    schedule: 'immediate',
    summary: 'WP-01. Sent straight away to the HHH admin inbox (the recipients set in admin) when a pharmacy submits its Worldpay application, for admin to forward to Worldpay. The application PDF and spreadsheet are attached, plus the service information PDF when the pharmacy has no website. Subject and wording are edited in admin; no personal or bank details are written in the body.',
    replyTo: 'onboarding',
    render: (payload) => contentEmail('worldpay_application_to_worldpay', payload, 'Worldpay application', 'Please find attached a card processing application from a Holistic Health Hub partner pharmacy.'),
  },
  admin_curaleaf_prescriber_stuck: {
    audience: 'admin',
    events: ['curaleaf_placement.prescriber_stuck'],
    schedule: 'immediate',
    summary: 'Sent to the HHH admin inbox (CURALEAF_STUCK_ALERT_TO, default admin@holistichealthhub.live) when paid orders have waited 3 days for Curaleaf to verify their prescriber. One email per pharmacy and prescriber, listing the order numbers, repeated every 3 days while any are still waiting. Written for admin to forward to Curaleaf: pharmacy, Curaleaf customer ID, prescriber name, PIN, GMC/GPhC and Curaleaf prescriber ID. No patient details.',
    render: (payload) => contentEmail('admin_curaleaf_prescriber_stuck', payload, 'Curaleaf prescriber verification needed', 'Paid orders are waiting for Curaleaf to verify their prescriber.'),
  },
  pharmacy_partner_terms_signed: {
    audience: 'pharmacy_owner',
    events: ['partner_terms.signed'],
    schedule: 'immediate',
    replyTo: 'onboarding',
    summary: 'Sent to the pharmacy email and the person who signed, when a pharmacy signs a version of the Partner Terms (at sign-up or at the login prompt). The signed copy (the Terms PDF with a stamped signature page) is attached. Wording is editable in Onboarding settings.',
    render: (payload) => {
      const pharmacyName = escapeHtml(value(payload, 'pharmacyName') || 'your pharmacy');
      const version = escapeHtml(value(payload, 'termsVersion'));
      const signer = escapeHtml(value(payload, 'signerName'));
      const signedOn = escapeHtml(value(payload, 'signedOn'));
      return render({
        kind: 'pharmacy_partner_terms_signed',
        payload,
        subject: 'Your signed Holistic Health Hub Partner Terms',
        preheader: 'A copy of the Partner Terms you signed is attached.',
        title: 'Partner Terms signed',
        text: `Thank you. ${value(payload, 'signerName')} signed the Holistic Health Hub Partner Terms (version ${value(payload, 'termsVersion')}) for ${value(payload, 'pharmacyName') || 'your pharmacy'} on ${value(payload, 'signedOn')}.\n\nA signed copy is attached, and you can download it at any time from the Onboarding page in your account.`,
        paragraphs: [
          `Thank you. <strong>${signer}</strong> signed the Holistic Health Hub Partner Terms (version ${version}) for <strong>${pharmacyName}</strong> on ${signedOn}.`,
          'A signed copy is attached. You can also download it at any time from the Onboarding page in your account.',
        ],
        footerNote: 'If you did not expect this email, reply to it and we will look into it.',
      });
    },
  },
  pharmacy_partner_terms_reminder: {
    audience: 'pharmacy_owner',
    events: ['partner_terms.reminder'],
    schedule: 'immediate',
    replyTo: 'onboarding',
    summary: 'Sent once per Partner Terms version to the pharmacy email and the person who first saw the sign prompt, 7 days after the prompt was first shown at login without being signed. Never sent to a pharmacy that has not logged in since the version was published. Wording is editable in Onboarding settings.',
    render: (payload) => {
      const pharmacyName = escapeHtml(value(payload, 'pharmacyName') || 'your pharmacy');
      const version = escapeHtml(value(payload, 'termsVersion'));
      return render({
        kind: 'pharmacy_partner_terms_reminder',
        payload,
        subject: 'Please sign the Holistic Health Hub Partner Terms',
        preheader: 'The updated Partner Terms are waiting to be signed.',
        title: 'Partner Terms waiting',
        text: `The Holistic Health Hub Partner Terms (version ${value(payload, 'termsVersion')}) for ${value(payload, 'pharmacyName') || 'your pharmacy'} were shown in your account a week ago and have not been signed yet.\n\nThe superintendent pharmacist, or someone authorised to sign for the company, can sign them the next time they log in.\n\nOpen your account: https://portal.holistichealthhub.live`,
        paragraphs: [
          `The Holistic Health Hub Partner Terms (version ${version}) for <strong>${pharmacyName}</strong> were shown in your account a week ago and have not been signed yet.`,
          'The superintendent pharmacist, or someone authorised to sign for the company, can read and sign them the next time they log in.',
        ],
        cta: { label: 'Open your account', href: 'https://portal.holistichealthhub.live' },
        footerNote: 'If you have a question about the Partner Terms, reply to this email.',
      });
    },
  },
  pharmacy_collection_completed: {
    audience: 'pharmacy_owner',
    events: ['collection.completed'],
    schedule: 'immediate',
    summary: 'Sent when the pharmacy records a handout / collection.',
    render: (payload) => {
      const { orderNumber, summary } = fields(payload);
      return render({
        kind: 'pharmacy_collection_completed',
        payload,
        subject: 'Collection completed update',
        preheader: 'A collection has been recorded.',
        title: 'Collection completed',
        text: `${value(payload, 'summary') || 'Collection has been completed.'}${orderNumber ? `\nOrder: ${value(payload, 'orderNumber')}` : ''}`,
        paragraphs: [
          summary || 'Collection has been completed.',
          ...(orderNumber ? [`Order: <strong>${orderNumber}</strong>`] : []),
        ],
      });
    },
  },
} as const satisfies Record<EmailTemplateCode, EmailDefinition>;

export type PatientMessageKind = {
  [K in EmailTemplateCode]: (typeof EMAILS)[K]['audience'] extends 'patient' ? K : never
}[EmailTemplateCode];

export const PATIENT_MESSAGE_KINDS = EMAIL_TEMPLATE_CODES.filter(
  (code): code is PatientMessageKind => EMAILS[code].audience === 'patient',
);

export function isEmailTemplateCode(value: string): value is EmailTemplateCode {
  return (EMAIL_TEMPLATE_CODES as readonly string[]).includes(value);
}

export function isPatientMessageKind(value: string): value is PatientMessageKind {
  return isEmailTemplateCode(value) && EMAILS[value].audience === 'patient';
}

export function isEmailEventName(value: string): value is EmailEventName {
  return (EMAIL_EVENT_NAMES as readonly string[]).includes(value);
}

export function templatesForEvent(event: EmailEventName): EmailTemplateCode[] {
  return EMAIL_TEMPLATE_CODES.filter(code => (EMAILS[code].events as readonly EmailEventName[]).includes(event));
}

/**
 * Renders one email. `copy` is the wording admins have saved (Onboarding settings →
 * Emails); without it, or for a piece nobody has edited, the email is the code's own.
 */
export function renderEmailTemplate(kind: EmailTemplateCode, payload: unknown, copy?: EmailCopyOverrides): RenderedEmail {
  const previous = activeCopy;
  activeCopy = (copy as Partial<Record<string, Partial<Record<EmailCopySlot, string>>>> | undefined)?.[kind] ?? null;
  try {
    return EMAILS[kind].render(payload);
  } finally {
    activeCopy = previous;
  }
}

export function messageIdempotencyKey(parts: Array<string | number | null | undefined>) {
  return parts.map(part => String(part ?? '')).join(':').slice(0, 180);
}

export const patientMessageIdempotencyKey = messageIdempotencyKey;

const AUDIENCE_HEADING: Record<EmailAudience, string> = {
  patient: 'Patient emails',
  pharmacy_owner: 'Pharmacy owner emails',
  staff: 'Staff login emails',
  admin: 'Admin emails',
};

export function formatEmailRoster(): string {
  const lines = [
    '# Email roster',
    '',
    'Source of truth: `services/api-sql/src/application/notifications/email-catalog.ts`.',
    'Change copy, audience, or send-when there. This file is generated from that catalog.',
    '',
    'Sender is one Holistic Health Hub address (`noreply@holistichealthhub.live` when the live Resend records are published). That mailbox is not monitored. Pharmacy contact details are included in the body where useful. Do not invent pharmacy-branded From addresses.',
    '',
    `Templates marked with a Reply-To below send one, pointing at a monitored alias on \`${emailAliasDomain()}\`. Every other template sends none. Do not write copy that invites a reply without setting \`replyTo\` on the template.`,
    '',
    'Operational pharmacy emails go to the pharmacy email, or the superintendent when that inbox is blank. Account emails (invite, password reset, 2FA) still go to the individual staff member. Patient emails never include those addresses.',
    '',
  ];
  const order: EmailAudience[] = ['patient', 'pharmacy_owner', 'staff', 'admin'];
  for (const audience of order) {
    lines.push(`## ${AUDIENCE_HEADING[audience]}`, '');
    for (const code of EMAIL_TEMPLATE_CODES) {
      if (EMAILS[code].audience !== audience) continue;
      const events = EMAILS[code].events.join(', ');
      const replyTo = replyToFor(code);
      lines.push(`- \`${code}\` (${events}): ${EMAILS[code].summary}${replyTo ? ` Reply-To: \`${replyTo}\`.` : ''}`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}
