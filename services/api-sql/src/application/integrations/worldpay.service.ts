import { randomUUID } from 'node:crypto';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { config } from '../../bootstrap/config.js';
import { HttpError } from '../../domain/common/errors.js';
import type { IntegrationConnectionRecord } from '../../repositories/ports/integration.port.js';
import {
  normaliseWorldpayPaymentQuery,
  worldpayRefundAction,
  type WorldpayPaymentQuery,
} from '../payments/worldpay-query.js';

const secretClient = new SecretManagerServiceClient();
const REQUEST_TIMEOUT_MS = 10_000;
const SECRET_REGION = 'europe-west2';
const HPP_MEDIA_TYPE = 'application/vnd.worldpay.payment_pages-v1.hal+json';
const PAYMENT_QUERIES_MEDIA_TYPE = 'application/vnd.worldpay.payment-queries-v1.hal+json';
const CARD_PAYMENTS_MEDIA_TYPES = [
  'application/vnd.worldpay.payments-v7+json',
  'application/vnd.worldpay.payments-v6+json',
  'application/vnd.worldpay.payments-v5+json',
] as const;
const PAYMENTS_API_VERSION = '2024-06-01';
export const WORLDPAY_TRY_BASE_URL = 'https://try.access.worldpay.com';
export const WORLDPAY_LIVE_BASE_URL = 'https://access.worldpay.com';
export const WORLDPAY_DEFAULT_LINK_EXPIRY_SECONDS = 72 * 60 * 60;

export type WorldpayCredential = {
  username: string;
  password: string;
  entityId: string;
};

export type WorldpaySessionResult = {
  url: string;
  transactionReference: string;
  providerPaymentId?: string;
  expiresAt: string;
  raw?: unknown;
};

export type WorldpayRefundSubmission = {
  accepted: true;
  commandId: string | null;
  paymentId: string | null;
  reference: string;
  providerStatus: string | null;
  raw: Record<string, unknown>;
};

export type WorldpayConnectionValidation = {
  passed: true;
  checkedAt: string;
  environment: 'try' | 'live';
  entityId: string;
};

export function maskWorldpayIdentifier(value: string) {
  const tail = value.slice(-4);
  return `${'•'.repeat(Math.min(8, Math.max(4, value.length - tail.length)))}${tail}`;
}

export function worldpaySecretPayload(credential: WorldpayCredential): Record<string, string> {
  const payload: Record<string, string> = {
    username: credential.username,
    password: credential.password,
    entityId: credential.entityId,
  };
  return payload;
}

function compactId(uuid: string): string {
  return uuid.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function allowedSecretResource(name: string) {
  return name.startsWith(`projects/${config.FIREBASE_PROJECT_ID}/secrets/hhh-worldpay-`)
    && name.endsWith('-europe-west2');
}

function worldpayAuthorization(credential: WorldpayCredential) {
  return `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`;
}

function configuredWorldpayBaseUrl() {
  return config.WORLDPAY_PAYMENT_QUERIES_BASE_URL || config.WORLDPAY_HPP_BASE_URL || null;
}

export function worldpayBaseUrl(environment?: 'TEST' | 'PRODUCTION' | 'try' | 'live' | null) {
  const override = configuredWorldpayBaseUrl();
  if (override) return override;
  if (environment === 'PRODUCTION' || environment === 'live') return WORLDPAY_LIVE_BASE_URL;
  return WORLDPAY_TRY_BASE_URL;
}

export async function readStoredWorldpayCredential(
  connection: IntegrationConnectionRecord | null,
  organisationId: string,
): Promise<WorldpayCredential | null> {
  const constructed = [
    `projects/${config.FIREBASE_PROJECT_ID}/secrets/hhh-worldpay-${organisationId}-europe-west2`,
    `projects/${config.FIREBASE_PROJECT_ID}/secrets/hhh-worldpay-${compactId(organisationId)}-europe-west2`,
  ].filter(allowedSecretResource);
  const candidateNames = [
    connection?.secretResourceName,
    ...constructed,
  ].filter((name): name is string => Boolean(name));

  for (const resourceName of candidateNames) {
    try {
      const [version] = await secretClient.accessSecretVersion({ name: `${resourceName}/versions/latest` });
      const raw = version.payload?.data?.toString('utf8');
      if (!raw) continue;
      const parsed = JSON.parse(raw) as Partial<WorldpayCredential>;
      if (parsed.username && parsed.password && parsed.entityId) {
        return {
          username: parsed.username,
          password: parsed.password,
          entityId: parsed.entityId,
        };
      }
    } catch {
      // Continue to next candidate
    }
  }
  return null;
}

function defaultWorldpaySecretResource(organisationId: string) {
  return `projects/${config.FIREBASE_PROJECT_ID}/secrets/hhh-worldpay-${organisationId}-${SECRET_REGION}`;
}

function secretIdFromResource(resourceName: string) {
  return resourceName.split('/secrets/')[1] ?? '';
}

function worldpayEnvironment(url: string): 'try' | 'live' {
  try {
    return new URL(url).hostname.startsWith('try.') ? 'try' : 'live';
  } catch {
    return 'try';
  }
}

export async function validateWorldpayCredentials(credential: WorldpayCredential): Promise<WorldpayConnectionValidation> {
  const override = configuredWorldpayBaseUrl();
  const candidates = override ? [override] : [WORLDPAY_TRY_BASE_URL, WORLDPAY_LIVE_BASE_URL];
  let lastStatus = 0;
  for (const [index, baseUrl] of candidates.entries()) {
    const url = new URL('/paymentQueries/payments', baseUrl);
    url.searchParams.set('transactionReference', `HHH-CONNECTION-CHECK-${randomUUID()}`);
    const response = await worldpayFetch(url, {}, credential);
    lastStatus = response.status;
    if (response.status === 401 || response.status === 403) {
      if (index < candidates.length - 1) continue;
      throw new HttpError(401, 'Worldpay rejected these API credentials.', 'WORLDPAY_CREDENTIALS_REJECTED');
    }
    if (!response.ok) {
      throw new HttpError(502, `Worldpay could not validate the connection (${response.status}).`, 'WORLDPAY_VALIDATION_FAILED');
    }
    try {
      await response.json();
    } catch {
      throw new HttpError(502, 'Worldpay returned an invalid Payment Queries response.', 'WORLDPAY_VALIDATION_FAILED');
    }
    return {
      passed: true,
      checkedAt: new Date().toISOString(),
      environment: worldpayEnvironment(baseUrl),
      entityId: credential.entityId,
    };
  }
  throw new HttpError(502, `Worldpay could not validate the connection (${lastStatus}).`, 'WORLDPAY_VALIDATION_FAILED');
}

export type WorldpayStatusPayload = {
  configured: boolean;
  connected: boolean;
  status: 'verification_required' | 'connected' | 'attention';
  environment: 'try' | 'live';
  /** When Worldpay last answered a real call. Null means never confirmed. */
  checkedAt: string | null;
  message?: string;
  maskedIdentifier?: string;
  updatedAt?: string;
};

/**
 * Settings and Overview share this payload. `connected` is only true when the
 * vendor has answered — an ACTIVE row with a stored secret is not a check.
 */
export function worldpayStatusPayload(
  connection: IntegrationConnectionRecord | null,
  extras?: { checkedAt?: string | null; message?: string },
): WorldpayStatusPayload {
  const disconnected = !connection || connection.status === 'DISCONNECTED';
  const configured = !disconnected && Boolean(connection?.secretResourceName);
  const checkedAt = disconnected ? null : (extras?.checkedAt ?? connection?.lastSuccessfulAt ?? null);
  const connected = Boolean(configured && connection?.status === 'ACTIVE' && checkedAt);
  return {
    configured,
    connected,
    status: disconnected || !configured ? 'verification_required' : connected ? 'connected' : 'attention',
    environment: connection?.environment === 'PRODUCTION' ? 'live' : 'try',
    checkedAt,
    message: extras?.message,
    maskedIdentifier: connection?.maskedCredential ?? undefined,
    updatedAt: connection?.updatedAt,
  };
}

export async function probeWorldpayConnection(connection: IntegrationConnectionRecord) {
  const credential = await readStoredWorldpayCredential(connection, connection.organisationId);
  if (!credential) {
    throw new HttpError(503, 'Worldpay credentials could not be loaded for this pharmacy.', 'WORLDPAY_SECRET_UNAVAILABLE');
  }
  const validation = await validateWorldpayCredentials(credential);
  return {
    passed: true as const,
    checkedAt: validation.checkedAt,
    environment: validation.environment,
    entityId: validation.entityId,
    message: 'The stored Worldpay credential responded successfully.',
  };
}

export async function writeWorldpayCredential(
  organisationId: string,
  credential: WorldpayCredential,
  existingResourceName?: string | null,
): Promise<string> {
  const resourceName = existingResourceName && allowedSecretResource(existingResourceName)
    ? existingResourceName
    : defaultWorldpaySecretResource(organisationId);
  if (!allowedSecretResource(resourceName)) {
    throw new HttpError(503, 'Worldpay credentials could not be stored securely.', 'SECRET_STORE_FAILED');
  }

  const parent = `projects/${config.FIREBASE_PROJECT_ID}`;
  try {
    try {
      await secretClient.getSecret({ name: resourceName });
    } catch (error) {
      if ((error as { code?: number }).code !== 5) throw error;
      await secretClient.createSecret({
        parent,
        secretId: secretIdFromResource(resourceName),
        secret: {
          replication: { userManaged: { replicas: [{ location: SECRET_REGION }] } },
          labels: { application: 'hhh', integration: 'worldpay', region: SECRET_REGION },
        },
      });
    }
    await secretClient.addSecretVersion({
      parent: resourceName,
      payload: { data: Buffer.from(JSON.stringify(worldpaySecretPayload(credential)), 'utf8') },
    });
    return resourceName;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const code = (error as { code?: number }).code;
    const details = String((error as { details?: string }).details ?? (error as Error).message ?? '');
    if (code === 7 || /PERMISSION_DENIED|secretmanager/i.test(details)) {
      throw new HttpError(503, 'Worldpay credentials could not be stored: Secret Manager permission is missing on the API runtime.', 'SECRET_MANAGER_DENIED');
    }
    throw new HttpError(503, 'Worldpay credentials could not be stored securely.', 'SECRET_STORE_FAILED');
  }
}

export async function revokeWorldpayCredential(resourceName: string | null) {
  if (!resourceName || !allowedSecretResource(resourceName)) return;
  try {
    await secretClient.addSecretVersion({
      parent: resourceName,
      payload: { data: Buffer.from(JSON.stringify({ revokedAt: new Date().toISOString() }), 'utf8') },
    });
  } catch {
    // The connection is still marked disconnected even if secret overwrite fails.
  }
}

async function requireStoredWorldpayCredential(
  connection: IntegrationConnectionRecord | null,
  organisationId: string,
): Promise<WorldpayCredential> {
  const stored = await readStoredWorldpayCredential(connection, organisationId);
  if (!stored) {
    throw new HttpError(503, 'Worldpay is not configured for this pharmacy.', 'WORLDPAY_NOT_CONFIGURED');
  }
  return stored;
}

async function worldpayFetch(url: URL, init: RequestInit, credential: WorldpayCredential) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: worldpayAuthorization(credential),
        Accept: PAYMENT_QUERIES_MEDIA_TYPE,
        ...init.headers,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new HttpError(504, 'Worldpay did not respond in time.', 'WORLDPAY_TIMEOUT');
    }
    throw new HttpError(502, 'Worldpay could not be reached.', 'WORLDPAY_UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
  }
}

export function safeWorldpayActionUrl(href: string, baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(href, baseUrl);
  } catch {
    throw new HttpError(502, 'Worldpay returned an invalid refund action.', 'WORLDPAY_REFUND_LINK_INVALID');
  }
  const allowedOrigin = new URL(baseUrl).origin;
  if (url.protocol !== 'https:' || url.origin !== allowedOrigin || url.username || url.password) {
    throw new HttpError(502, 'Worldpay returned an untrusted refund action.', 'WORLDPAY_REFUND_LINK_INVALID');
  }
  return url;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function refundResponseBody(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function submitWorldpayRefund(input: {
  connection: IntegrationConnectionRecord | null;
  organisationId: string;
  transactionReference: string;
  amountPence: number;
  currency: string;
  reference: string;
  full: boolean;
}): Promise<WorldpayRefundSubmission> {
  const credential = await requireStoredWorldpayCredential(input.connection, input.organisationId);
  const queried = await queryWorldpayPayment(input.connection, input.organisationId, input.transactionReference);
  if (!queried.queried) {
    throw new HttpError(503, queried.reason, 'WORLDPAY_REFUND_QUERY_UNAVAILABLE');
  }
  if (!queried.query.found || !queried.query.payment) {
    throw new HttpError(409, 'Worldpay could not find the settled payment.', 'WORLDPAY_REFUND_PAYMENT_MISSING');
  }
  const action = worldpayRefundAction(queried.query.payment, !input.full);
  if (!action) {
    throw new HttpError(409, 'Worldpay did not offer a refund action for this payment.', 'WORLDPAY_REFUND_LINK_MISSING');
  }

  const baseUrl = worldpayBaseUrl(input.connection?.environment);
  const url = safeWorldpayActionUrl(action.href, baseUrl);
  const partialBody = {
    reference: input.reference,
    value: { amount: input.amountPence, currency: input.currency },
  };
  const attempts = action.style === 'payments-api' ? ['application/json'] : [...CARD_PAYMENTS_MEDIA_TYPES];
  let response: Response | null = null;
  for (const mediaType of attempts) {
    response = await worldpayFetch(url, {
      method: 'POST',
      headers: {
        Accept: mediaType,
        'Content-Type': mediaType,
        ...(action.style === 'payments-api' ? { 'WP-Api-Version': PAYMENTS_API_VERSION } : {}),
      },
      body: input.full && action.style === 'card-payments' ? undefined : JSON.stringify(input.full ? {} : partialBody),
    }, credential);
    if (response.status !== 415 || mediaType === attempts.at(-1)) break;
  }
  if (!response) {
    throw new HttpError(502, 'Worldpay did not accept the refund request.', 'WORLDPAY_REFUND_OUTCOME_UNKNOWN');
  }
  const body = await refundResponseBody(response);
  if (response.status !== 202) {
    const ambiguous = response.status >= 500 || response.status === 408 || response.status === 429;
    throw new HttpError(
      ambiguous ? 503 : 409,
      ambiguous
        ? 'Worldpay may have received the refund request, but its outcome is not yet known.'
        : `Worldpay rejected the refund request (${response.status}).`,
      ambiguous ? 'WORLDPAY_REFUND_OUTCOME_UNKNOWN' : 'WORLDPAY_REFUND_REJECTED',
    );
  }
  return {
    accepted: true,
    commandId: stringField(body, 'commandId'),
    paymentId: stringField(body, 'paymentId') ?? queried.query.paymentId,
    reference: input.reference,
    providerStatus: stringField(body, 'outcome') ?? stringField(body, 'lastEvent'),
    raw: body,
  };
}

export async function queryWorldpayPayment(
  connection: IntegrationConnectionRecord | null,
  organisationId: string,
  transactionReference: string,
): Promise<{
  queried: false;
  reason: string;
} | {
  queried: true;
  query: WorldpayPaymentQuery;
  expectedEntityId: string;
}> {
  const credential = await readStoredWorldpayCredential(connection, organisationId);
  if (!credential) return { queried: false, reason: 'Worldpay credentials are not stored for this pharmacy.' };
  const baseUrl = worldpayBaseUrl(connection?.environment);
  const url = new URL('/paymentQueries/payments', baseUrl);
  url.searchParams.set('transactionReference', transactionReference);
  const response = await worldpayFetch(url, {}, credential);
  if (!response.ok) return { queried: false, reason: `Payment Queries returned ${response.status}.` };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { queried: false, reason: 'Payment Queries returned invalid JSON.' };
  }
  const summary = normaliseWorldpayPaymentQuery(body, transactionReference);
  if (!summary.found || !summary.paymentId) {
    return {
      queried: true,
      query: summary,
      expectedEntityId: credential.entityId,
    };
  }

  // Transaction-reference lookup returns summary data only. The payment detail
  // resource carries the event history and current lifecycle action links.
  const detailUrl = new URL(`/paymentQueries/payments/${encodeURIComponent(summary.paymentId)}`, baseUrl);
  const detailResponse = await worldpayFetch(detailUrl, {}, credential);
  if (!detailResponse.ok) {
    return { queried: false, reason: `Payment Queries detail returned ${detailResponse.status}.` };
  }
  let detailBody: unknown;
  try {
    detailBody = await detailResponse.json();
  } catch {
    return { queried: false, reason: 'Payment Queries detail returned invalid JSON.' };
  }
  const detail = normaliseWorldpayPaymentQuery(detailBody, transactionReference);
  if (!detail.found || detail.paymentId !== summary.paymentId) {
    return { queried: false, reason: 'Payment Queries detail did not match the requested payment.' };
  }
  return {
    queried: true,
    query: detail,
    expectedEntityId: credential.entityId,
  };
}

export async function createWorldpayHostedSession(
  connection: IntegrationConnectionRecord | null,
  organisationId: string,
  input: {
    orderNumber: string;
    transactionReference: string;
    amountPence: number;
    currency: string;
    statementNarrative?: string;
    expirySeconds?: number;
    successUrl?: string;
    cancelUrl?: string;
  }
): Promise<WorldpaySessionResult> {
  const expirySeconds = input.expirySeconds || WORLDPAY_DEFAULT_LINK_EXPIRY_SECONDS;
  const expiresAt = new Date(Date.now() + expirySeconds * 1000).toISOString();
  const credential = await requireStoredWorldpayCredential(connection, organisationId);
  const baseUrl = worldpayBaseUrl(connection?.environment);
  const endpoint = new URL('/payment_pages', baseUrl);
  const authHeader = `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const requestBody: Record<string, unknown> = {
      transactionReference: input.transactionReference,
      merchant: { entity: credential.entityId },
      narrative: { line1: (input.statementNarrative || 'HHH Pharmacy').slice(0, 24) },
      value: { currency: input.currency || 'GBP', amount: input.amountPence },
      expiry: String(expirySeconds),
      resultURLs: {
        successURL: input.successUrl || `https://holistichealthhub.live/payment/success?ref=${encodeURIComponent(input.transactionReference)}`,
        cancelURL: input.cancelUrl || `https://holistichealthhub.live/payment/cancelled?ref=${encodeURIComponent(input.transactionReference)}`,
      },
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: authHeader,
        'Content-Type': HPP_MEDIA_TYPE,
        Accept: HPP_MEDIA_TYPE,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new HttpError(502, 'Worldpay rejected the payment session.', 'WORLDPAY_REQUEST_FAILED');
    }

    const body = await response.json() as Record<string, any>;
    const payUrl = (body.url || body._links?.redirect?.href || body._links?.self?.href) as string | undefined;
    if (!payUrl) {
      throw new HttpError(502, 'Worldpay did not return a payment URL.', 'WORLDPAY_REQUEST_FAILED');
    }

    return {
      url: payUrl,
      transactionReference: input.transactionReference,
      providerPaymentId: body.id,
      expiresAt,
      raw: body,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new HttpError(504, 'Worldpay did not respond in time.', 'WORLDPAY_TIMEOUT');
    }
    throw new HttpError(502, 'Worldpay could not be reached.', 'WORLDPAY_UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
  }
}
