import assert from 'node:assert/strict';
import test from 'node:test';

import { HttpError } from '../../domain/common/errors.js';
import {
  assertSerialAvailableForCreate,
  evaluateSerialForCreate,
  serialAvailabilityHttpError,
} from './serial-availability.js';

const NOW = new Date('2026-08-12T12:00:00.000Z');

test('clinic prescriptions skip occupancy and reuse checks', () => {
  assert.deepEqual(evaluateSerialForCreate({
    clinicOwned: true,
    serialNumber: '',
    liveOrderId: 'awaiting-1',
  }), {
    allowed: true,
    reason: 'clinic',
    reusesSourceSerial: false,
  });
});

test('a live awaiting serial blocks a second draft', () => {
  const blocked = evaluateSerialForCreate({
    serialNumber: 'RX-1',
    issueDate: '2026-08-01',
    liveOrderId: 'awaiting-1',
    currentPatientId: 'patient-1',
    asOf: NOW,
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'SERIAL_IN_USE');
  assert.equal(blocked.occupyingOrderId, 'awaiting-1');
});

test('replacement of the occupying source is allowed inside 24 days', () => {
  const allowed = evaluateSerialForCreate({
    serialNumber: 'RX-1',
    issueDate: '2026-08-01',
    sourceSerial: 'RX-1',
    liveOrderId: 'source-1',
    livePatientId: 'patient-1',
    sourceOrderId: 'source-1',
    currentPatientId: 'patient-1',
    asOf: NOW,
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, 'ok');
  assert.equal(allowed.reusesSourceSerial, true);
});

test('replacement reuse expires on day 25', () => {
  assert.equal(evaluateSerialForCreate({
    serialNumber: 'RX-1',
    issueDate: '2026-07-18',
    sourceSerial: 'RX-1',
    liveOrderId: 'source-1',
    sourceOrderId: 'source-1',
    asOf: NOW,
  }).reason, 'SERIAL_REUSE_EXPIRED');
});

test('a new serial on a 26-day-old CD is allowed when it is not a reuse', () => {
  const allowed = evaluateSerialForCreate({
    serialNumber: 'NEW-1',
    issueDate: '2026-07-17',
    asOf: NOW,
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, 'ok');
  assert.equal(allowed.reusesSourceSerial, false);
});

test('availability and create-order map the same occupancy reason', () => {
  const blocked = evaluateSerialForCreate({
    serialNumber: 'RX-1',
    issueDate: '2026-08-01',
    liveOrderId: 'awaiting-1',
    asOf: NOW,
  });
  const error = serialAvailabilityHttpError(blocked);
  assert.equal(error?.code, 'SERIAL_IN_USE');
  assert.equal(error?.statusCode, 409);
});

test('Curaleaf still-live is returned as the same reason used at checkout', async () => {
  const result = await assertSerialAvailableForCreate({
    organisationId: 'org-1',
    serialNumber: 'RX-1',
    issueDate: '2026-08-01',
    findLive: async () => null,
    lookupCuraleaf: async () => {
      throw new HttpError(409, 'live', 'CURALEAF_SERIAL_STILL_LIVE');
    },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'CURALEAF_SERIAL_STILL_LIVE');
  assert.equal(serialAvailabilityHttpError(result)?.code, 'CURALEAF_SERIAL_STILL_LIVE');
});

test('Curaleaf lookup outages fail open after occupancy has passed', async () => {
  const result = await assertSerialAvailableForCreate({
    organisationId: 'org-1',
    serialNumber: 'RX-1',
    issueDate: '2026-08-01',
    findLive: async () => null,
    lookupCuraleaf: async () => {
      throw new HttpError(504, 'timeout', 'CURALEAF_TIMEOUT');
    },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.reason, 'ok');
});
