import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { config } from '../../bootstrap/config.js';
import { emailInlineImages } from '../notifications/email-assets.js';
import { resolveEmailHeader } from '../notifications/email-layout.js';
import { isEmailTemplateCode } from '../notifications/message-kinds.js';
import {
  BRAND_HEADER_BACKGROUND_PAYLOAD_KEY,
  BRAND_LOGO_PAYLOAD_KEY,
  DEFAULT_FROM_NAME,
  emailUsesAdminHeader,
  formatFromHeader,
  fromAddressFor,
  replyToFor,
  senderFor,
  type EmailTemplateCode,
} from '../notifications/email-catalog.js';
import { FILLED_FORM_NAME_KEY, FILLED_FORM_PATH_KEY, LICENCE_NAME_KEY, LICENCE_PATH_KEY, LICENCE_TYPE_KEY, SIGNED_TERMS_NAME_KEY, SIGNED_TERMS_PATH_KEY } from '../pharmacy-onboarding/emails.js';
import { emailHeaderBackgroundForLogo } from '../notifications/email-logo-background.js';
import { renderEmailTemplate } from '../notifications/email-renderer.js';
import type { EmailCopyOverrides } from '../../domain/notifications/email-copy.js';
import { readOrganisationLogoBytes } from '../organisation/brand-logo.js';
import type { StorageProvider } from '../../providers/storage/storage.provider.js';
import type { NotificationOutboxRecord, NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';

export type MessageDeliveryDeps = {
  notificationRepo: NotificationRepositoryPort;
  /** Reads pharmacy logo uploads. Omitted in tests; every email then sends unbranded. */
  storage?: Pick<StorageProvider, 'listPaths' | 'downloadFile'>;
  fetchImpl?: typeof fetch;
  /** Wording admins have saved for the emails. Omitted in tests; every email is then the code's own. */
  emailCopy?: () => Promise<EmailCopyOverrides>;
};

/**
 * One read per pharmacy per sweep. A sweep can carry many messages for the same
 * pharmacy, and the logo cannot change midway through one.
 */
async function brandLogoLoader(deps: MessageDeliveryDeps) {
  const cache = new Map<string, string | null>();
  return async function load(organisationId: string): Promise<string | null> {
    if (!deps.storage || !organisationId) return null;
    const cached = cache.get(organisationId);
    if (cached !== undefined) return cached;
    let bytes: string | null = null;
    try {
      bytes = await readOrganisationLogoBytes(deps.storage, organisationId);
    } catch (error) {
      // A missing or unreadable logo must never hold up the message itself.
      console.warn('Pharmacy logo unavailable for email', organisationId, error instanceof Error ? error.message : 'unknown');
    }
    cache.set(organisationId, bytes);
    return bytes;
  };
}

const MAX_DELIVERY_ATTEMPTS = 3;

export function notificationRetryAt(now: Date, attemptCount: number) {
  const delayMinutes = 5 * (2 ** Math.max(0, attemptCount - 1));
  return new Date(now.getTime() + delayMinutes * 60 * 1_000);
}

type ProviderConfig =
  | { kind: 'resend'; apiKey: string; from: string }
  | { kind: 'webhook'; url: string; key: string };

const secretClient = new SecretManagerServiceClient();
let cachedResendApiKey: string | null = null;

async function readResendApiKey() {
  if (process.env.RESEND_API_KEY?.trim()) return process.env.RESEND_API_KEY.trim();
  if (cachedResendApiKey) return cachedResendApiKey;
  const resourceName = process.env.RESEND_API_KEY_SECRET_RESOURCE_NAME?.trim()
    || `projects/${config.FIREBASE_PROJECT_ID}/secrets/hhh-resend-api-key-europe-west2`;
  try {
    const [version] = await secretClient.accessSecretVersion({ name: `${resourceName}/versions/latest` });
    const value = version.payload?.data?.toString('utf8').trim();
    if (value) {
      cachedResendApiKey = value;
      return value;
    }
  } catch {
    return null;
  }
  return null;
}

async function providerConfig(): Promise<ProviderConfig | null> {
  const resendApiKey = process.env.RESEND_API_KEY?.trim();
  // Default From is the verified Resend domain on .live (SPF/DKIM/MX on
  // send.holistichealthhub.live). An older Cloud Run override kept
  // noreply@holistichealthhub.cc after that domain was dropped from Resend,
  // which made every outbox send fail with 403. Map the retired .cc address
  // onto .live so a stale env var cannot break delivery again.
  const configuredFrom = process.env.EMAIL_FROM_ADDRESS?.trim() || 'noreply@holistichealthhub.live';
  const resendFrom = /@holistichealthhub\.cc$/i.test(configuredFrom)
    ? configuredFrom.replace(/@holistichealthhub\.cc$/i, '@holistichealthhub.live')
    : configuredFrom;
  const resolvedResendApiKey = resendApiKey || await readResendApiKey();
  if (resolvedResendApiKey && resendFrom) {
    return { kind: 'resend' as const, apiKey: resolvedResendApiKey, from: resendFrom };
  }
  const url = process.env.PATIENT_MESSAGE_PROVIDER_URL?.trim();
  const key = process.env.PATIENT_MESSAGE_PROVIDER_KEY?.trim();
  const genericUrl = process.env.EMAIL_PROVIDER_URL?.trim();
  const genericKey = process.env.EMAIL_PROVIDER_KEY?.trim();
  if (genericUrl && genericKey) return { kind: 'webhook' as const, url: genericUrl, key: genericKey };
  return url && key ? { kind: 'webhook' as const, url, key } : null;
}

function payloadValue(payload: unknown, key: string) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  const found = (payload as Record<string, unknown>)[key];
  return found == null ? '' : String(found);
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  return payload as Record<string, unknown>;
}

const FILE_ATTACHMENT_TEMPLATES = new Set(['curaleaf_new_account_application', 'pharmacy_partner_terms_signed']);

/** A filename from the payload, kept to characters every mail client accepts. */
function attachmentName(given: string, fallback: string) {
  const clean = given.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '').trim().slice(0, 150);
  return clean && !clean.startsWith('.') ? clean : fallback;
}

async function fileAttachmentsFor(record: NotificationOutboxRecord, deps: MessageDeliveryDeps) {
  if (!FILE_ATTACHMENT_TEMPLATES.has(record.templateCode) || !deps.storage) return [];
  const formPath = payloadValue(record.payload, FILLED_FORM_PATH_KEY);
  const licencePath = payloadValue(record.payload, LICENCE_PATH_KEY);
  const signedTermsPath = payloadValue(record.payload, SIGNED_TERMS_PATH_KEY);
  const files = [
    signedTermsPath ? { path: signedTermsPath, filename: attachmentName(payloadValue(record.payload, SIGNED_TERMS_NAME_KEY), 'partner-terms-signed.pdf'), contentType: 'application/pdf' } : null,
    formPath ? { path: formPath, filename: attachmentName(payloadValue(record.payload, FILLED_FORM_NAME_KEY), 'curaleaf-account.pdf'), contentType: 'application/pdf' } : null,
    licencePath ? {
      path: licencePath,
      filename: payloadValue(record.payload, LICENCE_NAME_KEY) || 'controlled-drug-licence',
      contentType: payloadValue(record.payload, LICENCE_TYPE_KEY) || 'application/octet-stream',
    } : null,
  ].filter((file): file is { path: string; filename: string; contentType: string } => Boolean(file));
  const attachments = [];
  for (const file of files) {
    const downloaded = await deps.storage.downloadFile(file.path);
    attachments.push({
      filename: file.filename,
      content: downloaded.bytes.toString('base64'),
      content_type: downloaded.contentType || file.contentType,
    });
  }
  return attachments;
}

function headerFor(record: NotificationOutboxRecord, hasBrandLogo: boolean) {
  const admin = emailUsesAdminHeader(record.templateCode, record.payload);
  return resolveEmailHeader({
    audience: admin ? 'admin' : 'pharmacy',
    organisationId: payloadValue(record.payload, 'organisationId'),
    pharmacyName: payloadValue(record.payload, 'pharmacyName'),
    hasBrandLogo,
  });
}

async function deliverOne(
  record: NotificationOutboxRecord,
  deps: MessageDeliveryDeps,
  provider: ProviderConfig,
  loadBrandLogo: (organisationId: string) => Promise<string | null>,
  copy: EmailCopyOverrides = {},
) {
  if (record.status !== 'PENDING') return 'skipped' as const;
  if (!isEmailTemplateCode(record.templateCode)) return 'deferred' as const;
  const templateCode = record.templateCode;
  await deps.notificationRepo.markProcessing(record.id, record.attemptCount + 1);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const brandLogo = await loadBrandLogo(payloadValue(record.payload, 'organisationId'));
  const response = provider.kind === 'resend'
    ? await (async () => {
      const source = payloadRecord(record.payload);
      const visible = { ...source };
      delete visible.bcc;
      const payload = brandLogo
        ? {
          ...visible,
          [BRAND_LOGO_PAYLOAD_KEY]: 'true',
          [BRAND_HEADER_BACKGROUND_PAYLOAD_KEY]: emailHeaderBackgroundForLogo(Buffer.from(brandLogo, 'base64')),
        }
        : visible;
      const rendered = renderEmailTemplate(templateCode, payload, copy);
      const fileAttachments = await fileAttachmentsFor(record, deps);
      // Only templates whose copy invites a reply carry one, so a patient never
      // writes into the unmonitored From address. The partner onboarding emails take
      // their sender name and Reply-To from admin content (validated in senderFor);
      // the From address is always the template's verified alias.
      const sender = senderFor(templateCode, payload);
      const from = formatFromHeader(sender.fromName, fromAddressFor(templateCode));
      const replyTo = sender.replyTo;
      return fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'HolisticHealthHub/1.0',
          'Idempotency-Key': record.id,
        },
        body: JSON.stringify({
          from,
          ...(replyTo ? { reply_to: replyTo } : {}),
          // A shared email names every recipient on one message; otherwise it is one person.
          to: record.toRecipients?.length ? record.toRecipients : [record.encryptedRecipient],
          ...(record.ccRecipients?.length ? { cc: record.ccRecipients } : {}),
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          attachments: [
            ...emailInlineImages(headerFor(record, Boolean(brandLogo)), brandLogo),
            ...fileAttachments,
          ],
          tags: [
            { name: 'template', value: record.templateCode },
            { name: 'channel', value: record.channel.toLowerCase() },
          ],
        }),
      });
    })()
    : await fetchImpl(provider.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.key}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': record.id,
      },
      body: JSON.stringify({
        id: record.id,
        kind: record.templateCode,
        channel: record.channel.toLowerCase(),
        recipient: record.encryptedRecipient,
        templateData: record.payload,
      }),
    });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Message provider returned ${response.status}${detail ? `: ${detail.slice(0, 160)}` : '.'}`);
  }
  const providerResponse = await response.json().catch(() => ({}));
  await deps.notificationRepo.markSent(record.id, providerResponse);
  return 'sent' as const;
}

export async function deliverPatientMessages(deps: MessageDeliveryDeps, limit = 100) {
  const provider = await providerConfig();
  const pending = await deps.notificationRepo.listPending(limit);
  const summary = { checked: pending.length, sent: 0, deferred: 0, failed: 0 };
  if (!provider) {
    summary.deferred = pending.length;
    return summary;
  }
  const loadBrandLogo = await brandLogoLoader(deps);
  // One read per sweep. Unreadable wording falls back to the code's own, never holds mail.
  const copy = pending.length && deps.emailCopy
    ? await deps.emailCopy().catch(error => {
      console.warn('Email wording unavailable; sending the default wording', error instanceof Error ? error.message : 'unknown');
      return {} as EmailCopyOverrides;
    })
    : {};
  for (const record of pending) {
    try {
      const result = await deliverOne(record, deps, provider, loadBrandLogo, copy);
      if (result === 'sent') summary.sent += 1;
      else summary.deferred += 1;
    } catch (error) {
      summary.failed += 1;
      const reason = error instanceof Error ? error.message : 'Unknown message delivery error';
      console.warn('Message delivery failed', { template: record.templateCode, reason: reason.slice(0, 180) });
      const attemptCount = record.attemptCount + 1;
      if (attemptCount < MAX_DELIVERY_ATTEMPTS && deps.notificationRepo.markRetry) {
        await deps.notificationRepo.markRetry(
          record.id,
          attemptCount,
          notificationRetryAt(new Date(), attemptCount).toISOString(),
          reason,
        ).catch(() => undefined);
      } else {
        await deps.notificationRepo.markFailed(record.id, reason).catch(() => undefined);
      }
    }
  }
  return summary;
}

export type ImmediateEmail = {
  templateCode: EmailTemplateCode;
  to: string[];
  /** Copied in, on the same message. */
  cc?: string[];
  payload: Record<string, unknown>;
  attachments: Array<{ filename: string; content: Buffer; contentType: string }>;
  /** Resend keeps this for 24 hours, so a retried submit cannot send twice. */
  idempotencyKey: string;
};

/**
 * Sends one admin email straight away instead of through the outbox, for content
 * that must never be written to the database (the Worldpay form's bank and
 * identity details). Only Resend is allowed: the generic webhook provider would
 * hand the data to another service.
 */
export async function sendEmailNow(email: ImmediateEmail, fetchImpl: typeof fetch = fetch) {
  const provider = await providerConfig();
  if (!provider || provider.kind !== 'resend') {
    throw new Error('Email sending is not set up for this environment.');
  }
  const rendered = renderEmailTemplate(email.templateCode, email.payload);
  const header = resolveEmailHeader({ audience: 'admin', organisationId: '', pharmacyName: '', hasBrandLogo: false });
  const response = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'HolisticHealthHub/1.0',
      'Idempotency-Key': email.idempotencyKey,
    },
    body: JSON.stringify({
      from: formatFromHeader(DEFAULT_FROM_NAME, fromAddressFor(email.templateCode)),
      ...(replyToFor(email.templateCode) ? { reply_to: replyToFor(email.templateCode) } : {}),
      to: email.to,
      ...(email.cc?.length ? { cc: email.cc } : {}),
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      attachments: [
        ...emailInlineImages(header, null),
        ...email.attachments.map(file => ({
          filename: file.filename,
          content: file.content.toString('base64'),
          content_type: file.contentType,
        })),
      ],
      tags: [{ name: 'template', value: email.templateCode }, { name: 'channel', value: 'email' }],
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Message provider returned ${response.status}${detail ? `: ${detail.slice(0, 160)}` : '.'}`);
  }
}
