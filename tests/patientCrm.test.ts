import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampDateInput,
  settleDateInput,
  comparePatientSortValues,
  PATIENT_SORT_DEFAULT_DIRECTION,
  patientSortDirectionLabel,
  directoryStatusMatchesChip,
  enquiryDirectoryStatus,
  referralPeriodApplies,
  patientCrmGroup,
  patientCrmLane,
  patientCrmRecordKey,
  patientCrmStatusMeta,
  recordMatchesPatientFilter,
} from '../src/utils/patientCrm.ts';

const enquiry = {
  kind: 'enquiry' as const,
  journey: 'enquiry' as const,
  hasCrmRecord: false,
  hasOpenOrder: false,
  needsAction: false,
  readyForCollection: false,
};

const active = {
  kind: 'patient' as const,
  journey: 'active' as const,
  hasCrmRecord: true,
  hasOpenOrder: false,
  needsAction: false,
  readyForCollection: false,
};

const onOrder = { ...active, hasOpenOrder: true };
const needsAction = { ...active, hasOpenOrder: true, needsAction: true };
const ready = { ...active, hasOpenOrder: true, readyForCollection: true };
const declined = { ...active, journey: 'declined' as const, hasCrmRecord: true, hasOpenOrder: false };

test('all filter includes enquiries and patients together', () => {
  assert.equal(recordMatchesPatientFilter(enquiry, 'all'), true);
  assert.equal(recordMatchesPatientFilter(active, 'all'), true);
  assert.equal(recordMatchesPatientFilter(declined, 'all'), true);
});

test('status filters keep enquiries and operational patients distinct', () => {
  assert.equal(recordMatchesPatientFilter(enquiry, 'enquiries'), true);
  assert.equal(recordMatchesPatientFilter(active, 'enquiries'), false);
  assert.equal(recordMatchesPatientFilter(active, 'active'), true);
  assert.equal(recordMatchesPatientFilter(enquiry, 'active'), false);
  assert.equal(recordMatchesPatientFilter(onOrder, 'on-order'), true);
  assert.equal(recordMatchesPatientFilter(needsAction, 'needs-action'), true);
  assert.equal(recordMatchesPatientFilter(ready, 'ready'), true);
  assert.equal(recordMatchesPatientFilter(declined, 'declined'), true);
  assert.equal(recordMatchesPatientFilter(active, 'declined'), false);
});

test('board lanes keep new enquiries out of referred and active', () => {
  assert.equal(patientCrmLane(enquiry), 'enquiries');
  assert.equal(patientCrmLane(active), 'care');
  assert.equal(patientCrmLane(needsAction), 'needs-action');
  assert.equal(patientCrmLane(declined), 'declined');
});

test('grouped all-view ranks action, enquiries and care without overlap', () => {
  assert.equal(patientCrmGroup(needsAction), 'needs-action');
  assert.equal(patientCrmGroup(enquiry), 'enquiries');
  assert.equal(patientCrmGroup(ready), 'ready');
  assert.equal(patientCrmGroup(onOrder), 'on-order');
  assert.equal(patientCrmGroup(active), 'care');
  assert.equal(patientCrmGroup(declined), 'declined');
});

test('status copy stays textual for colour-independent reading', () => {
  const meta = patientCrmStatusMeta({ ...enquiry, statusLabel: 'New enquiry' });
  assert.equal(meta.label, 'New enquiry');
  assert.match(meta.description, /HHH/);
  assert.equal(meta.tone, 'info');
  assert.equal(patientCrmRecordKey('patient', 'abc'), 'patient:abc');
});

test('open enquiries are New until HHH records progress, and sit on All and Enquiries', () => {
  assert.equal(enquiryDirectoryStatus('New enquiry'), 'New enquiry');
  assert.equal(enquiryDirectoryStatus('In progress'), 'In progress');
  assert.equal(enquiryDirectoryStatus('Under HHH review'), 'In progress');
  for (const status of ['New enquiry', 'In progress'] as const) {
    assert.equal(directoryStatusMatchesChip(status, 'all'), true);
    assert.equal(directoryStatusMatchesChip(status, 'Enquiries'), true);
    assert.equal(directoryStatusMatchesChip(status, 'Referred'), false);
    assert.equal(directoryStatusMatchesChip(status, 'Declined'), false);
  }
  assert.equal(directoryStatusMatchesChip('Referred', 'Referred'), true);
  assert.equal(directoryStatusMatchesChip('Referred', 'Enquiries'), false);
});

test('declined and withdrawn enquiries both sit under Declined', () => {
  for (const status of ['Declined', 'Withdrawn'] as const) {
    assert.equal(enquiryDirectoryStatus(status), status);
    assert.equal(directoryStatusMatchesChip(status, 'Declined'), true);
    assert.equal(directoryStatusMatchesChip(status, 'Enquiries'), false);
  }
  const closed = { ...enquiry, journey: 'declined' as const };
  assert.equal(patientCrmGroup(closed), 'declined');
  assert.equal(patientCrmStatusMeta({ ...closed, statusLabel: 'Withdrawn' }).label, 'Withdrawn');
  assert.equal(patientCrmStatusMeta({ ...closed, statusLabel: 'Declined' }).label, 'Declined');
});

test('sorting flips direction and keeps blanks at the bottom either way', () => {
  const values = ['2026-03-01', '', '2026-01-01', '2026-02-01'];
  assert.deepEqual([...values].sort((a, b) => comparePatientSortValues(a, b, 'asc')), ['2026-01-01', '2026-02-01', '2026-03-01', '']);
  assert.deepEqual([...values].sort((a, b) => comparePatientSortValues(a, b, 'desc')), ['2026-03-01', '2026-02-01', '2026-01-01', '']);
  assert.equal(PATIENT_SORT_DEFAULT_DIRECTION.name, 'asc');
  assert.equal(PATIENT_SORT_DEFAULT_DIRECTION.referral, 'desc');
  assert.equal(patientSortDirectionLabel('name', 'desc'), 'Z to A');
  assert.equal(patientSortDirectionLabel('payment', 'asc'), 'Oldest first');
});

test('custom range dates never run past today or before the start of records', () => {
  const today = '2026-10-23';
  assert.equal(clampDateInput('2026-10-01', today), '2026-10-01');
  assert.equal(clampDateInput('4566-10-01', today), today);
  assert.equal(clampDateInput('202610-10-23', today), null);
  assert.equal(clampDateInput('', today), '');
  assert.equal(settleDateInput('0202-10-01', '2020-01-01', today), '2020-01-01');
  assert.equal(settleDateInput('2027-01-01', '2020-01-01', today), today);
  assert.equal(settleDateInput('', '2020-01-01', today), '');
});

test('the referral period narrows the Referred tag and no other', () => {
  assert.equal(referralPeriodApplies('Referred'), true);
  for (const chip of ['all', 'Enquiries', 'Active', 'Inactive', 'Declined'] as const) {
    assert.equal(referralPeriodApplies(chip), false);
  }
});

test('list tags follow the queue group and use distinct tones', () => {
  assert.deepEqual(
    { label: patientCrmStatusMeta(needsAction).label, tone: patientCrmStatusMeta(needsAction).tone },
    { label: 'Needs action', tone: 'danger' },
  );
  assert.deepEqual(
    { label: patientCrmStatusMeta(onOrder).label, tone: patientCrmStatusMeta(onOrder).tone },
    { label: 'On order', tone: 'curaleaf-picking' },
  );
  assert.deepEqual(
    { label: patientCrmStatusMeta(active).label, tone: patientCrmStatusMeta(active).tone },
    { label: 'Active', tone: 'paid' },
  );
  assert.equal(patientCrmStatusMeta({ ...onOrder, statusLabel: 'Awaiting payment' }).label, 'Awaiting payment');
  assert.equal(patientCrmStatusMeta({ ...onOrder, statusLabel: 'Awaiting payment' }).tone, 'warning');
});
