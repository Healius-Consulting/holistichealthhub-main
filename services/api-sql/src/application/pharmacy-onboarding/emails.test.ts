import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILLED_FORM_PATH_KEY, queuePharmacyOnboardingSubmitted } from './emails.js';
import { fromAddressFor, renderEmailTemplate, replyToFor, type EmailTemplateCode } from '../notifications/email-catalog.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';

type Enqueued = { templateCode: EmailTemplateCode; encryptedRecipient: string; payload: Record<string, unknown>; idempotencyKey: string };

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
} as unknown as PharmacyOnboardingRequestRecord;

test('the filled Curaleaf form goes to partner success and the HHH admin inbox, not to Curaleaf', async () => {
  const { sent, repo } = capture();
  await queuePharmacyOnboardingSubmitted(repo, request);
  const notices = sent.filter(row => row.templateCode === 'admin_pharmacy_onboarding_request');
  assert.deepEqual(notices.map(row => row.encryptedRecipient).sort(), [
    'admin@holistichealthhub.live',
    'spatel@healiusconsulting.com',
  ]);
  for (const notice of notices) {
    assert.equal(notice.payload[FILLED_FORM_PATH_KEY], request.filledFormStoragePath);
  }
  assert.equal(sent.some(row => /curaleaf/i.test(row.encryptedRecipient)), false);
});

test('the pharmacy is told its request was received, once, from the onboarding mailbox', async () => {
  const { sent, repo } = capture();
  await queuePharmacyOnboardingSubmitted(repo, request);
  await queuePharmacyOnboardingSubmitted(repo, request);
  const toPharmacy = sent.filter(row => row.templateCode === 'pharmacy_onboarding_submitted');
  assert.deepEqual(toPharmacy.map(row => row.encryptedRecipient), ['shop@shah.test']);
  const rendered = renderEmailTemplate('pharmacy_onboarding_submitted', toPharmacy[0]!.payload);
  assert.equal(rendered.subject, "We've received your request");
  assert.equal(rendered.text, "Thank you, we've received your request to join Holistic Health Hub. We'll review it and let you know our decision.\n\nPlease check back in a few days, or contact onboarding@holistichealthhub.live for more details.");
});

test('the submitted, on-hold and activated emails come from and reply to onboarding@', () => {
  for (const code of ['pharmacy_onboarding_submitted', 'pharmacy_onboarding_held', 'pharmacy_onboarding_activated'] as const) {
    assert.equal(fromAddressFor(code), 'onboarding@holistichealthhub.live');
    assert.equal(replyToFor(code), 'onboarding@holistichealthhub.live');
  }
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
