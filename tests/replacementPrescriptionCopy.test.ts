import assert from 'node:assert/strict';
import test from 'node:test';
import { replacementPrescriptionCopy, replacementBannerState } from '../src/utils/replacementPrescriptionCopy.ts';
import type { Prescription } from '../src/context/AppContext.tsx';

const source = {
  serialNumber: '15649',
  issueDate: '2026-08-01',
  expiryDate: '2026-08-29',
  fileId: 'file-1',
  copyFileName: 'script.pdf',
  items: [],
} as unknown as Prescription;

test('replacement copies serial, issue date, and file inside the 0-24 day window', () => {
  const copied = replacementPrescriptionCopy(source, new Date('2026-08-12T12:00:00.000Z'));
  assert.equal(copied.serialEligible, true);
  assert.equal(copied.serialNumber, '15649');
  assert.equal(copied.issueDate, '2026-08-01');
  assert.equal(copied.fileId, 'file-1');
  assert.equal(copied.serialInherited, true);
});

test('replacement clears serial after day 24 and still offers a new scan', () => {
  const copied = replacementPrescriptionCopy(source, new Date('2026-08-26T12:00:00.000Z'));
  assert.equal(copied.serialEligible, false);
  assert.equal(copied.serialNumber, undefined);
  assert.equal(copied.fileReusable, true);
  assert.equal(copied.fileId, 'file-1');
});

test('replacement does not copy a missing scan', () => {
  const copied = replacementPrescriptionCopy({ ...source, fileId: undefined, copyFileName: null }, new Date('2026-08-12T12:00:00.000Z'));
  assert.equal(copied.fileReusable, false);
  assert.equal(copied.copyFileName, null);
});

test('replacement banner distinguishes a carried serial from a new scan', () => {
  const carried = replacementBannerState({
    serialInherited: true,
    serialNumber: '15649',
    issueDate: '2026-08-01',
    fileId: 'file-1',
    copyFileName: 'script.pdf',
  }, new Date('2026-08-12T12:00:00.000Z'));
  assert.equal(carried.serialCarried, true);
  assert.equal(carried.scanOnFile, true);
  assert.equal(carried.serialTitle, 'Serial carried forward');
  assert.equal(carried.scanTitle, 'Stored scan kept');

  const expired = replacementBannerState({
    serialInherited: false,
    serialNumber: undefined,
    issueDate: '2026-07-15',
    fileId: undefined,
    copyFileName: null,
  }, new Date('2026-08-12T12:00:00.000Z'));
  assert.equal(expired.serialCarried, false);
  assert.equal(expired.scanOnFile, false);
  assert.equal(expired.serialTitle, 'New serial required');
  assert.equal(expired.scanTitle, 'New scan required');
});
