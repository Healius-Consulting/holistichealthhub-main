import assert from 'node:assert/strict';
import test from 'node:test';

import { prescriptionFileIdsFromSnapshot } from './prescription-file-purge.js';

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
