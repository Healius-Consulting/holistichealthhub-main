import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const panel = readFileSync(new URL('../src/onboarding/AdminGoLivePanel.tsx', import.meta.url), 'utf8');
const readiness = readFileSync(new URL('../services/api-sql/src/domain/organisation/operational-readiness.ts', import.meta.url), 'utf8');

test('admin go-live has two gates: intake call and Curaleaf production', () => {
  assert.match(panel, /Log intake call/);
  assert.match(panel, /Activate production credentials in the Curaleaf panel/);
  assert.doesNotMatch(panel, /Platform walkthrough/);
  assert.doesNotMatch(panel, /Log platform walkthrough/);
  assert.match(readiness, /if \(!intakeCall\) missingGates\.push\('intake_call'\)/);
  assert.match(readiness, /if \(!curaleafProduction\) missingGates\.push\('curaleaf_production'\)/);
  assert.doesNotMatch(readiness, /missingGates\.push\('walkthrough'\)/);
});
