import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const intake = readFileSync(new URL('../src/components/AdminIntakeV2.tsx', import.meta.url), 'utf8');
const router = readFileSync(new URL('../services/api-sql/src/transport/portal/intake-v2.router.ts', import.meta.url), 'utf8');

test('moving an enquiry away from its pharmacy records how the patient agreed', () => {
  // The server refuses a transfer away from an assigned pharmacy without this; the
  // admin form must therefore collect it, or every such move fails with a 409.
  assert.match(router, /record\.assignedOrganisationId && !input\.patientAgreementChannel/);
  assert.match(intake, /patientAgreementChannel: agreementChannel \|\| null/, 'the reassignment request carries the agreement channel');
  assert.match(intake, /movingFromPharmacy = Boolean\(detail\?\.assignedOrganisationId\)/, 'the form asks exactly when the server would refuse');
  assert.match(intake, /\(movingFromPharmacy && !agreementChannel\)/, 'the move button waits for the agreement to be recorded');
  for (const channel of ['phone', 'email', 'sms', 'in_person', 'not_applicable']) {
    assert.match(intake, new RegExp(`<option value="${channel}">`), `the form offers the server's ${channel} channel`);
    assert.match(router, new RegExp(`'${channel}'`), `the server accepts ${channel}`);
  }
});
