import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const adminPortal = readFileSync(new URL('../src/pages/AdminPortal.tsx', import.meta.url), 'utf8');
const register = readFileSync(new URL('../services/api-sql/src/transport/portal/patient-register.ts', import.meta.url), 'utf8');

test('the admin register shows the conditions a patient gave on their application', () => {
  // The server puts them on every row, application or patient.
  assert.match(register, /conditions: conditions\.map\(condition => condition\.conditionCode\)/);
  // Re-shaping the selected row on the client must carry them through, not rebuild the row without them.
  const reshaped = adminPortal.match(/const toRegisterRow = useCallback\([\s\S]*?\n  \}, \[state\.organisations\]\);/)?.[0];
  assert.ok(reshaped, 'the register row re-shaper is present');
  assert.match(reshaped, /conditions: 'conditions' in patient \? patient\.conditions/);
  assert.match(reshaped, /primaryCondition: 'primaryCondition' in patient \? patient\.primaryCondition/);
  // The card reads the row as a source, and draws the list even while the record is still an application.
  assert.match(adminPortal, /selectedRegisterPatient\?\.conditions\]/);
  const applicationBranch = adminPortal.match(/\{!adminConditionPatientId \? \([\s\S]*?\) : editingAdminConditions \? \(/)?.[0] ?? '';
  assert.match(applicationBranch, /<ConditionList conditions=\{adminConditions\}/, 'an application still shows its answers');
});
