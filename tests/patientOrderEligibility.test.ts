import assert from 'node:assert/strict';
import test from 'node:test';
import { canCreateOrderForPatient, canLinkPatientOnOrderDraft } from '../src/utils/patientOrderEligibility.ts';

const referred = { id: 'patient-1', status: 'Referred' as const, referralSource: 'future_pharmacy_qr' };
const sandbox = { id: 'training-1', status: 'Referred' as const, referralSource: 'training_sandbox' };
const suspended = { id: 'patient-2', status: 'Suspended' as const, referralSource: 'future_pharmacy_qr' };

test('referred patients can be ordered once the workspace is live', () => {
  assert.equal(canCreateOrderForPatient(referred), true);
  assert.equal(canLinkPatientOnOrderDraft(referred, true), true);
});

test('pre-live workspaces do not attach real referred patients to local drafts', () => {
  assert.equal(canLinkPatientOnOrderDraft(referred, false), false);
  assert.equal(canLinkPatientOnOrderDraft(sandbox, false), true);
  assert.equal(canLinkPatientOnOrderDraft(suspended, true), false);
});
