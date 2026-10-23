import assert from 'node:assert/strict';
import test from 'node:test';
import {
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
