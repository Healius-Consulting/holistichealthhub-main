import { isAbandonedPrescriptionFile } from '../prescriptions/prescription-file-cleanup.js';
import { prescriptionFileIdsFromSnapshot } from '../prescriptions/prescription-file-purge.js';
import { StorageProvider } from '../../providers/storage/storage.provider.js';
import type { OrderRepositoryPort } from '../../repositories/ports/order.port.js';
import type { PrescriptionRepositoryPort } from '../../repositories/ports/prescription.port.js';

export type FileCleanupDeps = {
  prescriptionRepo: PrescriptionRepositoryPort;
  orderRepo: OrderRepositoryPort;
  storage?: StorageProvider;
};

const INACTIVE_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

export function isInactiveOrderDraft(draft: { status: string; updatedAt: string }, asOf = new Date()) {
  if (draft.status !== 'DRAFT') return false;
  const updatedAt = Date.parse(draft.updatedAt);
  return Number.isFinite(updatedAt) && asOf.getTime() - updatedAt >= INACTIVE_DRAFT_MAX_AGE_MS;
}

export async function cleanupAbandonedPrescriptionFiles(deps: FileCleanupDeps, asOf = new Date()) {
  const [files, linkedFromPrescriptions, paidOrders, openDrafts] = await Promise.all([
    deps.prescriptionRepo.listCleanupCandidateFiles(1_000),
    deps.prescriptionRepo.listLinkedPrescriptionFileIds(2_000),
    deps.orderRepo.listPaidOpenOrders(2_000),
    deps.orderRepo.listOpenDrafts(2_000),
  ]);
  const linked = new Set(linkedFromPrescriptions);
  for (const order of paidOrders) {
    for (const fileId of prescriptionFileIdsFromSnapshot(order.quoteSnapshot)) linked.add(fileId);
  }

  let abandonedDrafts = 0;
  let failedDrafts = 0;
  for (const draft of openDrafts) {
    if (!isInactiveOrderDraft(draft, asOf)) {
      for (const fileId of prescriptionFileIdsFromSnapshot(draft.payload)) linked.add(fileId);
      continue;
    }
    try {
      await deps.orderRepo.markDraftAbandoned(draft.id, {
        lifecycle: {
          status: 'ABANDONED',
          reason: 'inactive_30_days',
          abandonedAt: asOf.toISOString(),
        },
      });
      abandonedDrafts += 1;
    } catch (error) {
      failedDrafts += 1;
      for (const fileId of prescriptionFileIdsFromSnapshot(draft.payload)) linked.add(fileId);
      console.error('Order draft cleanup failed', {
        draftId: draft.id,
        error: error instanceof Error ? error.message : 'Unknown cleanup error',
      });
    }
  }

  const storage = deps.storage ?? new StorageProvider();
  let deleted = 0;
  let retained = 0;
  let failed = 0;
  for (const file of files) {
    if (!isAbandonedPrescriptionFile({
      status: file.status,
      createdAt: file.createdAt ?? '',
      deletedAt: file.deletedAt,
    }, asOf) || linked.has(file.id)) {
      retained += 1;
      continue;
    }
    try {
      if (file.storagePath) await storage.deleteFile(file.storagePath);
      await deps.prescriptionRepo.markFileDeleted(file.id, file.organisationId);
      deleted += 1;
    } catch (error) {
      failed += 1;
      console.error('Prescription file cleanup failed', {
        fileId: file.id,
        error: error instanceof Error ? error.message : 'Unknown cleanup error',
      });
    }
  }
  return {
    checked: files.length,
    linked: linked.size,
    deleted,
    retained,
    failed,
    abandonedDrafts,
    failedDrafts,
  };
}
