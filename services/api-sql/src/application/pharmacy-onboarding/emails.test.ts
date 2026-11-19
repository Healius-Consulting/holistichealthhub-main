import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILLED_FORM_PATH_KEY, queuePharmacyApplicationEmails } from './emails.js';
import { fromAddressFor, renderEmailTemplate, replyToFor, type EmailTemplateCode } from '../notifications/email-catalog.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';

type Enqueued = {
  templateCode: EmailTemplateCode;
  encryptedRecipient: string;
  toRecipients?: string[] | null;
  ccRecipients?: string[] | null;
  payload: Record<string, unknown>;
  idempotencyKey: string;
};

function capture() {
  const sent: Enqueued[] = [];
  const repo = {
    async enqueue(data: Enqueued) {
      if (sent.some(row => row.idempotencyKey === data.idempotencyKey)) return { created: false };
      sent.push(data);
      return { created: true };
    },
  } as unknown as NotificationRepositoryPort;
  return { sent, repo };
}

const request = {
  id: '6c1c5a0e-1a1f-4f43-9d1b-6f7a6f3f0a11',
  status: 'PENDING',
  pharmacistName: 'Asha Shah',
  pharmacyName: 'Shah Pharmacy',
  gphcNumber: '1234567',
  pharmacyEmail: 'shop@shah.test',
  filledFormStoragePath: 'pharmacy-onboarding/6c1c/curaleaf-account.pdf',
  licenceStoragePath: '',
  licenceContentType: '',
  licenceFilename: '',
  // 14:05 in London on 19 November (GMT).
  createdAt: '2026-11-19T14:05:00.000Z',
} as unknown as PharmacyOnboardingRequestRecord;

const ACCEPTED_AT = '2026-11-19T14:20:00.000Z';

test('the Curaleaf application is one email: To Curaleaf, CC partner success, the filled form attached', async () => {
  const { sent, repo } = capture();
  await queuePharmacyApplicationEmails(repo, request, ACCEPTED_AT);
  const applications = sent.filter(row => row.templateCode === 'curaleaf_new_account_application');
  assert.equal(applications.length, 1);
  const email = applications[0]!;
  assert.deepEqual(email.toRecipients, ['robbie.allison@curaleaflaboratories.co.uk', 'ellis.walters@curaleaflaboratories.co.uk']);
  assert.equal(email.encryptedRecipient, 'robbie.allison@curaleaflaboratories.co.uk');
  assert.deepEqual(email.ccRecipients, ['spatel@healiusconsulting.com']);
  assert.equal(email.payload[FILLED_FORM_PATH_KEY], request.filledFormStoragePath);
  // No separate admin email any more.
  assert.equal(sent.some(row => row.encryptedRecipient.startsWith('admin@')), false);
});

test('a retried acceptance never sends the Curaleaf application or the pharmacy receipt twice', async () => {
  const { sent, repo } = capture();
  await queuePharmacyApplicationEmails(repo, request, ACCEPTED_AT);
  await queuePharmacyApplicationEmails(repo, request, '2026-11-20T09:00:00.000Z');
  assert.deepEqual(sent.map(row => row.templateCode).sort(), ['curaleaf_new_account_application', 'pharmacy_onboarding_submitted']);
});

test('the Curaleaf recipients come from config', async t => {
  process.env.CURALEAF_APPLICATION_TO = ' New@Curaleaf.test , second@curaleaf.test';
  process.env.CURALEAF_APPLICATION_CC = 'copy@hhh.test';
  t.after(() => {
    delete process.env.CURALEAF_APPLICATION_TO;
    delete process.env.CURALEAF_APPLICATION_CC;
  });
  const { sent, repo } = capture();
  await queuePharmacyApplicationEmails(repo, request, ACCEPTED_AT);
  const email = sent.find(row => row.templateCode === 'curaleaf_new_account_application')!;
  assert.deepEqual(email.toRecipients, ['new@curaleaf.test', 'second@curaleaf.test']);
  assert.deepEqual(email.ccRecipients, ['copy@hhh.test']);
});

test('the Curaleaf application uses the client wording with the branch, GPhC and UK submission time', async () => {
  const { sent, repo } = capture();
  await queuePharmacyApplicationEmails(repo, request, ACCEPTED_AT);
  const email = sent.find(row => row.templateCode === 'curaleaf_new_account_application')!;
  assert.equal(fromAddressFor('curaleaf_new_account_application'), 'onboarding@holistichealthhub.live');
  assert.equal(replyToFor('curaleaf_new_account_application'), 'onboarding@holistichealthhub.live');
  const rendered = renderEmailTemplate('curaleaf_new_account_application', email.payload);
  assert.equal(rendered.subject, 'New account application: Shah Pharmacy, GPhC 1234567');
  assert.equal(rendered.text, [
    'Hello,',
    'Please find attached a new account application from Shah Pharmacy, submitted through the Holistic Health Hub partner platform on 19 November 2026 at 14:05.',
    'Shah Pharmacy has applied under our interim arrangement, which covers pharmacies that are new to Curaleaf. If the pharmacy already holds a Curaleaf account, please tell us by replying to this email rather than opening a second account. We will then let the pharmacy know.',
    'Once the account is open',
    'Please provide us with the PHAR code, API key and referral-portal login.',
    'Send any questions about this application to us by replying to this email.',
    'Kind regards,\nPartner Onboarding, Holistic Health Hub',
  ].join('\n\n'));
  assert.match(rendered.html, /on 19 November 2026 at 14:05/);
  assert.match(rendered.html, /<strong>Once the account is open<\/strong>/);
  assert.equal((rendered.text.match(/Kind regards/g) ?? []).length, 1);
});

test('the submission time is shown in UK summer time when it applies', () => {
  const rendered = renderEmailTemplate('curaleaf_new_account_application', {
    branchName: 'Shah Pharmacy', gphcNumber: '1234567', submittedAt: '2026-06-01T13:05:00.000Z',
  });
  assert.match(rendered.text, /on 1 June 2026 at 14:05\./);
});

test('the pharmacy is told its request was received, once, from the onboarding mailbox', async () => {
  const { sent, repo } = capture();
  await queuePharmacyApplicationEmails(repo, request, ACCEPTED_AT);
  await queuePharmacyApplicationEmails(repo, request, ACCEPTED_AT);
  const toPharmacy = sent.filter(row => row.templateCode === 'pharmacy_onboarding_submitted');
  assert.deepEqual(toPharmacy.map(row => row.encryptedRecipient), ['shop@shah.test']);
  const rendered = renderEmailTemplate('pharmacy_onboarding_submitted', toPharmacy[0]!.payload);
  assert.equal(rendered.subject, "We've received your request");
  assert.equal(rendered.text, "Thank you, we've received your request to join Holistic Health Hub. We'll review it and let you know our decision.\n\nPlease check back in a few days, or contact onboarding@holistichealthhub.live for more details.");
});

test('the submitted, on-hold, activated and Curaleaf emails come from and reply to onboarding@', () => {
  for (const code of ['pharmacy_onboarding_submitted', 'pharmacy_onboarding_held', 'pharmacy_onboarding_activated', 'curaleaf_new_account_application'] as const) {
    assert.equal(fromAddressFor(code), 'onboarding@holistichealthhub.live');
    assert.equal(replyToFor(code), 'onboarding@holistichealthhub.live');
  }
  assert.equal(fromAddressFor('admin_worldpay_form_submitted'), 'onboarding@holistichealthhub.live');
  const held = renderEmailTemplate('pharmacy_onboarding_held', { pharmacyName: 'Shah Pharmacy' });
  assert.equal(held.subject, 'Update on your Holistic Health Hub request');
  assert.equal(held.text, 'Your account could not be created at this point in time. Please email onboarding@holistichealthhub.live for more details.');
  const activated = renderEmailTemplate('pharmacy_onboarding_activated', { pharmacyName: 'Shah Pharmacy' });
  assert.equal(activated.subject, 'Your Holistic Health Hub account is active');
  assert.equal(activated.text, "Your account has been activated. You can sign in through PharmSmart, or contact us at onboarding@holistichealthhub.live and we'll send an invite to your account.");
});

test('the on-hold email ignores any reason passed to it', () => {
  const rendered = renderEmailTemplate('pharmacy_onboarding_held', { pharmacyName: 'Shah Pharmacy', declineReason: 'Secret admin note' });
  assert.equal(`${rendered.subject}${rendered.text}${rendered.html}`.includes('Secret admin note'), false);
});

test('a demo pharmacy\'s Curaleaf application goes to HHH only, marked as a demo', async () => {
  const { sent, repo } = capture();
  await queuePharmacyApplicationEmails(repo, request, '2026-11-19T14:05:00.000Z', { demo: true });
  const curaleaf = sent.find(row => row.templateCode === 'curaleaf_new_account_application')!;
  const recipients = [...(curaleaf.toRecipients ?? []), ...(curaleaf.ccRecipients ?? [])];
  assert.ok(recipients.length > 0);
  assert.ok(recipients.every(address => !address.endsWith('@curaleaflaboratories.co.uk')), 'never to Curaleaf');
  assert.match(renderEmailTemplate('curaleaf_new_account_application', curaleaf.payload).subject, /^DEMO, not sent to Curaleaf: /);
});

