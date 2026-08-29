import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { config } from '../../bootstrap/config.js';
import { emailInlineImages } from '../notifications/email-assets.js';
import { resolveEmailHeader } from '../notifications/email-layout.js';
import { isEmailTemplateCode } from '../notifications/message-kinds.js';
import { renderEmailTemplate } from '../notifications/email-renderer.js';
import type { NotificationOutboxRecord, NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';

export type MessageDeliveryDeps = {
  notificationRepo: NotificationRepositoryPort;
  fetchImpl?: typeof fetch;
};

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

function headerFor(record: NotificationOutboxRecord) {
  const admin = record.templateCode === 'admin_new_enquiry_received'
    || payloadValue(record.payload, 'pharmacyName') === 'HHH admin workspace';
  return resolveEmailHeader({
    audience: admin ? 'admin' : 'pharmacy',
    organisationId: payloadValue(record.payload, 'organisationId'),
    pharmacyName: payloadValue(record.payload, 'pharmacyName'),
  });
}

async function deliverOne(
  record: NotificationOutboxRecord,
  deps: MessageDeliveryDeps,
  provider: ProviderConfig,
) {
  if (record.status !== 'PENDING') return 'skipped' as const;
  if (!isEmailTemplateCode(record.templateCode)) return 'deferred' as const;
  await deps.notificationRepo.markProcessing(record.id, record.attemptCount + 1);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const response = provider.kind === 'resend'
    ? await (() => {
      const rendered = renderEmailTemplate(record.templateCode, record.payload);
      const from = provider.from.includes('<') ? provider.from : `Holistic Health Hub <${provider.from}>`;
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
          to: [record.encryptedRecipient],
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
          attachments: emailInlineImages(headerFor(record)),
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
  for (const record of pending) {
    try {
      const result = await deliverOne(record, deps, provider);
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
