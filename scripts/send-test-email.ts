/**
 * Send one real email through Resend, for checking how a template actually lands.
 *
 * This deliberately mirrors deliverOne() in application/workers/deliver-messages.ts
 * — same renderer, same From resolution, and the logos attached as inline CID
 * images rather than data URIs. A data-URI preview opens fine in a browser but
 * Gmail and Outlook commonly strip those, so it tells you nothing about whether
 * the footer lockup survives a real inbox. This does.
 *
 * Nothing here touches the outbox, so it cannot interfere with patient mail.
 *
 *   RESEND_API_KEY=... npx tsx scripts/send-test-email.ts you@example.com
 *   RESEND_API_KEY=... npx tsx scripts/send-test-email.ts you@example.com patient_payment_receipt
 */
import { renderEmailTemplate } from '../services/api-sql/src/application/notifications/email-renderer.js';
import { emailInlineImages } from '../services/api-sql/src/application/notifications/email-assets.js';
import { resolveEmailHeader } from '../services/api-sql/src/application/notifications/email-layout.js';

const to = process.argv[2];
const templateCode = process.argv[3] ?? 'patient_ready_for_collection';
if (!to) {
  console.error('Usage: npx tsx scripts/send-test-email.ts <recipient> [templateCode]');
  process.exit(1);
}

const apiKey = process.env.RESEND_API_KEY?.trim();
if (!apiKey) {
  console.error('RESEND_API_KEY is not set. Export it for this command only; do not commit it.');
  process.exit(1);
}

// Same default as the worker, so a test proves what production will do.
const fromAddress = process.env.EMAIL_FROM_ADDRESS?.trim() || 'noreply@holistichealthhub.live';
const from = fromAddress.includes('<') ? fromAddress : `Holistic Health Hub <${fromAddress}>`;

const payload = {
  firstName: 'Avery',
  orderNumber: 'TEST-0001',
  pharmacyName: 'Eastwood Health',
  organisationId: '6d0176bb-89a0-4e32-9bce-c934c9557c42',
  amountPence: 12500,
  currency: 'GBP',
};

const rendered = renderEmailTemplate(templateCode as never, payload);
const header = resolveEmailHeader(payload as never);

const response = await fetch('https://api.resend.com/emails', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'HolisticHealthHub/1.0',
  },
  body: JSON.stringify({
    from,
    to: [to],
    subject: `[test] ${rendered.subject}`,
    html: rendered.html,
    text: rendered.text,
    attachments: emailInlineImages(header),
  }),
});

const body = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(`Resend returned ${response.status}:`, body);
  process.exit(1);
}
console.log(`sent   : ${templateCode}`);
console.log(`from   : ${from}`);
console.log(`to     : ${to}`);
console.log(`id     : ${(body as { id?: string }).id ?? '(none returned)'}`);
