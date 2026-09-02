import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_PRESCRIPTION_FILE_BYTES,
  contentTypeFromDeclaredType,
  contentTypeFromFilename,
  contentTypeFromSignature,
  isPersistedPrescriptionFileId,
  orderPrescriptionCopyViewable,
  resolvePrescriptionContentType,
} from '../src/utils/prescriptionFile.ts';

test('caps prescription uploads at Curaleaf’s 16 MB limit', () => {
  assert.equal(MAX_PRESCRIPTION_FILE_BYTES, 16_000_000);
});

test('local training file ids are not sent to the prescription-file API', () => {
  assert.equal(isPersistedPrescriptionFileId('3f1c9a2e-6b84-4d11-9c0a-8e7b4d2f1a90'), true);
  assert.equal(isPersistedPrescriptionFileId('training-file-12-3'), false);
  assert.equal(isPersistedPrescriptionFileId(''), false);
  assert.equal(isPersistedPrescriptionFileId(null), false);
});

test('order prescription copies stay viewable until collected, cancelled, or archived', () => {
  assert.equal(orderPrescriptionCopyViewable('3f1c9a2e-6b84-4d11-9c0a-8e7b4d2f1a90', false), true);
  assert.equal(orderPrescriptionCopyViewable('training-file-12-3', false), true);
  assert.equal(orderPrescriptionCopyViewable('3f1c9a2e-6b84-4d11-9c0a-8e7b4d2f1a90', true), false);
  assert.equal(orderPrescriptionCopyViewable('', false), false);
});

test('treats empty or aliased MIME types as PDF when the filename says so', () => {
  assert.equal(contentTypeFromDeclaredType(''), null);
  assert.equal(contentTypeFromDeclaredType('application/x-pdf'), 'application/pdf');
  assert.equal(contentTypeFromFilename('clinic-copy.PDF'), 'application/pdf');
});

test('recognises a PDF header after a UTF-8 BOM', () => {
  assert.equal(
    contentTypeFromSignature(Uint8Array.from([0xef, 0xbb, 0xbf, 0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])),
    'application/pdf',
  );
});

test('uploads a PDF even when the browser leaves File.type empty', async () => {
  const file = new File([Buffer.from('%PDF-1.7\n% prescription')], 'signed-copy.pdf', { type: '' });
  assert.equal(await resolvePrescriptionContentType(file), 'application/pdf');
});

test('rejects a non-PDF that only looks like one by name', async () => {
  const file = new File([Buffer.from('not a prescription')], 'signed-copy.pdf', { type: 'application/pdf' });
  await assert.rejects(
    () => resolvePrescriptionContentType(file),
    /not a valid PDF, JPG or PNG prescription/,
  );
});
