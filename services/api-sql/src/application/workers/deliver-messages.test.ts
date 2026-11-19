import assert from 'node:assert/strict';
import test from 'node:test';
import { deliverPatientMessages, notificationRetryAt } from './deliver-messages.js';
import type { NotificationOutboxRecord, NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';

test('notification retries keep the same message on a bounded exponential schedule', () => {
  const now = new Date('2026-08-29T10:00:00.000Z');
  assert.equal(notificationRetryAt(now, 1).toISOString(), '2026-08-29T10:05:00.000Z');
  assert.equal(notificationRetryAt(now, 2).toISOString(), '2026-08-29T10:10:00.000Z');
});

const ORGANISATION_ID = '6d0176bb-89a0-4e32-9bce-c934c9557c42';

function pendingRecord(overrides: Partial<NotificationOutboxRecord> = {}): NotificationOutboxRecord {
  return {
    id: 'outbox-1',
    organisationId: ORGANISATION_ID,
    patientId: null,
    orderId: null,
    channel: 'EMAIL',
    templateCode: 'patient_referred',
    recipientHash: 'hash',
    encryptedRecipient: 'patient@example.test',
    payload: { firstName: 'Avery', pharmacyName: 'Eastwood Health', organisationId: ORGANISATION_ID },
    idempotencyKey: 'key-1',
    status: 'PENDING',
    attemptCount: 0,
    createdAt: '2026-09-08T09:00:00.000Z',
    ...overrides,
  };
}

function notificationRepoStub(records: NotificationOutboxRecord[]) {
  const sent: string[] = [];
  const repo: NotificationRepositoryPort = {
    findByIdempotencyKey: async () => null,
    enqueue: async () => ({ created: false }),
    listPending: async () => records,
    markProcessing: async () => {},
    markSent: async id => { sent.push(id); },
    markFailed: async () => {},
  };
  return { repo, sent };
}

function storageStub(paths: string[], bytes = Buffer.from('logo-bytes')) {
  const downloaded: string[] = [];
  return {
    downloaded,
    storage: {
      listPaths: async () => paths.map(storagePath => ({ storagePath, updatedAt: '2026-09-01T00:00:00.000Z' })),
      downloadFile: async (storagePath: string) => {
        downloaded.push(storagePath);
        return { bytes, contentType: 'image/png' };
      },
    },
  };
}

function resendCapture() {
  const bodies: Array<Record<string, any>> = [];
  const fetchImpl = (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ id: 'resend-1' }), text: async () => '' };
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

test('inlines the pharmacy uploaded logo rather than any bundled image', async t => {
  process.env.RESEND_API_KEY = 'test-key';
  t.after(() => { delete process.env.RESEND_API_KEY; });

  const { repo, sent } = notificationRepoStub([pendingRecord()]);
  const { storage, downloaded } = storageStub([`pharmacy-branding/${ORGANISATION_ID}/email-logo-abc.png`]);
  const { bodies, fetchImpl } = resendCapture();

  const summary = await deliverPatientMessages({ notificationRepo: repo, storage, fetchImpl });

  assert.equal(summary.sent, 1);
  assert.deepEqual(sent, ['outbox-1']);
  assert.deepEqual(downloaded, [`pharmacy-branding/${ORGANISATION_ID}/email-logo-abc.png`]);

  const body = bodies[0]!;
  const headerImage = body.attachments.find((image: any) => image.content_id === 'email-header-logo');
  assert.ok(headerImage, 'the uploaded logo was not attached');
  assert.equal(headerImage.content, Buffer.from('logo-bytes').toString('base64'));
  assert.match(body.html, /cid:email-header-logo/);
  assert.equal(body.reply_to, 'referrals@holistichealthhub.live');
  assert.equal(body.from, 'Holistic Health Hub <referrals@holistichealthhub.live>');
  assert.equal(body.bcc, undefined);
});

test('sends without a header logo when the pharmacy has not uploaded one', async t => {
  process.env.RESEND_API_KEY = 'test-key';
  t.after(() => { delete process.env.RESEND_API_KEY; });

  const { repo } = notificationRepoStub([pendingRecord()]);
  const { storage } = storageStub([]);
  const { bodies, fetchImpl } = resendCapture();

  const summary = await deliverPatientMessages({ notificationRepo: repo, storage, fetchImpl });

  assert.equal(summary.sent, 1);
  const body = bodies[0]!;
  assert.equal(body.attachments.some((image: any) => image.content_id === 'email-header-logo'), false);
  assert.doesNotMatch(body.html, /cid:email-header-logo/);
  // The pharmacy is still named, so the message is never anonymous.
  assert.match(body.html, /Eastwood Health/);
});

test('the Curaleaf application goes as one email to every To and CC address, with the form attached', async t => {
  process.env.RESEND_API_KEY = 'test-key';
  t.after(() => { delete process.env.RESEND_API_KEY; });

  const { repo } = notificationRepoStub([pendingRecord({
    organisationId: null,
    templateCode: 'curaleaf_new_account_application',
    encryptedRecipient: 'robbie.allison@curaleaflaboratories.co.uk',
    toRecipients: ['robbie.allison@curaleaflaboratories.co.uk', 'ellis.walters@curaleaflaboratories.co.uk'],
    ccRecipients: ['spatel@healiusconsulting.com'],
    payload: {
      subject: 'New account application: Eastwood Health, GPhC 2078912',
      paragraphs: ['Hello,', 'Please find attached a new account application from Eastwood Health.'],
      branchName: 'Eastwood Health',
      gphcNumber: '2078912',
      submittedAt: '2026-11-19T14:05:00.000Z',
      filledFormStoragePath: 'pharmacy-onboarding/req/curaleaf-account.pdf',
      licenceStoragePath: 'pharmacy-onboarding/req/controlled-drug-licence.pdf',
      licenceContentType: 'application/pdf',
      licenceFilename: 'cd-licence.pdf',
    },
  })]);
  const { storage } = storageStub([]);
  const { bodies, fetchImpl } = resendCapture();

  const summary = await deliverPatientMessages({ notificationRepo: repo, storage, fetchImpl });

  assert.equal(summary.sent, 1);
  assert.equal(bodies.length, 1);
  const body = bodies[0]!;
  assert.deepEqual(body.to, ['robbie.allison@curaleaflaboratories.co.uk', 'ellis.walters@curaleaflaboratories.co.uk']);
  assert.deepEqual(body.cc, ['spatel@healiusconsulting.com']);
  assert.equal(body.from, 'Holistic Health Hub <onboarding@holistichealthhub.live>');
  assert.equal(body.reply_to, 'onboarding@holistichealthhub.live');
  assert.equal(body.subject, 'New account application: Eastwood Health, GPhC 2078912');
  const files = body.attachments.filter((file: { content_id?: string }) => !file.content_id);
  assert.deepEqual(files.map((file: { filename: string }) => file.filename), ['curaleaf-account.pdf', 'cd-licence.pdf']);
  assert.equal(files[0].content, Buffer.from('logo-bytes').toString('base64'));
});

test('a single-recipient email has no CC', async t => {
  process.env.RESEND_API_KEY = 'test-key';
  t.after(() => { delete process.env.RESEND_API_KEY; });
  const { repo } = notificationRepoStub([pendingRecord()]);
  const { bodies, fetchImpl } = resendCapture();
  await deliverPatientMessages({ notificationRepo: repo, fetchImpl });
  assert.deepEqual(bodies[0]!.to, ['patient@example.test']);
  assert.equal('cc' in bodies[0]!, false);
});

test('a logo that cannot be read does not stop the message', async t => {
  process.env.RESEND_API_KEY = 'test-key';
  t.after(() => { delete process.env.RESEND_API_KEY; });

  const { repo } = notificationRepoStub([pendingRecord()]);
  const { bodies, fetchImpl } = resendCapture();
  const storage = {
    listPaths: async () => { throw new Error('storage unavailable'); },
    downloadFile: async () => ({ bytes: Buffer.alloc(0), contentType: null }),
  };

  const summary = await deliverPatientMessages({ notificationRepo: repo, storage, fetchImpl });

  assert.equal(summary.sent, 1);
  assert.doesNotMatch(bodies[0]!.html, /cid:email-header-logo/);
});

test('onboarding emails take their sender name and Reply-To from the payload; the From address never changes', async t => {
  process.env.RESEND_API_KEY = 'test-key';
  t.after(() => { delete process.env.RESEND_API_KEY; });

  const { repo } = notificationRepoStub([
    pendingRecord({
      id: 'outbox-curaleaf',
      organisationId: null,
      templateCode: 'curaleaf_new_account_application',
      encryptedRecipient: 'new@curaleaf.test',
      toRecipients: ['new@curaleaf.test'],
      payload: {
        subject: 'New account application: Eastwood Health, GPhC 2078912',
        paragraphs: ['Hello,', 'Please find attached a new account application.'],
        fromName: 'Holistic Health Hub — Partner Onboarding',
        replyTo: 'spatel@healiusconsulting.com',
        filledFormStoragePath: 'pharmacy-onboarding/req/curaleaf-account.pdf',
        filledFormFilename: 'Curaleaf-new-account_2078912_Eastwood Health_2026-11-19.pdf',
      },
    }),
    pendingRecord({
      id: 'outbox-sent',
      organisationId: null,
      templateCode: 'pharmacy_onboarding_submitted',
      encryptedRecipient: 'shop@eastwood.test',
      payload: {
        subject: 'We have your application',
        paragraphs: ['Hello Priya,', 'Thank you.'],
        fromName: 'Evil" <x@evil.test>\r\nBcc: y@evil.test',
        replyTo: 'not an address',
      },
    }),
    pendingRecord({ id: 'outbox-patient', payload: { firstName: 'Avery', replyTo: 'attacker@evil.test', fromName: 'Someone else' } }),
  ]);
  const { storage } = storageStub([]);
  const { bodies, fetchImpl } = resendCapture();

  const summary = await deliverPatientMessages({ notificationRepo: repo, storage, fetchImpl });
  assert.equal(summary.sent, 3);

  const [curaleaf, sent, patient] = bodies;
  assert.equal(curaleaf!.from, 'Holistic Health Hub — Partner Onboarding <onboarding@holistichealthhub.live>');
  assert.equal(curaleaf!.reply_to, 'spatel@healiusconsulting.com');
  assert.equal(curaleaf!.subject, 'New account application: Eastwood Health, GPhC 2078912');
  const files = (curaleaf!.attachments as Array<{ filename: string }>).filter(file => !file.filename.endsWith('.png'));
  assert.deepEqual(files.map(file => file.filename), ['Curaleaf-new-account_2078912_Eastwood Health_2026-11-19.pdf']);

  // An unsafe name is cleaned and an invalid Reply-To falls back to the template's own.
  assert.equal(sent!.from, '"Evil x@evil.testBcc: y@evil.test" <onboarding@holistichealthhub.live>');
  assert.equal(sent!.reply_to, 'onboarding@holistichealthhub.live');

  // Other templates ignore the payload entirely.
  assert.equal(patient!.from, 'Holistic Health Hub <referrals@holistichealthhub.live>');
  assert.equal(patient!.reply_to, 'referrals@holistichealthhub.live');
});
