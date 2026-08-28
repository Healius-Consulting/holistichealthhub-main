import assert from 'node:assert/strict';
import test from 'node:test';

import {
  curaleafSerialAllowsCreate,
  evaluateSerialOccupancy,
  prescriptionFileIsUsable,
  replacementSerialPolicy,
  serialReuseIsCurrent,
  serialReuseWindowStatus,
} from './serial-reuse.js';

const NOW = new Date('2026-08-12T12:00:00.000Z');

test('serial reuse is counted from the printed issue date for 0-24 London days inclusive', () => {
  assert.equal(serialReuseWindowStatus('2026-08-12', NOW), 'current');
  assert.equal(serialReuseIsCurrent('2026-07-19', NOW), true);
  assert.equal(serialReuseWindowStatus('2026-07-18', NOW), 'expired');
});

test('days 25-28 keep the CD paper in date but block serial reuse', () => {
  assert.equal(serialReuseWindowStatus('2026-07-15', NOW), 'expired');
});

test('occupancy allows the source replacement and blocks a second live order', () => {
  assert.deepEqual(evaluateSerialOccupancy({}), { allowed: true, reason: 'free' });
  assert.deepEqual(evaluateSerialOccupancy({
    liveOrderId: 'source-1',
    sourceOrderId: 'source-1',
    currentPatientId: 'patient-1',
    livePatientId: 'patient-1',
  }), { allowed: true, reason: 'source_owner', occupyingOrderId: 'source-1' });
  assert.deepEqual(evaluateSerialOccupancy({
    liveOrderId: 'other-1',
    sourceOrderId: 'source-1',
  }), { allowed: false, reason: 'SERIAL_IN_USE', occupyingOrderId: 'other-1' });
});

test('a copied serial after a purchase order is allowed when the window, basket, and file are valid', () => {
  assert.deepEqual(replacementSerialPolicy({
    sourceSerial: 'Test123',
    sourceIssueDate: '2026-08-01',
    sourceOrderId: 'source-1',
    liveOrderId: 'source-1',
    replacementSerial: 'Test123',
    replacementIssueDate: '2026-08-01',
    replacementHasUsableFile: true,
    sourceLines: [{ packId: 'pack-a', quantity: 1, unitsNeededCount: 10 }],
    replacementLines: [{ packId: 'pack-a', quantity: 1, unitsNeededCount: 10 }],
    asOf: NOW,
  }), { allowed: true, reusesSourceSerial: true });
});

test('serial reuse expires on day 25 even with a usable file', () => {
  assert.equal(replacementSerialPolicy({
    sourceSerial: 'Test123',
    sourceIssueDate: '2026-07-18',
    sourceOrderId: 'source-1',
    liveOrderId: 'source-1',
    replacementSerial: 'Test123',
    replacementHasUsableFile: true,
    sourceLines: [{ packId: 'pack-a', quantity: 1 }],
    replacementLines: [{ packId: 'pack-a', quantity: 1 }],
    asOf: NOW,
  }).reason, 'SERIAL_REUSE_EXPIRED');
});

test('a different basket cannot keep the copied serial', () => {
  assert.equal(replacementSerialPolicy({
    sourceSerial: 'Test123',
    sourceIssueDate: '2026-08-01',
    sourceOrderId: 'source-1',
    liveOrderId: 'source-1',
    replacementSerial: 'Test123',
    replacementHasUsableFile: true,
    sourceLines: [{ packId: 'pack-a', quantity: 1 }],
    replacementLines: [{ packId: 'pack-b', quantity: 1 }],
    asOf: NOW,
  }).reason, 'SERIAL_BASKET_MISMATCH');
});

test('a missing scan blocks both copied and new serials', () => {
  assert.equal(replacementSerialPolicy({
    sourceSerial: 'Test123',
    sourceIssueDate: '2026-08-01',
    sourceOrderId: 'source-1',
    liveOrderId: 'source-1',
    replacementSerial: 'Test123',
    replacementHasUsableFile: false,
    sourceLines: [{ packId: 'pack-a', quantity: 1 }],
    replacementLines: [{ packId: 'pack-a', quantity: 1 }],
    asOf: NOW,
  }).reason, 'replacement_prescription_file_required');
});

test('Curaleaf GET by serial only allows a new POST when Rocky is gone or terminal', () => {
  assert.deepEqual(curaleafSerialAllowsCreate({ httpStatus: 404 }), { allowed: true, reason: 'create' });
  assert.deepEqual(curaleafSerialAllowsCreate({ state: 'CANCELLED' }), { allowed: true, reason: 'create' });
  assert.deepEqual(curaleafSerialAllowsCreate({ state: 'ACTIVE' }), { allowed: false, reason: 'CURALEAF_SERIAL_STILL_LIVE' });
  assert.deepEqual(curaleafSerialAllowsCreate({ state: 'PENDING' }), { allowed: false, reason: 'CURALEAF_SERIAL_STILL_LIVE' });
});

test('deleted prescription files are not reusable', () => {
  assert.equal(prescriptionFileIsUsable({ status: 'UPLOADED', deletedAt: null }), true);
  assert.equal(prescriptionFileIsUsable({ status: 'DELETED', deletedAt: null }), false);
  assert.equal(prescriptionFileIsUsable({ status: 'UPLOADED', deletedAt: '2026-08-12T00:00:00.000Z' }), false);
  assert.equal(prescriptionFileIsUsable(null), false);
});
