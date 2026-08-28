import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatePrescriptionExpiryDate, prescriptionDateIsCurrent, prescriptionDateWindowStatus, prescriptionIssueDateBounds } from './prescription-date.js';
import { normalisePrescriptionDateParts, prescriptionExpiryDisplay, serialReuseDisplay, serialReuseIsCurrent, serialReuseUntilDate, serialReuseWindowStatus } from '../../../packages/domain/prescription-date.js';

const NOW = new Date('2026-08-12T12:00:00.000Z');

test('issue date bounds cover today and the preceding 28 calendar days', () => {
  assert.deepEqual(prescriptionIssueDateBounds(NOW), { min: '2026-07-15', max: '2026-08-12' });
  assert.equal(calculatePrescriptionExpiryDate('2026-07-15'), '2026-08-12');
});

test('the edges of the 28-day prescription window are accepted', () => {
  assert.equal(prescriptionDateIsCurrent('2026-07-15', undefined, NOW), true);
  assert.equal(prescriptionDateIsCurrent('2026-08-12', undefined, NOW), true);
});

test('past and future issue dates are rejected', () => {
  assert.equal(prescriptionDateWindowStatus('2026-07-14', undefined, NOW), 'expired');
  assert.equal(prescriptionDateWindowStatus('2026-08-13', undefined, NOW), 'future');
});

test('a supplied expiry cannot extend a prescription beyond 28 days', () => {
  assert.equal(prescriptionDateWindowStatus('2026-07-15', '2026-08-13', NOW), 'invalid');
  assert.equal(prescriptionDateWindowStatus('2026-07-15', '2026-08-11', NOW), 'expired');
});

test('the current date follows Europe/London around midnight', () => {
  assert.deepEqual(prescriptionIssueDateBounds(new Date('2026-08-11T23:30:00.000Z')), { min: '2026-07-15', max: '2026-08-12' });
});

test('segmented prescription dates accept short parts and normalise to DD/MM/YYYY', () => {
  assert.deepEqual(normalisePrescriptionDateParts('2', '2', '26'), { status: 'valid', value: '2026-02-02', display: '02/02/2026' });
  assert.equal(normalisePrescriptionDateParts('31', '2', '2026').status, 'invalid');
  assert.equal(normalisePrescriptionDateParts('2', '', '2026').status, 'incomplete');
});

test('serial reuse is counted from the printed issue date for 0-24 London days inclusive', () => {
  assert.equal(serialReuseUntilDate('2026-07-19'), '2026-08-12');
  assert.equal(serialReuseWindowStatus('2026-08-12', NOW), 'current');
  assert.equal(serialReuseIsCurrent('2026-07-19', NOW), true);
  assert.equal(serialReuseWindowStatus('2026-07-18', NOW), 'expired');
  assert.equal(serialReuseIsCurrent('2026-07-18', NOW), false);
});

test('days 25-28 stay inside the 28-day CD window but the serial cannot be reused', () => {
  assert.equal(prescriptionDateIsCurrent('2026-07-15', undefined, NOW), true);
  assert.equal(serialReuseWindowStatus('2026-07-15', NOW), 'expired');
  assert.equal(serialReuseDisplay('2026-07-15', NOW)?.tone, 'red');
});

test('a future issue date is not a reusable serial', () => {
  assert.equal(serialReuseWindowStatus('2026-08-13', NOW), 'future');
});

test('expiry display uses the London calendar and green, amber, and red boundaries', () => {
  assert.deepEqual(prescriptionExpiryDisplay('2026-08-12', NOW), { expiryDate: '2026-09-09', daysRemaining: 28, tone: 'green', text: 'Valid until 09 Sept 2026 · 28d left.' });
  assert.equal(prescriptionExpiryDisplay('2026-07-21', NOW)?.tone, 'amber');
  assert.equal(prescriptionExpiryDisplay('2026-07-14', NOW)?.tone, 'red');
  assert.equal(prescriptionExpiryDisplay('2026-07-14', NOW)?.text, 'Expired on 11 Aug 2026 · 1d ago.');
});
