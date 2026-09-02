import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const panel = readFileSync(new URL('../src/onboarding/AdminGoLivePanel.tsx', import.meta.url), 'utf8');
const readiness = readFileSync(new URL('../services/api-sql/src/domain/organisation/operational-readiness.ts', import.meta.url), 'utf8');
const router = readFileSync(new URL('../services/api-sql/src/transport/portal/setup.router.ts', import.meta.url), 'utf8');

const ACK = 'This pharmacy has been advised not to create or place orders until Curaleaf is switched from test to live under Integrations on Overview.';

test('admin go-live requires the intake call, not Curaleaf production, and warns before a test flip', () => {
  assert.match(panel, /Log intake call/);
  assert.match(panel, /admin-golive-ack/);
  assert.match(panel, new RegExp(ACK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(panel, /acknowledgedCuraleafTest: needsCuraleafAck/);
  assert.doesNotMatch(panel, /Platform walkthrough/);
  assert.doesNotMatch(panel, /Log platform walkthrough/);
  assert.match(readiness, /if \(!intakeCall\) missingGates\.push\('intake_call'\)/);
  assert.doesNotMatch(readiness, /missingGates\.push\('curaleaf_production'\)/);
  assert.doesNotMatch(readiness, /missingGates\.push\('walkthrough'\)/);
  assert.match(readiness, new RegExp(ACK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(router, /acknowledgedCuraleafTest/);
  assert.match(router, /GO_LIVE_CURALEAF_TEST_ACK_REQUIRED/);
});
