import { StorageProvider } from '../../providers/storage/storage.provider.js';
import type { PrescriptionRepositoryPort } from '../../repositories/ports/prescription.port.js';
import { SqlPrescriptionRepository } from '../../repositories/sql/prescription.sql.js';

const UUID_LIKE = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

const PRESCRIPTION_FILE_ID_KEYS = new Set([
  'fileId',
  'prescriptionFileId',
  'sourceFileId',
]);

export function prescriptionFileIdsFromRx(rx: unknown): string[] {
  const record = rx && typeof rx === 'object' && !Array.isArray(rx)
    ? rx as Record<string, unknown>
    : {};
  const ids: string[] = [];
  for (const key of PRESCRIPTION_FILE_ID_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && UUID_LIKE.test(value)) ids.push(value);
  }
  return ids;
}

export function prescriptionFileIdsFromSnapshot(snapshot: unknown): string[] {
  const ids = new Set<string>();
  const seen = new Set<object>();
  const pending: Array<{ value: unknown; depth: number }> = [{ value: snapshot, depth: 0 }];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || current.depth > 12 || !current.value || typeof current.value !== 'object') continue;
    if (seen.has(current.value)) continue;
    seen.add(current.value);

    if (Array.isArray(current.value)) {
      for (const value of current.value) pending.push({ value, depth: current.depth + 1 });
      continue;
    }

    for (const [key, value] of Object.entries(current.value as Record<string, unknown>)) {
      if (PRESCRIPTION_FILE_ID_KEYS.has(key) && typeof value === 'string' && UUID_LIKE.test(value)) {
        ids.add(value);
      }
      if (value && typeof value === 'object') pending.push({ value, depth: current.depth + 1 });
    }
  }
  return [...ids];
}

export async function purgePrescriptionFile(
  organisationId: string,
  fileId: string,
  deps?: {
    prescriptionRepo?: PrescriptionRepositoryPort;
    storage?: StorageProvider;
  },
) {
  const prescriptionRepo = deps?.prescriptionRepo ?? new SqlPrescriptionRepository();
  const storage = deps?.storage ?? new StorageProvider();
  const record = await prescriptionRepo.findFileById(fileId, organisationId);
  if (!record) return { purged: false, reason: 'not_found' as const };
  if (record.status === 'DELETED' || record.deletedAt) {
    if (record.storagePath) await storage.deleteFile(record.storagePath);
    return { purged: true, reason: 'already_deleted' as const };
  }
  if (record.storagePath) await storage.deleteFile(record.storagePath);
  await prescriptionRepo.markFileDeleted(fileId, organisationId);
  return { purged: true, reason: 'deleted' as const };
}

export async function purgeOrderPrescriptionFiles(
  organisationId: string,
  snapshot: unknown,
  deps?: {
    prescriptionRepo?: PrescriptionRepositoryPort;
    storage?: StorageProvider;
  },
) {
  const fileIds = prescriptionFileIdsFromSnapshot(snapshot);
  const results = [];
  for (const fileId of fileIds) {
    try {
      results.push({ fileId, ...(await purgePrescriptionFile(organisationId, fileId, deps)) });
    } catch (error) {
      console.warn('[Prescription file] Purge failed:', {
        fileId,
        error: error instanceof Error ? error.message : 'Unknown purge error',
      });
      results.push({ fileId, purged: false, reason: 'failed' as const });
    }
  }
  return results;
}
