import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const integrationRouter = read('../services/api-sql/src/transport/portal/integration.router.ts');
const adminPortal = read('../src/pages/AdminPortal.tsx');
const activation = read('../src/pages/admin/PharmacyActivation.tsx');
const curaleafPanel = read('../src/components/CuraleafConnectionPanel.tsx');

test('a pharmacy goes live only when live Curaleaf credentials are saved, with no manual go-live step', () => {
  assert.match(integrationRouter, /applyCuraleafActivation\(organisationRepo, organisation, restored\.environment\)/);
  assert.doesNotMatch(adminPortal, /AdminGoLivePanel|flipPharmacyLive|goLiveOrganisation/);
  assert.match(adminPortal, /org\.curaleafEnvironment !== 'production'/);
  assert.match(activation, /Test credentials do not activate a pharmacy/);
  assert.match(curaleafPanel, /Replace with live credentials/);
  assert.match(curaleafPanel, /environment: 'PRODUCTION'/);
});
