import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { config } from '../../bootstrap/config.js';
import { HttpError } from '../../domain/common/errors.js';
import {
  SCAN_PRESCRIPTION_ID_META,
  SCAN_STATUS_META,
  asClinicScanProducts,
  clinicPrescriptionPlacementEligibility,
  clinicScanId,
  curaleafHttpStatus,
  matchClinicPrescriptionPacks,
  parseClinicPrescriber,
  parseClinicPrescription,
  prescriptionIdFromUpload,
} from './curaleaf-clinic-scan.js';
import {
  existingCuraleafPurchaseOrder,
  matchPurchaseOrder,
} from '../orders/curaleaf-fulfilment.js';
import {
  prescriptionFileIdsFromSnapshot,
  purgeOrderPrescriptionFiles,
} from '../prescriptions/prescription-file-purge.js';
import { persistCuraleafPrescriptionIdentity } from '../prescriptions/curaleaf-prescription-record.js';
import {
  isCuraleafPrescriberRejected,
  isCuraleafCorrectionRequired,
  isCuraleafTerminalRejection,
  stampCuraleafAttentionOnSnapshot,
  stampCuraleafCancellationOnSnapshot,
} from './curaleaf-events.js';
import {
  applyPassedQuoteReview,
  curaleafCancellationBlocksPlacement,
  evaluateQuoteReview,
  isQuoteReviewBlocking,
  readQuoteReview,
  stampQuoteReviewOnSnapshot,
  supplierPurchaseOrderCancelled,
} from '../orders/quote-review.js';
import {
  buildPrescriptionPlacementItems,
  packSizeFromProductRecord,
  prescriptionItemsFromSnapshot,
} from '../orders/prescription-units.js';
import { StorageProvider } from '../../providers/storage/storage.provider.js';
import { MAX_PRESCRIPTION_UPLOAD_BYTES } from '../../providers/storage/upload-constraints.js';
import type { IntegrationConnectionRecord } from '../../repositories/ports/integration.port.js';
import { SqlOrderRepository } from '../../repositories/sql/order.sql.js';
import { SqlPrescriptionRepository } from '../../repositories/sql/prescription.sql.js';

const secretClient = new SecretManagerServiceClient();
const REQUEST_TIMEOUT_MS = 12_000;
const CLINIC_SCAN_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 200;
const MAX_PAGES = 5;
const SECRET_REGION = 'europe-west2';
const KEY_PROBE_GAP_MS = 1_100;
const requestStarts = new Map<string, number>();
const requestTurns = new Map<string, Promise<void>>();

async function paceCuraleafRequest(apiKey: string) {
  const prior = requestTurns.get(apiKey) ?? Promise.resolve();
  const turn = prior.catch(() => undefined).then(async () => {
    const waitMs = Math.max(0, KEY_PROBE_GAP_MS - (Date.now() - (requestStarts.get(apiKey) ?? 0)));
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    requestStarts.set(apiKey, Date.now());
  });
  requestTurns.set(apiKey, turn);
  await turn;
  if (requestTurns.get(apiKey) === turn) requestTurns.delete(apiKey);
}

export type CuraleafCredential = { customerId: string; writeApiKey: string; readApiKey?: string };

export function maskCuraleafIdentifier(value: string) {
  const tail = value.slice(-4);
  return `${'•'.repeat(Math.min(8, Math.max(4, value.length - tail.length)))}${tail}`;
}

function allowedSecretResource(name: string) {
  return name.startsWith(`projects/${config.FIREBASE_PROJECT_ID}/secrets/hhh-curaleaf-`)
    && name.endsWith('-europe-west2');
}

function defaultCuraleafSecretResource(organisationId: string) {
  return `projects/${config.FIREBASE_PROJECT_ID}/secrets/hhh-curaleaf-${organisationId}-${SECRET_REGION}`;
}

function secretIdFromResource(resourceName: string) {
  return resourceName.split('/secrets/')[1] ?? '';
}

export function curaleafEnvironment(): 'test' | 'production' {
  return config.CURALEAF_BASE_URL.includes('.dev') ? 'test' : 'production';
}

async function credentialFor(connection: IntegrationConnectionRecord): Promise<CuraleafCredential> {
  const resource = connection.secretResourceName;
  if (!resource || !allowedSecretResource(resource)) {
    throw new HttpError(503, 'Curaleaf is not securely linked for this pharmacy.', 'INTEGRATION_NOT_CONNECTED');
  }
  try {
    const [version] = await secretClient.accessSecretVersion({ name: `${resource}/versions/latest` });
    const raw = version.payload?.data?.toString('utf8');
    const parsed = raw ? JSON.parse(raw) as Partial<CuraleafCredential> : null;
    if (!parsed?.customerId || !parsed.writeApiKey) throw new Error('Credential payload is incomplete.');
    return {
      customerId: parsed.customerId,
      writeApiKey: parsed.writeApiKey,
      ...(parsed.readApiKey ? { readApiKey: parsed.readApiKey } : {}),
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'Curaleaf credentials could not be accessed securely.', 'INTEGRATION_NOT_CONNECTED');
  }
}

function customerIds(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(customerIds);
  const object = value as Record<string, unknown>;
  return [
    typeof object.customerId === 'string' ? object.customerId : null,
    ...Object.values(object).flatMap(customerIds),
  ].filter((item): item is string => Boolean(item));
}

async function requestPage(path: string, apiKey: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    await paceCuraleafRequest(apiKey);
    const response = await fetch(new URL(path.replace(/^\//, ''), `${config.CURALEAF_BASE_URL}/`), {
      method: 'GET', signal: controller.signal,
      headers: { Accept: 'application/json', 'X-API-Key': apiKey },
    });
    if (!response.ok) {
      throw new HttpError(response.status === 429 ? 429 : 502, 'Curaleaf could not provide the catalogue.', 'CURALEAF_REQUEST_FAILED');
    }
    try {
      return await response.json() as Record<string, unknown>;
    } catch {
      throw new HttpError(502, 'Curaleaf returned an invalid catalogue response.', 'CURALEAF_REQUEST_FAILED');
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new HttpError(504, 'Curaleaf catalogue request timed out.', 'CURALEAF_TIMEOUT');
    }
    throw new HttpError(502, 'Curaleaf could not be reached.', 'CURALEAF_UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
  }
}

async function probeCuraleafApiKey(apiKey: string, expectedCustomerId: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(new URL('v1/formulas/?pageNumber=0&pageSize=1', `${config.CURALEAF_BASE_URL}/`), {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json', 'X-API-Key': apiKey },
    });
    if (response.status === 401 || response.status === 403) {
      throw new HttpError(401, 'Curaleaf rejected these API keys.', 'CURALEAF_CREDENTIALS_REJECTED');
    }
    if (!response.ok) {
      throw new HttpError(response.status === 429 ? 429 : 502, `Curaleaf could not validate the connection (${response.status}).`, 'CURALEAF_VALIDATION_FAILED');
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new HttpError(502, 'Curaleaf returned an invalid validation response.', 'CURALEAF_VALIDATION_FAILED');
    }
    const unexpectedCustomer = customerIds(body).find(id => id !== expectedCustomerId);
    if (unexpectedCustomer) {
      throw new HttpError(502, 'Curaleaf returned data for a different pharmacy.', 'CURALEAF_TENANT_MISMATCH');
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new HttpError(504, 'Curaleaf did not respond in time.', 'CURALEAF_TIMEOUT');
    }
    throw new HttpError(502, 'Curaleaf could not be reached.', 'CURALEAF_UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
  }
}

export async function validateCuraleafCredentials(credential: CuraleafCredential) {
  await probeCuraleafApiKey(credential.writeApiKey, credential.customerId);
  if (credential.readApiKey && credential.readApiKey !== credential.writeApiKey) {
    await new Promise(resolve => setTimeout(resolve, KEY_PROBE_GAP_MS));
    await probeCuraleafApiKey(credential.readApiKey, credential.customerId);
  }
  return {
    passed: true as const,
    checkedAt: new Date().toISOString(),
    observedCustomerId: credential.customerId,
    environment: curaleafEnvironment(),
    message: 'Curaleaf API keys were verified against the supplier.',
  };
}

export async function writeCuraleafCredential(
  organisationId: string,
  credential: CuraleafCredential,
  existingResourceName?: string | null,
): Promise<string> {
  const resourceName = existingResourceName && allowedSecretResource(existingResourceName)
    ? existingResourceName
    : defaultCuraleafSecretResource(organisationId);
  if (!allowedSecretResource(resourceName)) {
    throw new HttpError(503, 'Curaleaf credentials could not be stored securely.', 'SECRET_STORE_FAILED');
  }

  const parent = `projects/${config.FIREBASE_PROJECT_ID}`;
  const payload: Record<string, string> = {
    customerId: credential.customerId,
    writeApiKey: credential.writeApiKey,
    ...(credential.readApiKey ? { readApiKey: credential.readApiKey } : {}),
  };
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
          labels: { application: 'hhh', integration: 'curaleaf', region: SECRET_REGION },
        },
      });
    }
    await secretClient.addSecretVersion({
      parent: resourceName,
      payload: { data: Buffer.from(JSON.stringify(payload), 'utf8') },
    });
    return resourceName;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const code = (error as { code?: number }).code;
    const details = String((error as { details?: string }).details ?? (error as Error).message ?? '');
    if (code === 7 || /PERMISSION_DENIED|secretmanager/i.test(details)) {
      throw new HttpError(503, 'Curaleaf credentials could not be stored: Secret Manager permission is missing on the API runtime.', 'SECRET_MANAGER_DENIED');
    }
    throw new HttpError(503, 'Curaleaf credentials could not be stored securely.', 'SECRET_STORE_FAILED');
  }
}

async function listAll(path: string, collectionKey: string, credential: CuraleafCredential) {
  const records: unknown[] = [];
  let totalRecordCount = Number.POSITIVE_INFINITY;
  for (let pageNumber = 0; pageNumber < MAX_PAGES && records.length < totalRecordCount; pageNumber += 1) {
    if (pageNumber > 0) await new Promise(resolve => setTimeout(resolve, 1_050));
    const query = new URLSearchParams({ pageNumber: String(pageNumber), pageSize: String(PAGE_SIZE) });
    const page = await requestPage(`${path}?${query}`, credential.readApiKey || credential.writeApiKey);
    const items = page[collectionKey];
    if (!Array.isArray(items)) {
      throw new HttpError(502, 'Curaleaf returned an invalid catalogue page.', 'CURALEAF_REQUEST_FAILED');
    }
    const unexpectedCustomer = customerIds(items).find(customerId => customerId !== credential.customerId);
    if (unexpectedCustomer) {
      throw new HttpError(502, 'Curaleaf returned data for a different pharmacy.', 'CURALEAF_TENANT_MISMATCH');
    }
    records.push(...items);
    totalRecordCount = Number(page.totalRecordCount ?? records.length);
    if (items.length === 0) break;
  }
  return { records, totalRecordCount: Number.isFinite(totalRecordCount) ? totalRecordCount : records.length };
}

async function productPackSizeCatalogue(connection: IntegrationConnectionRecord) {
  const credential = await credentialFor(connection);
  const products = await listAll('/v1/products/', 'products', credential);
  const sizes = new Map<string, number>();
  for (const raw of products.records) {
    const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const id = String(record.id || '').trim();
    const packSize = packSizeFromProductRecord(record);
    if (id && packSize) sizes.set(id, packSize);
  }
  return sizes;
}

export async function fetchCuraleafCatalogue(connection: IntegrationConnectionRecord) {
  const credential = await credentialFor(connection);
  const formulas = await listAll('/v1/formulas/', 'formulas', credential);
  await new Promise(resolve => setTimeout(resolve, 1_050));
  const products = await listAll('/v1/products/', 'products', credential);
  return {
    environment: config.CURALEAF_BASE_URL.includes('.dev') ? 'test' as const : 'production' as const,
    fetchedAt: new Date().toISOString(),
    formulas: formulas.records,
    products: products.records,
    formulaTotal: formulas.totalRecordCount,
    productTotal: products.totalRecordCount,
  };
}

export async function fetchCuraleafPurchaseOrders(connection: IntegrationConnectionRecord) {
  const data = await curaleafApiRequest<{ purchaseOrders: any[]; totalRecordCount: number }>(
    connection,
    '/v1/purchase-orders/?pageNumber=0&pageSize=200'
  );
  return data.purchaseOrders || [];
}

export async function fetchCuraleafShipments(connection: IntegrationConnectionRecord) {
  const data = await curaleafApiRequest<{ shipments: any[]; totalRecordCount?: number }>(
    connection,
    '/v1/shipments/?pageNumber=0&pageSize=200'
  );
  return data.shipments || [];
}

export async function curaleafApiRequest<T = any>(
  connection: IntegrationConnectionRecord,
  path: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const credential = await credentialFor(connection);
  const method = (init.method || 'GET').toUpperCase();
  const apiKey = method === 'GET' ? (credential.readApiKey || credential.writeApiKey) : credential.writeApiKey;
  const { timeoutMs = REQUEST_TIMEOUT_MS, headers: initHeaders, ...rest } = init;
  const isFormData = typeof FormData !== 'undefined' && rest.body instanceof FormData;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await paceCuraleafRequest(apiKey);
    const response = await fetch(new URL(path.replace(/^\//, ''), `${config.CURALEAF_BASE_URL}/`), {
      ...rest,
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'X-API-Key': apiKey,
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        ...initHeaders,
      },
    });

    const text = await response.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }

    if (!response.ok) {
      const publicMessage = response.status === 400 || response.status === 422
        ? 'Curaleaf could not accept the supplied details. Review the order and try again.'
        : response.status === 401 || response.status === 403
          ? 'Curaleaf did not authorize this request.'
          : response.status === 429
            ? 'Curaleaf is rate limiting requests. Try again shortly.'
            : `Curaleaf could not complete the request (${response.status}).`;
      throw new HttpError(
        [400, 401, 403, 409, 422, 429].includes(response.status) ? response.status : 502,
        publicMessage,
        'CURALEAF_REQUEST_FAILED',
        { curaleafStatus: response.status },
      );
    }

    const unexpectedCustomer = customerIds(body).find(id => id !== credential.customerId);
    if (unexpectedCustomer) {
      throw new HttpError(502, 'Curaleaf returned data for a different pharmacy.', 'CURALEAF_TENANT_MISMATCH');
    }

    return body as T;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new HttpError(504, 'Curaleaf request timed out.', 'CURALEAF_TIMEOUT');
    }
    throw new HttpError(502, 'Curaleaf could not be reached.', 'CURALEAF_UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
  }
}

export async function probeCuraleafConnection(connection: IntegrationConnectionRecord) {
  await curaleafApiRequest(connection, '/v1/formulas/?pageNumber=0&pageSize=1');
  return {
    passed: true as const,
    checkedAt: new Date().toISOString(),
    environment: curaleafEnvironment(),
    message: 'The stored Curaleaf credential responded successfully.',
  };
}

export async function fetchCuraleafQuote(
  connection: IntegrationConnectionRecord,
  items: Array<{ packId: string; quantity: number }>
) {
  return await curaleafApiRequest(connection, '/v1/quotes/', {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
}

async function uploadCuraleafPrescriptionFile(
  connection: IntegrationConnectionRecord,
  prescriptionId: string,
  file: { bytes: Buffer; contentType: string; filename: string },
) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(file.bytes)], { type: file.contentType }), file.filename);
  return curaleafApiRequest(connection, `/v1/prescriptions/${encodeURIComponent(prescriptionId)}/file/`, {
    method: 'POST',
    body: form,
    timeoutMs: 30_000,
  });
}

async function rememberScanState(storage: StorageProvider, storagePath: string, patch: Record<string, string>) {
  await storage.patchCustomMetadata(storagePath, patch);
}

export async function scanClinicPrescriptionFromStoredFile(
  connection: IntegrationConnectionRecord,
  organisationId: string,
  fileId: string,
) {
  const scanId = clinicScanId(organisationId, fileId);
  const prescriptionRepo = new SqlPrescriptionRepository();
  const storage = new StorageProvider();
  const record = await prescriptionRepo.findFileById(fileId, organisationId);
  if (!record?.storagePath || record.status === 'DELETED' || record.deletedAt) {
    throw new HttpError(404, 'Prescription file not found.', 'NOT_FOUND');
  }
  if (record.status !== 'UPLOADED') {
    throw new HttpError(409, 'Complete and verify the prescription file upload first.', 'UPLOAD_INCOMPLETE');
  }

  const existingMeta = await storage.readCustomMetadata(record.storagePath);
  const existingStatus = existingMeta[SCAN_STATUS_META];
  if (existingStatus === 'reconciliation_required') {
    throw new HttpError(409, 'Curaleaf may have received this barcode but did not return a reference. Contact your HHH administrator before scanning it again.', 'CURALEAF_SCAN_RECONCILIATION_REQUIRED');
  }
  if (existingStatus === 'failed') {
    throw new HttpError(409, 'This barcode scan could not be completed. Reattach a clear prescription copy to start a new scan.', 'CURALEAF_SCAN_FAILED');
  }

  let prescriptionId = existingMeta[SCAN_PRESCRIPTION_ID_META]?.trim() || undefined;
  if (!prescriptionId) {
    const downloaded = await storage.downloadFile(record.storagePath);
    if (downloaded.bytes.length < 1 || downloaded.bytes.length > MAX_PRESCRIPTION_UPLOAD_BYTES) {
      throw new HttpError(400, 'Prescription files must be 16 MB or smaller.', 'FILE_TOO_LARGE');
    }
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(downloaded.bytes)], { type: downloaded.contentType || record.contentType || 'application/pdf' }),
      record.originalFilename || 'prescription.pdf',
    );
    try {
      const upload = await curaleafApiRequest<unknown>(connection, '/v1/prescription-from-image/', {
        method: 'POST',
        body: form,
        timeoutMs: CLINIC_SCAN_TIMEOUT_MS,
      });
      prescriptionId = prescriptionIdFromUpload(upload);
      if (!prescriptionId) {
        await rememberScanState(storage, record.storagePath, { [SCAN_STATUS_META]: 'reconciliation_required' });
        throw new HttpError(502, 'Curaleaf did not return a prescription reference for this barcode image.', 'CURALEAF_SCAN_REFERENCE_MISSING');
      }
      await rememberScanState(storage, record.storagePath, {
        [SCAN_PRESCRIPTION_ID_META]: prescriptionId,
        [SCAN_STATUS_META]: 'processing',
      });
    } catch (error) {
      if (error instanceof HttpError && (error.code === 'CURALEAF_TIMEOUT' || error.code === 'CURALEAF_UNAVAILABLE')) {
        await rememberScanState(storage, record.storagePath, { [SCAN_STATUS_META]: 'reconciliation_required' });
        throw new HttpError(409, 'Curaleaf may have received this barcode but did not return a reference. Contact your HHH administrator before scanning it again.', 'CURALEAF_SCAN_RECONCILIATION_REQUIRED');
      }
      if (error instanceof HttpError && error.code === 'CURALEAF_SCAN_REFERENCE_MISSING') throw error;
      await rememberScanState(storage, record.storagePath, { [SCAN_STATUS_META]: 'failed' });
      throw error;
    }
  }

  let prescriptionBody: unknown;
  try {
    prescriptionBody = await curaleafApiRequest(connection, `/v1/prescriptions/${encodeURIComponent(prescriptionId)}/`);
  } catch (error) {
    if (curaleafHttpStatus(error) === 404) {
      return { scanId, status: 'processing' as const, prescriptionId };
    }
    throw error;
  }

  const prescription = parseClinicPrescription(prescriptionBody);
  const eligibility = clinicPrescriptionPlacementEligibility(prescription.state);
  if (!eligibility.eligible) {
    await rememberScanState(storage, record.storagePath, { [SCAN_STATUS_META]: 'failed' });
    throw new HttpError(409, eligibility.reason, 'CURALEAF_PRESCRIPTION_NOT_ELIGIBLE');
  }
  const prescriberBody = await curaleafApiRequest(connection, `/v1/prescribers/${encodeURIComponent(prescription.prescriberId)}/`);
  const prescriber = parseClinicPrescriber(prescriberBody);
  const credential = await credentialFor(connection);
  const products = asClinicScanProducts((await listAll('/v1/products/', 'products', credential)).records);
  const matchedItems = matchClinicPrescriptionPacks(prescription.items, products);
  await rememberScanState(storage, record.storagePath, {
    [SCAN_PRESCRIPTION_ID_META]: prescription.id,
    [SCAN_STATUS_META]: 'ready',
  });

  return {
    scanId,
    status: 'ready' as const,
    prescription,
    prescriber: {
      id: prescriber.id,
      name: prescriber.name,
      initials: prescriber.initials,
      gmcNumber: prescriber.gmcNumber,
      gphcNumber: prescriber.gphcNumber,
    },
    matchedItems,
  };
}

async function uploadLocalPrescriptionCopyToCuraleaf(
  connection: IntegrationConnectionRecord,
  organisationId: string,
  snapshot: unknown,
  curaleafPrescriptionId: string,
) {
  const fileIds = prescriptionFileIdsFromSnapshot(snapshot);
  if (!fileIds.length) return { uploaded: false, required: false, correctionRequired: false };
  const prescriptionRepo = new SqlPrescriptionRepository();
  const storage = new StorageProvider();
  let uploaded = false;
  let correctionRequired = false;

  for (const fileId of fileIds) {
    const record = await prescriptionRepo.findFileById(fileId, organisationId);
    if (!record?.storagePath) continue;
    try {
      const downloaded = await storage.downloadFile(record.storagePath);
      await uploadCuraleafPrescriptionFile(connection, curaleafPrescriptionId, {
        bytes: downloaded.bytes,
        contentType: downloaded.contentType || record.contentType || 'application/pdf',
        filename: record.originalFilename || 'prescription.pdf',
      });
      uploaded = true;
    } catch (error) {
      const alreadyHeld = error instanceof HttpError && error.statusCode === 409
        || /already|exists|duplicate/i.test(error instanceof Error ? error.message : String(error));
      if (alreadyHeld) {
        uploaded = true;
      } else {
        correctionRequired = true;
        console.warn('[Curaleaf] Prescription file upload requires attention.', {
          code: error instanceof HttpError ? error.code : 'CURALEAF_UPLOAD_FAILED',
          statusCode: error instanceof HttpError ? error.statusCode : undefined,
        });
      }
    }
  }

  return { uploaded, required: true, correctionRequired: correctionRequired || !uploaded };
}

async function persistPlacementAttention(input: {
  organisationId: string;
  order: { id: string; quoteSnapshot?: unknown };
  source: 'prescriber' | 'prescription' | 'prescription_upload' | 'purchase_order';
  reason: string;
  code: string;
  terminal?: boolean;
  purchaseOrderId?: string | null;
  prescriptionId?: string | null;
  prescriberId?: string | null;
}) {
  const nextSnapshot = stampCuraleafAttentionOnSnapshot(input.order.quoteSnapshot, {
    source: input.source,
    reason: input.reason,
    code: input.code,
    terminal: input.terminal,
    prescriptionId: input.prescriptionId,
    prescriberId: input.prescriberId,
  });
  await new SqlOrderRepository().updateQuoteSnapshot({
    id: input.order.id,
    organisationId: input.organisationId,
    quoteSnapshot: nextSnapshot,
    fulfilmentStatus: input.terminal ? 'EXCEPTION' : 'SUPPLIER_PENDING',
  });
  return {
    skipped: true as const,
    correctionRequired: !input.terminal,
    terminal: Boolean(input.terminal),
    reason: input.reason,
    prescriberId: input.prescriberId ?? null,
    prescriptionId: input.prescriptionId ?? null,
    purchaseOrder: null,
  };
}

export async function executeCuraleafOrderPlacement(
  connection: IntegrationConnectionRecord,
  order: {
    id: string;
    orderNumber?: string | null;
    status?: string | null;
    paymentStatus?: string | null;
    paidAt?: string | null;
    quoteSnapshot?: unknown;
    patientId?: string | null;
  }
) {
  if (order.status === 'CANCELLED') {
    return { skipped: true, reason: 'Order is cancelled' };
  }

  if (curaleafCancellationBlocksPlacement(order.quoteSnapshot) || supplierPurchaseOrderCancelled(order.quoteSnapshot)) {
    return { skipped: true, reason: 'Curaleaf purchase order was cancelled' };
  }

  if (order.paymentStatus !== 'PAID' && !order.paidAt) {
    return { skipped: true, reason: 'Order is not paid yet' };
  }

  const recordedPurchaseOrder = existingCuraleafPurchaseOrder(order);
  if (recordedPurchaseOrder) {
    await purgeOrderPrescriptionFiles(connection.organisationId, order.quoteSnapshot).catch(error =>
      console.warn('[Prescription file] Purge after recorded PO note:', error),
    );
    return {
      skipped: true,
      reason: 'Purchase order already recorded for this order',
      purchaseOrder: recordedPurchaseOrder,
      prescriptionId: (recordedPurchaseOrder as { prescriptionId?: string | null }).prescriptionId ?? null,
      prescriberId: (recordedPurchaseOrder as { prescriberId?: string | null }).prescriberId ?? null,
    };
  }

  const customerReference = order.orderNumber || `HHH-${order.id}`;
  let snapshot = (order.quoteSnapshot ?? {}) as Record<string, unknown>;
  const priorCuraleaf = (snapshot.curaleaf && typeof snapshot.curaleaf === 'object'
    ? snapshot.curaleaf
    : null) as {
      prescriptionId?: string | null;
      prescriberId?: string | null;
      prescriberState?: string | null;
      prescriptionState?: string | null;
    } | null;

  try {
    const livePurchaseOrders = await fetchCuraleafPurchaseOrders(connection);
    const matchedPurchaseOrder = matchPurchaseOrder(
      { id: order.id, orderNumber: order.orderNumber ?? customerReference },
      livePurchaseOrders,
      null,
    );
    if (matchedPurchaseOrder?.id) {
      if (isCuraleafTerminalRejection(matchedPurchaseOrder.state || matchedPurchaseOrder.purchaseOrderState)) {
        const cancelledSnapshot = stampCuraleafCancellationOnSnapshot(order.quoteSnapshot, {
          action: 'confirmed',
          purchaseOrderId: String(matchedPurchaseOrder.id),
          prescriptionId: priorCuraleaf?.prescriptionId ?? null,
          reference: 'curaleaf_po_cancelled',
          note: 'Curaleaf cancelled the purchase order after pharmacy contact.',
        });
        await new SqlOrderRepository().updateQuoteSnapshot({
          id: order.id,
          organisationId: connection.organisationId,
          quoteSnapshot: cancelledSnapshot,
          fulfilmentStatus: 'EXCEPTION',
        });
        return { skipped: true, reason: 'Curaleaf purchase order was cancelled' };
      }
      await purgeOrderPrescriptionFiles(connection.organisationId, snapshot).catch(error =>
        console.warn('[Prescription file] Purge after existing PO note:', error),
      );
      return {
        skipped: true,
        reason: 'Purchase order already exists at Curaleaf',
        purchaseOrder: matchedPurchaseOrder,
        prescriptionId: priorCuraleaf?.prescriptionId ?? null,
        prescriberId: priorCuraleaf?.prescriberId ?? null,
      };
    }
  } catch (lookupErr) {
    console.warn('[Curaleaf] Existing purchase-order lookup failed; placement is held.', {
      code: lookupErr instanceof HttpError ? lookupErr.code : 'CURALEAF_PURCHASE_ORDER_LOOKUP_FAILED',
      statusCode: lookupErr instanceof HttpError ? lookupErr.statusCode : undefined,
    });
    return { skipped: true, reason: 'Existing Curaleaf purchase orders could not be checked' };
  }

  const rxList = Array.isArray(snapshot.prescriptions) ? snapshot.prescriptions as Array<Record<string, unknown>> : [];
  const rxData = (rxList[0] && typeof rxList[0] === 'object' ? rxList[0] : {}) as Record<string, unknown>;
  const prescriberInfo = (rxData.prescriber && typeof rxData.prescriber === 'object'
    ? rxData.prescriber
    : {}) as Record<string, unknown>;

  const prescriberGphc = typeof prescriberInfo.gphcNumber === 'string' ? prescriberInfo.gphcNumber : null;
  const prescriberGmc = prescriberInfo.gmcNumber ? Number(prescriberInfo.gmcNumber) : null;
  const prescriberPin = String(prescriberInfo.pin || '');
  const clinicPrescriptionId = typeof rxData.curaleafPrescriptionId === 'string' && rxData.curaleafPrescriptionId.trim()
    ? rxData.curaleafPrescriptionId.trim()
    : null;
  const clinicRoute = Boolean(rxData.clinicScanId && clinicPrescriptionId);

  // Step 1 (manual route only): exact regulated-identity match/create, then wait for VERIFIED.
  let prescriberId: string | null = priorCuraleaf?.prescriberId
    ?? (typeof prescriberInfo.id === 'string' ? prescriberInfo.id : null);
  let prescriberState: 'UNVERIFIED' | 'VERIFIED' | 'ARCHIVED' | null = null;
  let prescriberError: unknown = null;
  if (!clinicRoute && (!prescriberPin.trim() || (!prescriberGphc && !prescriberGmc))) {
    return persistPlacementAttention({
      organisationId: connection.organisationId,
      order,
      source: 'prescriber',
      code: 'PRESCRIBER_REGULATOR_REQUIRED',
      reason: 'Enter the prescriber PIN and at least one GMC or GPhC number.',
      prescriberId,
    });
  }
  if (!clinicRoute && !prescriberId) {
    try {
      const prescriberPage = await listAll('/v1/prescribers/', 'prescribers', await credentialFor(connection));
      const allPrescribers = prescriberPage.records.flatMap(raw => raw && typeof raw === 'object'
        ? [raw as {
          id: string;
          gphcNumber?: string | null;
          gmcNumber?: number | null;
          pin?: string;
          state?: string;
        }]
        : []).filter(
        (prescriber) => !isCuraleafPrescriberRejected(prescriber.state),
      );
      const matched = allPrescribers.find(p =>
        (prescriberGphc && p.gphcNumber === prescriberGphc && p.pin === prescriberPin) ||
        (prescriberGmc && p.gmcNumber === prescriberGmc && p.pin === prescriberPin)
      );

      if (matched?.id) {
        prescriberId = matched.id;
        prescriberState = String(matched.state || '').toUpperCase() as 'UNVERIFIED' | 'VERIFIED' | 'ARCHIVED';
      } else {
        const createdPrescriber = await curaleafApiRequest<{ id: string; state?: string }>(connection, '/v1/prescribers/', {
          method: 'POST',
          body: JSON.stringify({
            name: prescriberInfo.name || 'Unknown Prescriber',
            initials: prescriberInfo.initials || 'XX',
            pin: prescriberPin,
            gmcNumber: prescriberGmc,
            gphcNumber: prescriberGphc,
          }),
        });
        prescriberId = createdPrescriber?.id ?? null;
        prescriberState = String(createdPrescriber?.state || '').toUpperCase() as 'UNVERIFIED' | 'VERIFIED' | 'ARCHIVED';
      }
    } catch (err) {
      prescriberError = err;
      console.warn('[Curaleaf] Prescriber check failed.', {
        code: err instanceof HttpError ? err.code : 'CURALEAF_PRESCRIBER_CHECK_FAILED',
        statusCode: err instanceof HttpError ? err.statusCode : undefined,
      });
    }
  }

  if (!clinicRoute && !prescriberId) {
    if (isCuraleafCorrectionRequired(prescriberError)) {
      return persistPlacementAttention({
        organisationId: connection.organisationId,
        order,
        source: 'prescriber',
        code: 'PRESCRIBER_CORRECTION_REQUIRED',
        reason: 'Curaleaf could not accept the prescriber details. Check the PIN and regulator number.',
      });
    }
    return {
      skipped: true,
      reason: 'Prescriber could not be verified with Curaleaf',
      prescriberId: null,
      prescriptionId: null,
      purchaseOrder: null,
    };
  }

  if (!clinicRoute && prescriberId) {
    try {
      const details = await curaleafApiRequest<{ state?: string }>(
        connection,
        `/v1/prescribers/${encodeURIComponent(prescriberId)}/`,
      );
      const observed = String(details.state || prescriberState || '').toUpperCase();
      prescriberState = observed === 'VERIFIED' || observed === 'UNVERIFIED' || observed === 'ARCHIVED'
        ? observed
        : null;
    } catch (error) {
      if (isCuraleafCorrectionRequired(error)) {
        return persistPlacementAttention({
          organisationId: connection.organisationId,
          order: { ...order, quoteSnapshot: snapshot },
          source: 'prescriber',
          code: 'PRESCRIBER_CORRECTION_REQUIRED',
          reason: 'Curaleaf could not verify the prescriber details.',
          prescriberId,
        });
      }
      return { skipped: true, reason: 'Prescriber verification could not be checked', prescriberId, prescriptionId: null, purchaseOrder: null };
    }
    snapshot = await persistCuraleafPrescriptionIdentity({
      organisationId: connection.organisationId,
      orderId: order.id,
      patientId: order.patientId,
      snapshot,
      prescriberId,
      prescriberState,
      purchaseOrder: null,
      fulfilmentStatus: prescriberState === 'ARCHIVED' ? 'EXCEPTION' : 'SUPPLIER_PENDING',
    }) as Record<string, unknown>;
    if (prescriberState === 'UNVERIFIED') {
      return { skipped: true, reason: 'Prescriber pending Curaleaf verification', prescriberId, prescriberState, prescriptionId: null, purchaseOrder: null };
    }
    if (prescriberState === 'ARCHIVED') {
      return persistPlacementAttention({
        organisationId: connection.organisationId,
        order: { ...order, quoteSnapshot: snapshot },
        source: 'prescriber',
        code: 'PRESCRIBER_ARCHIVED',
        reason: 'Curaleaf archived this prescriber. Correct or replace the prescriber before continuing.',
        prescriberId,
        terminal: true,
      });
    }
    if (prescriberState !== 'VERIFIED') {
      return persistPlacementAttention({
        organisationId: connection.organisationId,
        order: { ...order, quoteSnapshot: snapshot },
        source: 'prescriber',
        code: 'PRESCRIBER_STATE_UNKNOWN',
        reason: 'Curaleaf returned an unknown prescriber state. Review before continuing.',
        prescriberId,
      });
    }
  }

  // Step 2: Extract line items. Units are pack count × product pack size — never a 10g guess.
  const rxDataItems = Array.isArray(rxData.items) ? rxData.items as Array<Record<string, unknown>> : [];
  const rawItems: Array<Record<string, unknown>> = Array.isArray(snapshot.lineItems)
    ? snapshot.lineItems as Array<Record<string, unknown>>
    : Array.isArray(snapshot.items)
      ? snapshot.items as Array<Record<string, unknown>>
      : rxList.flatMap(rx => Array.isArray(rx.items) ? rx.items as Array<Record<string, unknown>> : []);
  const prescriptionItems = [...rxDataItems, ...prescriptionItemsFromSnapshot(snapshot)];
  let catalogPackSizeByPackId = new Map<string, number>();
  let placedLines = buildPrescriptionPlacementItems({
    rawLines: rawItems,
    prescriptionItems,
    catalogPackSizeByPackId,
  });
  if (placedLines.missingPackSize.length) {
    try {
      catalogPackSizeByPackId = await productPackSizeCatalogue(connection);
      placedLines = buildPrescriptionPlacementItems({
        rawLines: rawItems,
        prescriptionItems,
        catalogPackSizeByPackId,
      });
    } catch (error) {
      console.warn('[Curaleaf] Pack-size catalogue lookup note:', error);
      return {
        skipped: true,
        reason: 'Curaleaf pack sizes could not be retrieved',
        prescriberId,
        prescriptionId: null,
        purchaseOrder: null,
      };
    }
  }

  const lineItems = placedLines.items.map(item => ({
    productId: item.productId,
    count: item.count,
    formulaId: item.formulaId,
    unitsNeededCount: item.unitsNeededCount,
  }));
  const rxItems = placedLines.items.map(item => ({
    formulaId: item.formulaId,
    unitsNeededCount: item.unitsNeededCount,
  }));

  if (placedLines.missingPackSize.length) {
    return {
      skipped: true,
      reason: 'Prescription lines are missing Curaleaf pack sizes',
      prescriberId,
      prescriptionId: null,
      purchaseOrder: null,
    };
  }

  if (rxItems.length === 0) {
    return {
      skipped: true,
      reason: 'Prescription lines are missing Curaleaf formula IDs',
      prescriberId,
      prescriptionId: null,
      purchaseOrder: null,
    };
  }

  // Step 3: Stock and price re-check. Hold before creating a Rocky prescription.
  const blockingReview = readQuoteReview(snapshot);
  if (blockingReview?.status === 'awaiting_top_up' || blockingReview?.status === 'awaiting_refund') {
    return { skipped: true, reason: 'Quote review required', quoteReview: blockingReview };
  }
  if (lineItems.length > 0) {
    let latestQuote: unknown;
    try {
      latestQuote = await curaleafApiRequest(connection, '/v1/quotes/', {
        method: 'POST',
        body: JSON.stringify({
          items: lineItems.map(item => ({ packId: item.productId, quantity: item.count })),
        }),
      });
    } catch (quoteErr) {
      console.warn('[Curaleaf] Placement quote recheck note:', quoteErr);
      return { skipped: true, reason: 'Curaleaf quote could not be retrieved' };
    }
    try {
      const decision = evaluateQuoteReview({ snapshot, latestRaw: latestQuote });
      if (decision.hold) {
        const heldSnapshot = stampQuoteReviewOnSnapshot(snapshot, decision.review);
        await new SqlOrderRepository().updateQuoteSnapshot({
          id: order.id,
          organisationId: connection.organisationId,
          quoteSnapshot: heldSnapshot,
          fulfilmentStatus: 'SUPPLIER_PENDING',
        });
        return {
          skipped: true,
          reason: 'Quote review required',
          quoteReview: decision.review,
        };
      }
      const passed = applyPassedQuoteReview(snapshot, {
        latestRaw: latestQuote,
        fingerprint: decision.fingerprint,
      });
      if (passed.changed) {
        snapshot = passed.snapshot as Record<string, unknown>;
        await new SqlOrderRepository().updateQuoteSnapshot({
          id: order.id,
          organisationId: connection.organisationId,
          quoteSnapshot: snapshot,
          fulfilmentStatus: 'SUPPLIER_PENDING',
        });
      }
    } catch (quoteErr) {
      console.warn('[Curaleaf] Placement quote compare note:', quoteErr);
      return { skipped: true, reason: 'Curaleaf quote could not be retrieved' };
    }
  } else if (isQuoteReviewBlocking(snapshot)) {
    return { skipped: true, reason: 'Quote review required', quoteReview: blockingReview };
  }

  // Step 4: Submit prescription and capture the Curaleaf prescription ID.
  let curaleafPrescriptionId: string | null = priorCuraleaf?.prescriptionId ?? clinicPrescriptionId;
  let prescriptionCreateError: unknown = null;
  if (!curaleafPrescriptionId && !clinicRoute) {
    try {
      const serialNumber = typeof rxData.serialNumber === 'string'
        ? rxData.serialNumber
        : `RX-${order.orderNumber || (order.id || 'ORDER').slice(0, 8)}`;
      const issueDate = typeof rxData.issueDate === 'string'
        ? rxData.issueDate
        : new Date().toISOString().split('T')[0];
      const rxRes = await curaleafApiRequest<{ id: string; state?: string }>(connection, '/v1/prescriptions/', {
        method: 'POST',
        body: JSON.stringify({
          serialNumber,
          prescriberId,
          issueDate,
          items: rxItems,
        }),
      });
      if (rxRes?.id && isCuraleafTerminalRejection(rxRes.state)) {
        return persistPlacementAttention({
          organisationId: connection.organisationId,
          order: { ...order, quoteSnapshot: snapshot },
          source: 'prescription',
          code: 'PRESCRIPTION_CANCELLED',
          reason: 'Curaleaf cancelled the prescription. Review replacement or refund options.',
          prescriptionId: rxRes.id,
          prescriberId,
          terminal: true,
        });
      }
      if (rxRes?.id) {
        curaleafPrescriptionId = rxRes.id;
        console.log(`[Curaleaf] Prescription submitted: ${curaleafPrescriptionId} (serial: ${serialNumber})`);
      }
    } catch (err) {
      prescriptionCreateError = err;
      console.warn('[Curaleaf] Prescription creation failed.', {
        code: err instanceof HttpError ? err.code : 'CURALEAF_PRESCRIPTION_CREATE_FAILED',
        statusCode: err instanceof HttpError ? err.statusCode : undefined,
      });
    }
  }

  if (!curaleafPrescriptionId) {
    if (isCuraleafCorrectionRequired(prescriptionCreateError)) {
      return persistPlacementAttention({
        organisationId: connection.organisationId,
        order: { ...order, quoteSnapshot: snapshot },
        source: 'prescription',
        code: 'PRESCRIPTION_CORRECTION_REQUIRED',
        reason: 'Curaleaf could not accept the prescription details. Review the prescription and prescriber.',
        prescriberId,
      });
    }
    return {
      skipped: true,
      reason: 'Prescription could not be submitted to Curaleaf',
      prescriberId,
      prescriptionId: null,
      purchaseOrder: null,
    };
  }

  snapshot = await persistCuraleafPrescriptionIdentity({
    organisationId: connection.organisationId,
    orderId: order.id,
    patientId: order.patientId,
    snapshot,
    prescriptionId: curaleafPrescriptionId,
    prescriberId,
    purchaseOrder: null,
  }) as Record<string, unknown>;

  if (!clinicRoute) {
    const upload = await uploadLocalPrescriptionCopyToCuraleaf(
      connection,
      connection.organisationId,
      snapshot,
      curaleafPrescriptionId,
    );
    if (upload.correctionRequired) {
      return persistPlacementAttention({
        organisationId: connection.organisationId,
        order: { ...order, quoteSnapshot: snapshot },
        source: 'prescription_upload',
        code: 'PRESCRIPTION_UPLOAD_CORRECTION_REQUIRED',
        reason: 'The signed prescription image could not be uploaded to Curaleaf. Reupload a clear copy.',
        prescriptionId: curaleafPrescriptionId,
        prescriberId,
      });
    }
    if (!upload.required) {
      return persistPlacementAttention({
        organisationId: connection.organisationId,
        order: { ...order, quoteSnapshot: snapshot },
        source: 'prescription_upload',
        code: 'PRESCRIPTION_IMAGE_REQUIRED',
        reason: 'Attach the signed prescription image before placing the order.',
        prescriptionId: curaleafPrescriptionId,
        prescriberId,
      });
    }
  }

  // Step 5: Confirm prescription is ready before purchase-order-from-prescriptions.
  try {
    const prescriptionDetails = await curaleafApiRequest<{ state?: string }>(
      connection,
      `/v1/prescriptions/${encodeURIComponent(curaleafPrescriptionId)}/`,
    );
    const prescriptionState = String(prescriptionDetails.state || '').toUpperCase();
    if (prescriptionState === 'PENDING') {
      await persistCuraleafPrescriptionIdentity({
        organisationId: connection.organisationId,
        orderId: order.id,
        patientId: order.patientId,
        snapshot,
        prescriptionId: curaleafPrescriptionId,
        prescriberId,
        prescriptionState: 'PENDING',
        purchaseOrder: null,
        fulfilmentStatus: 'SUPPLIER_PENDING',
      });
      return {
        skipped: true,
        reason: 'Prescription pending Curaleaf approval',
        prescriberId,
        prescriptionId: curaleafPrescriptionId,
        purchaseOrder: null,
      };
    }
    if (prescriptionState === 'EXPIRED' || prescriptionState === 'FULFILLED' || isCuraleafTerminalRejection(prescriptionState)) {
      await persistCuraleafPrescriptionIdentity({
        organisationId: connection.organisationId,
        orderId: order.id,
        patientId: order.patientId,
        snapshot,
        prescriptionId: curaleafPrescriptionId,
        prescriberId,
        prescriptionState,
        purchaseOrder: null,
      });
      return persistPlacementAttention({
        organisationId: connection.organisationId,
        order: { ...order, quoteSnapshot: snapshot },
        source: 'prescription',
        code: `PRESCRIPTION_${prescriptionState}`,
        reason: `The Curaleaf prescription is ${prescriptionState.toLowerCase()} and cannot be used for a new purchase order.`,
        prescriptionId: curaleafPrescriptionId,
        prescriberId,
        terminal: true,
      });
    }
    if (prescriptionState !== 'ACTIVE') {
      return persistPlacementAttention({
        organisationId: connection.organisationId,
        order: { ...order, quoteSnapshot: snapshot },
        source: 'prescription',
        code: 'PRESCRIPTION_STATE_UNKNOWN',
        reason: 'Curaleaf returned an unknown prescription state. Review before placement.',
        prescriptionId: curaleafPrescriptionId,
        prescriberId,
      });
    }
  } catch (err) {
    console.warn('[Curaleaf] Prescription readiness check failed.', {
      code: err instanceof HttpError ? err.code : 'CURALEAF_PRESCRIPTION_CHECK_FAILED',
      statusCode: err instanceof HttpError ? err.statusCode : undefined,
    });
    return {
      skipped: true,
      reason: 'Prescription readiness could not be checked',
      prescriberId,
      prescriptionId: curaleafPrescriptionId,
      purchaseOrder: null,
    };
  }

  // Step 6: Purchase order from prescription — the only supported placement route.
  let purchaseOrderResult: Record<string, unknown> | null = null;
  try {
    purchaseOrderResult = await curaleafApiRequest(connection, '/v1/purchase-order-from-prescriptions/', {
      method: 'POST',
      body: JSON.stringify({
        customerReference,
        prescriptionIds: [curaleafPrescriptionId],
      }),
    });
    console.log(`[Curaleaf] Purchase order from prescription placed: ${JSON.stringify(purchaseOrderResult)}`);
    const createdPurchaseOrderId = String(purchaseOrderResult?.id || purchaseOrderResult?.purchaseOrderId || '').trim();
    if (createdPurchaseOrderId) {
      try {
        const livePurchaseOrder = await curaleafApiRequest<Record<string, unknown>>(
          connection,
          `/v1/purchase-orders/${encodeURIComponent(createdPurchaseOrderId)}/`,
        );
        if (livePurchaseOrder && typeof livePurchaseOrder === 'object') {
          purchaseOrderResult = { ...purchaseOrderResult, ...livePurchaseOrder };
        }
      } catch (lookupErr) {
        console.warn('[Curaleaf] Purchase-order detail lookup note:', lookupErr);
      }
    }
    await persistCuraleafPrescriptionIdentity({
      organisationId: connection.organisationId,
      orderId: order.id,
      patientId: order.patientId,
      snapshot,
      prescriptionId: curaleafPrescriptionId,
      prescriberId,
      prescriptionState: 'ACTIVE',
      purchaseOrder: purchaseOrderResult,
      customerReferenceFallback: customerReference,
      fulfilmentStatus: 'SUPPLIER_PROCESSING',
    });
    await purgeOrderPrescriptionFiles(connection.organisationId, snapshot).catch(error =>
      console.warn('[Prescription file] Purge after purchase-order-from-prescriptions note:', error),
    );
  } catch (poErr) {
    console.warn('[Curaleaf] Purchase order from prescription failed.', {
      code: poErr instanceof HttpError ? poErr.code : 'CURALEAF_PURCHASE_ORDER_FAILED',
      statusCode: poErr instanceof HttpError ? poErr.statusCode : undefined,
    });
    if (isCuraleafCorrectionRequired(poErr)) {
      return persistPlacementAttention({
        organisationId: connection.organisationId,
        order: { ...order, quoteSnapshot: snapshot },
        source: 'purchase_order',
        code: 'PURCHASE_ORDER_CORRECTION_REQUIRED',
        reason: 'Curaleaf could not create the purchase order from this prescription. Review the prescription before retrying.',
        prescriptionId: curaleafPrescriptionId,
        prescriberId,
      });
    }
    return {
      skipped: true,
      reason: 'Purchase order could not be created from prescription',
      prescriberId,
      prescriptionId: curaleafPrescriptionId,
      purchaseOrder: null,
    };
  }

  return {
    prescriberId,
    prescriptionId: curaleafPrescriptionId,
    purchaseOrder: purchaseOrderResult,
  };
}
