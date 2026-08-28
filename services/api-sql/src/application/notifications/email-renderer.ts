import type { EmailTemplateCode } from './message-kinds.js';
import { brandedEmail, escapeHtml, resolveEmailHeader, safeHttpUrl } from './email-layout.js';
import { enquiryDisplayFields } from './email-mask.js';

type RenderedEmail = {
  subject: string;
  text: string;
  html: string;
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
  const lines = [{ label: 'Medicine', value: money(value(payload, 'medicineTotalPence') || 0, currency) }];
  const dispensing = Number(value(payload, 'dispensingFeePence') || 0);
  const delivery = Number(value(payload, 'pharmacyDeliveryPence') || 0);
  if (dispensing > 0) lines.push({ label: 'Dispensing Cost', value: money(dispensing, currency) });
  if (delivery > 0) lines.push({ label: 'Pharmacy Delivery', value: money(delivery, currency) });
  return lines;
}

function paymentReceiptUrl(receiptHash: string) {
  return `https://holistichealthhub.live/receipt/${encodeURIComponent(receiptHash)}`;
}

function enquirySourceLabel(sourceType: string) {
  if (sourceType === 'GENERAL_HHH_WEBSITE') return 'Website';
  if (sourceType === 'PHARMACY_QR' || sourceType === 'LEGACY_PHARMACY_QR') return 'Pharmacy QR';
  return sourceType.replaceAll('_', ' ').toLowerCase();
}

function isAdminAudience(kind: EmailTemplateCode, payload: unknown) {
  return kind === 'admin_new_enquiry_received' || value(payload, 'pharmacyName') === 'HHH admin workspace';
}

function eyebrowFor(kind: EmailTemplateCode, admin: boolean) {
  if (admin) return 'Admin alert';
  if (
    kind === 'pharmacy_staff_invite'
    || kind === 'pharmacy_password_reset'
    || kind === 'pharmacy_2fa_enabled'
    || kind === 'pharmacy_2fa_disabled'
  ) return 'Staff account';
  if (kind.startsWith('patient_')) return 'Patient order update';
  return 'Pharmacy update';
}

function render(input: {
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
  nextSteps?: string[];
  footerNote?: string;
}): RenderedEmail {
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
      header: resolveEmailHeader({
        audience: admin ? 'admin' : 'pharmacy',
        organisationId: value(input.payload, 'organisationId'),
        pharmacyName: value(input.payload, 'pharmacyName'),
      }),
    }),
  };
}

export function renderEmailTemplate(kind: EmailTemplateCode, payload: unknown): RenderedEmail {
  const firstName = escapeHtml(value(payload, 'firstName') || value(payload, 'patientFirstName') || 'there');
  const pharmacyName = escapeHtml(value(payload, 'pharmacyName') || 'the pharmacy');
  const orderNumber = escapeHtml(value(payload, 'orderNumber'));
  const amount = money(value(payload, 'amountPence') || 0, value(payload, 'currency') || 'GBP');
  const paymentUrl = safeHttpUrl(value(payload, 'paymentUrl'));
  const receiptHash = value(payload, 'receiptHash');
  const actionLink = safeHttpUrl(value(payload, 'actionLink'));
  const caseReference = escapeHtml(value(payload, 'caseReference'));
  const summary = escapeHtml(value(payload, 'summary'));
  const enquiry = enquiryDisplayFields(payload);
  const pharmacyDetails = [
    { label: 'Pharmacy', value: value(payload, 'pharmacyName') },
    { label: 'Phone', value: value(payload, 'pharmacyPhone') },
    { label: 'Email', value: value(payload, 'pharmacyEmail') },
    { label: 'Address', value: value(payload, 'pharmacyAddress') },
  ];

  switch (kind) {
    case 'patient_payment_request':
      return render({
        kind,
        payload,
        subject: 'Payment needed for your order',
        preheader: 'Complete payment securely so your pharmacy can continue the order.',
        title: 'Payment needed',
        text: `Hi ${value(payload, 'firstName') || 'there'},\n\nPlease complete your payment${amount ? ` of ${amount}` : ''} using this secure link:\n${paymentUrl}\n\n${paymentBreakdown(payload).map(line => `${line.label}: ${line.value}`).join('\n')}\n`,
        paragraphs: [
          `Hi ${firstName},`,
          'Your order is ready to move forward. Complete payment below and the pharmacy can continue preparing it for you.',
        ],
        highlight: amount ? { label: 'Amount due', value: amount } : undefined,
        cta: paymentUrl ? { label: 'Pay now', href: paymentUrl } : undefined,
        detailsTitle: 'Order breakdown',
        details: [...paymentBreakdown(payload), ...pharmacyDetails],
        nextSteps: [
          'Use the secure link above to complete payment.',
          'We will confirm as soon as payment is received.',
          'The pharmacy will continue processing your order.',
        ],
        footerNote: 'This is a secure payment link. If you were not expecting this email, you can ignore it.',
      });
    case 'patient_payment_confirmation':
      return render({
        kind,
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
        cta: receiptHash ? { label: 'View receipt', href: paymentReceiptUrl(receiptHash) } : undefined,
        detailsTitle: 'Order details',
        details: [
          { label: 'Order reference', value: value(payload, 'orderNumber') },
          ...paymentBreakdown(payload),
          ...pharmacyDetails,
        ],
      });
    case 'patient_refunded':
      return render({
        kind,
        payload,
        subject: 'Your payment has been refunded',
        preheader: 'A refund has been completed for your order.',
        title: 'Payment refunded',
        text: `Hi ${value(payload, 'firstName') || 'there'},\n\nA refund${amount ? ` of ${amount}` : ''} has been completed${orderNumber ? ` for order ${value(payload, 'orderNumber')}` : ''}. It can take a few working days to appear on the original payment method.\n`,
        paragraphs: [
          `Hi ${firstName},`,
          `A refund${amount ? ` of <strong>${escapeHtml(amount)}</strong>` : ''} has been completed${orderNumber ? ` for order <strong>${orderNumber}</strong>` : ''}. It can take a few working days to appear on the original payment method.`,
        ],
        detailsTitle: 'Pharmacy contact details',
        details: pharmacyDetails,
      });
    case 'patient_ready_for_collection':
      return render({
        kind,
        payload,
        subject: 'Your prescription is ready to collect',
        preheader: 'Your order is ready at the pharmacy.',
        title: 'Ready to collect',
        text: `Hi ${value(payload, 'firstName') || 'there'},\n\nYour order${orderNumber ? ` ${value(payload, 'orderNumber')}` : ''} is ready to collect from ${value(payload, 'pharmacyName') || 'the pharmacy'}.\n`,
        paragraphs: [
          `Hi ${firstName},`,
          `Your prescription${orderNumber ? ` for order <strong>${orderNumber}</strong>` : ''} is ready to collect from <strong>${pharmacyName}</strong>. Please bring photo ID.`,
        ],
        detailsTitle: 'Collection details',
        details: pharmacyDetails,
        nextSteps: [
          'Bring photo ID when you collect.',
          'Ask at the pharmacy counter if you are unsure where to go.',
        ],
      });
    case 'admin_new_enquiry_received':
      return render({
        kind,
        payload,
        subject: 'New enquiry received',
        preheader: 'A new eligibility enquiry is waiting in the portal.',
        title: 'New enquiry received',
        text: [
          'A new eligibility enquiry has been received. Open the portal to view the full patient record.',
          enquiry.name ? `Name: ${enquiry.name}` : '',
          enquiry.phone ? `Phone: ${enquiry.phone}` : '',
          enquiry.email ? `Email: ${enquiry.email}` : '',
        ].filter(Boolean).join('\n'),
        paragraphs: [
          'A patient has submitted an eligibility enquiry. Identifiable details are masked here. Open the portal to view the full name, phone number and email address.',
        ],
        cta: { label: 'Open portal', href: 'https://portal.holistichealthhub.live' },
        detailsTitle: 'Patient details',
        details: [
          { label: 'Name', value: enquiry.name },
          { label: 'Phone', value: enquiry.phone },
          { label: 'Email', value: enquiry.email },
          { label: 'Provisional pharmacy', value: value(payload, 'provisionalPharmacyName') },
          { label: 'Source', value: enquirySourceLabel(value(payload, 'sourceType')) },
        ],
        nextSteps: [
          'Open the portal to view the full patient record.',
          'Assign or continue the enquiry from there.',
          'Do not ask the patient to reply to this email.',
        ],
      });
    case 'pharmacy_staff_invite':
      return render({
        kind,
        payload,
        subject: 'Set up your Holistic Health Hub account',
        preheader: 'You have been invited to the staff portal.',
        title: 'Sign up',
        text: `You have been invited to access the Holistic Health Hub portal for ${value(payload, 'pharmacyName') || 'your pharmacy'}.\n\nSet your password:\n${actionLink}\n`,
        paragraphs: [
          `You have been invited to the Holistic Health Hub staff portal${value(payload, 'pharmacyName') ? ` for <strong>${pharmacyName}</strong>` : ''}.`,
          'Use the button below to set your password, then sign in and set up two-factor authentication.',
        ],
        cta: actionLink ? { label: 'Set your password', href: actionLink } : undefined,
        footerNote: 'If you were not expecting this invitation, you can ignore this email.',
      });
    case 'pharmacy_password_reset':
      return render({
        kind,
        payload,
        subject: 'Reset your Holistic Health Hub password',
        preheader: 'Use this link to choose a new password.',
        title: 'Reset password',
        text: `Use this link to reset your Holistic Health Hub password:\n${actionLink}\n`,
        paragraphs: ['Use the button below to choose a new password for the Holistic Health Hub staff portal.'],
        cta: actionLink ? { label: 'Reset password', href: actionLink } : undefined,
        footerNote: 'If you did not request this, you can ignore this email. The link expires after a short time.',
      });
    case 'pharmacy_2fa_enabled':
      return render({
        kind,
        payload,
        subject: 'Authenticator app added to your account',
        preheader: 'Two-factor authentication is now switched on.',
        title: '2FA set up',
        text: 'An authenticator app has been added to your Holistic Health Hub staff account. Sign-in now needs your password and a six-digit code.\n',
        paragraphs: [
          'An authenticator app has been added to your Holistic Health Hub staff account.',
          'Sign-in now needs your password and a six-digit code from that app.',
        ],
        footerNote: 'If you did not do this, contact an HHH administrator immediately.',
      });
    case 'pharmacy_2fa_disabled':
      return render({
        kind,
        payload,
        subject: 'Authenticator app removed from your account',
        preheader: 'Two-factor authentication has been turned off.',
        title: '2FA turned off',
        text: 'The authenticator app on your Holistic Health Hub staff account has been removed. You will be asked to set it up again the next time you sign in.\n',
        paragraphs: [
          'The authenticator app on your Holistic Health Hub staff account has been removed.',
          'You will be asked to set it up again the next time you sign in.',
        ],
        footerNote: 'If you did not expect this, contact an HHH administrator immediately.',
      });
    case 'pharmacy_new_patient_referred':
      return render({
        kind,
        payload,
        subject: 'New patient referred to your pharmacy',
        preheader: 'A new referral is waiting in the portal.',
        title: 'New patient referred',
        text: `A new patient has been referred to ${value(payload, 'pharmacyName') || 'your pharmacy'}${value(payload, 'caseReference') ? ` (${value(payload, 'caseReference')})` : ''}.`,
        paragraphs: [`A new patient has been referred to <strong>${pharmacyName}</strong>${caseReference ? ` (<strong>${caseReference}</strong>)` : ''}.`],
      });
    case 'pharmacy_payment_received':
      return render({
        kind,
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
    case 'pharmacy_order_accepted':
      return render({
        kind,
        payload,
        subject: 'Order accepted',
        preheader: 'An order is now with Curaleaf.',
        title: 'Order accepted',
        text: `An order has been accepted${orderNumber ? `: ${value(payload, 'orderNumber')}` : ''}.`,
        paragraphs: [`An order has been accepted${orderNumber ? `: <strong>${orderNumber}</strong>` : ''}.`],
      });
    case 'pharmacy_order_cancelled':
      return render({
        kind,
        payload,
        subject: 'Order cancelled',
        preheader: 'An order needs refund or replacement action.',
        title: 'Order cancelled',
        text: `An order has been cancelled${orderNumber ? `: ${value(payload, 'orderNumber')}` : ''}.${value(payload, 'summary') ? `\n\n${value(payload, 'summary')}` : ''}`,
        paragraphs: [
          `An order has been cancelled${orderNumber ? `: <strong>${orderNumber}</strong>` : ''}.`,
          ...(summary ? [summary] : []),
        ],
      });
    case 'pharmacy_delivery_issue':
      return render({
        kind,
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
    case 'pharmacy_order_dispatched':
      return render({
        kind,
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
    case 'pharmacy_prescription_close_to_expiry':
      return render({
        kind,
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
    case 'pharmacy_collection_completed':
      return render({
        kind,
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
  }
}
