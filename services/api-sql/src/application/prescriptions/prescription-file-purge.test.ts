import assert from 'node:assert/strict';
import test from 'node:test';

import { orphanedPrescriptionFileIds, prescriptionFileIdsFromRx, prescriptionFileIdsFromSnapshot, purgeUnlinkedPrescriptionFileIds, unlinkedPrescriptionFileIds } from './prescription-file-purge.js';

test('finds prescription file references in legacy and nested workflow snapshots', () => {
  const legacyFileId = '6410ed3a-0a47-4b1a-94e1-c64a15e0db34';
  const stagedFileId = '9c2d91f1d3874cb7b88cf59e720175d0';
  const sourceFileId = '5d315a8f-f783-4c02-a1ae-0b3d8d848f4c';

  const ids = prescriptionFileIdsFromSnapshot({
    prescriptions: [{ fileId: legacyFileId }],
    placement: {
      pendingRequest: { prescriptionFileId: stagedFileId },
      clinicalRoute: { sourceFileId },
    },
  });

  assert.deepEqual(new Set(ids), new Set([legacyFileId, stagedFileId, sourceFileId]));
});

test('ignores unrelated ids, malformed values and deeply nested untrusted data', () => {
  const validFileId = 'cb510ad1-cfab-49f0-a6c8-4f4a5374d73c';
  const tooDeep: Record<string, unknown> = { prescriptionFileId: validFileId };
  let nested: Record<string, unknown> = tooDeep;
  for (let index = 0; index < 14; index += 1) nested = { child: nested };

  assert.deepEqual(prescriptionFileIdsFromSnapshot({
    orderId: validFileId,
    fileId: 'not-a-uuid',
    nested,
  }), []);
});

test('deduplicates file references and tolerates cyclic payloads', () => {
  const fileId = '1c8ea72d-f8a6-4c74-859b-414980d68819';
  const snapshot: Record<string, unknown> = {
    prescriptions: [{ fileId }, { fileId }],
    workflow: { prescriptionFileId: fileId },
  };
  snapshot.self = snapshot;

  assert.deepEqual(prescriptionFileIdsFromSnapshot(snapshot), [fileId]);
});

test('keeps only the file ids that belong to one prescription', () => {
  const fileA = '6410ed3a-0a47-4b1a-94e1-c64a15e0db34';
  const fileB = '9c2d91f1-d387-4cb7-b88c-f59e720175d0';
  assert.deepEqual(prescriptionFileIdsFromRx({ fileId: fileA, other: fileB }), [fileA]);
  assert.deepEqual(prescriptionFileIdsFromRx({ fileId: 'not-a-uuid' }), []);
});

test('orphanedPrescriptionFileIds only returns files dropped from the next snapshot', () => {
  const kept = '7e1c0c6a-4b1f-4d2a-9f3c-2a8b6d4e1c90';
  const dropped = 'c2a91f0b-8e34-4a17-b6d1-9f0c5a7e2b14';
  assert.deepEqual(orphanedPrescriptionFileIds(
    { prescriptions: [{ fileId: kept }, { fileId: dropped }] },
    { prescriptions: [{ fileId: kept }] },
  ), [dropped]);
  assert.deepEqual(orphanedPrescriptionFileIds(
    { prescriptions: [{ fileId: kept }] },
    { prescriptions: [{ fileId: kept }] },
  ), []);
});

test('unlinkedPrescriptionFileIds keeps files still attached to a live prescription', () => {
  const draftOnly = '7e1c0c6a-4b1f-4d2a-9f3c-2a8b6d4e1c90';
  const onOrder = 'c2a91f0b-8e34-4a17-b6d1-9f0c5a7e2b14';
  assert.deepEqual(unlinkedPrescriptionFileIds([draftOnly, onOrder], [onOrder]), [draftOnly]);
});

test('purgeUnlinkedPrescriptionFileIds does not delete a copy still on a live prescription', async () => {
  const draftOnly = '7e1c0c6a-4b1f-4d2a-9f3c-2a8b6d4e1c90';
  const onOrder = 'c2a91f0b-8e34-4a17-b6d1-9f0c5a7e2b14';
  const purged: string[] = [];

  await purgeUnlinkedPrescriptionFileIds('org-1', [draftOnly, onOrder], {
    prescriptionRepo: {
      listPrescriptionIdsByFileId: async (fileId: string) => fileId === onOrder ? ['rx-1'] : [],
      findFileById: async (id: string) => ({
        id,
        organisationId: 'org-1',
        patientId: null,
        storagePath: `rx/${id}`,
        originalFilename: 'copy.pdf',
        contentType: 'application/pdf',
        sizeBytes: 12,
        status: 'UPLOADED',
        verifiedAt: null,
        deletedAt: null,
      }),
      markFileDeleted: async (id: string) => {
        purged.push(id);
        return true;
      },
    } as never,
    storage: { deleteFile: async () => undefined } as never,
  });

  assert.deepEqual(purged, [draftOnly]);
});
