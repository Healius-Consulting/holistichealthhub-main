import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILLED_FORM_PATH_KEY, queuePharmacyOnboardingSubmitted } from './emails.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';

type Enqueued = { templateCode: string; encryptedRecipient: string; payload: Record<string, unknown> };

function capture() {
  const sent: Enqueued[] = [];
  const repo = {
    async enqueue(data: Enqueued) {
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
