import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const adminPortal = readFileSync(new URL('../src/pages/AdminPortal.tsx', import.meta.url), 'utf8');
const register = readFileSync(new URL('../services/api-sql/src/transport/portal/patient-register.ts', import.meta.url), 'utf8');

test('the register holds patients and closed applications, withdrawn ones included', () => {
  assert.match(register, /outcomeStatus === 'WITHDRAWN'\) return 'Withdrawn'/);
  assert.match(register, /if \(!stage\) continue;/, 'an open application is left to the intake queue');
});

test('the stage filter is a fixed list with counts, not a list built from the rows on screen', () => {
  assert.match(adminPortal, /const REGISTER_STAGES = \['HHH approved', 'Referred', 'Suspended', 'Declined', 'Withdrawn'\] as const;/);
  assert.match(adminPortal, /\{REGISTER_STAGES\.map\(stage => \(/);
  assert.doesNotMatch(adminPortal, /displayedPatients\.map\(patient => patient\.stage\)/, 'stage buttons no longer disappear when a stage is selected');
  // Counts come from the server's scope counts, so each button says what it would show.
  assert.match(register, /scopeCounts: \[\.\.\.countsByKey\.values\(\)\]/);
  assert.match(adminPortal, /const activeCount = stageCounts\['HHH approved'\] \?\? 0;/);
  assert.match(adminPortal, /<span>\{onboardingStatusLabel\(stage\)\}<\/span><strong>\{stageCounts\[stage\] \?\? 0\}<\/strong>/);
});

test('the register says in words what it is showing', () => {
  assert.match(adminPortal, /className="admin-register-crm__scope" aria-live="polite"/);
  assert.match(adminPortal, /<small>Last updated from<\/small>/);
  assert.match(adminPortal, /<small>Pharmacy<\/small>/);
});
