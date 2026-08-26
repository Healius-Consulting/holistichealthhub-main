import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupAbandonedPrescriptionFiles, isInactiveOrderDraft } from './cleanup-files.js';

test('marks only drafts inactive for at least 30 days', () => {
  const asOf = new Date('2026-08-26T03:30:00.000Z');
  assert.equal(isInactiveOrderDraft({ status: 'DRAFT', updatedAt: '2026-07-27T03:29:59.000Z' }, asOf), true);
  assert.equal(isInactiveOrderDraft({ status: 'DRAFT', updatedAt: '2026-07-27T03:30:01.000Z' }, asOf), false);
  assert.equal(isInactiveOrderDraft({ status: 'PROMOTED', updatedAt: '2026-01-01T00:00:00.000Z' }, asOf), false);
});

test('protects active and failed-to-abandon draft files while scrubbing stale drafts', async () => {
  const activeFileId = '6410ed3a-0a47-4b1a-94e1-c64a15e0db34';
  const staleFileId = '9c2d91f1-d387-4cb7-b88c-f59e720175d0';
  const failedFileId = '5d315a8f-f783-4c02-a1ae-0b3d8d848f4c';
  const deleted: string[] = [];
  const abandoned: Array<{ id: string; payload: unknown }> = [];

  const result = await cleanupAbandonedPrescriptionFiles({
    prescriptionRepo: {
      listCleanupCandidateFiles: async () => [activeFileId, staleFileId, failedFileId].map(id => ({
        id,
        organisationId: 'org-1',
        status: 'UPLOADED',
        createdAt: '2026-06-01T00:00:00.000Z',
        deletedAt: null,
        storagePath: `rx/${id}`,
      })),
      listLinkedPrescriptionFileIds: async () => [],
      markFileDeleted: async (id: string) => { deleted.push(id); },
    } as any,
    orderRepo: {
      listPaidOpenOrders: async () => [],
      listOpenDrafts: async () => [
        { id: 'active', status: 'DRAFT', updatedAt: '2026-08-25T00:00:00.000Z', payload: { fileId: activeFileId } },
        { id: 'stale', status: 'DRAFT', updatedAt: '2026-07-01T00:00:00.000Z', payload: { fileId: staleFileId } },
        { id: 'failed', status: 'DRAFT', updatedAt: '2026-07-01T00:00:00.000Z', payload: { fileId: failedFileId } },
      ],
      markDraftAbandoned: async (id: string, payload: unknown) => {
        if (id === 'failed') throw new Error('database unavailable');
        abandoned.push({ id, payload });
      },
    } as any,
    storage: { deleteFile: async () => undefined } as any,
  }, new Date('2026-08-26T03:30:00.000Z'));

  assert.deepEqual(deleted, [staleFileId]);
  assert.deepEqual(abandoned.map(row => row.id), ['stale']);
  assert.equal(result.abandonedDrafts, 1);
  assert.equal(result.failedDrafts, 1);
});
