import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const publicSource = readFileSync(join(here, 'pharmacy-onboarding.router.ts'), 'utf8');
const portalSource = readFileSync(join(here, '../portal/pharmacy-onboarding.router.ts'), 'utf8');

test('submitting the onboarding form creates a request, never an organisation', () => {
  const handler = publicSource.match(/router\.post\('\/public\/pharmacy-onboarding-requests',[\s\S]*?router\.post\('\/public\/pharmacy-onboarding-worldpay'/)?.[0];
  assert.ok(handler, 'submission handler is present');
  assert.match(handler, /submitPharmacyOnboardingRequest/);
  assert.match(handler, /queuePharmacyOnboardingSubmitted/);
  for (const forbidden of [/activatePharmacyOnboardingRequest/, /createOrganisation/, /ensureEligibilityLink/, /organisation\.created/]) {
    assert.doesNotMatch(publicSource, forbidden);
  }
});

test('admin decides a request with activate, hold and unhold; the request decline route is gone', () => {
  assert.match(portalSource, /'\/portal\/admin\/pharmacy-onboarding-requests\/:id\/activate'/);
  assert.match(portalSource, /'\/portal\/admin\/pharmacy-onboarding-requests\/:id\/hold'/);
  assert.match(portalSource, /'\/portal\/admin\/pharmacy-onboarding-requests\/:id\/unhold'/);
  assert.doesNotMatch(portalSource, /pharmacy-onboarding-requests\/:id\/decline/);
  for (const route of ['activate', 'hold', 'unhold']) {
    const line = portalSource.split('\n').find(text => text.includes(`/:id/${route}',`));
    assert.ok(line?.includes("requireCsrf, requireStaff('admin')"), `${route} is admin-only and CSRF-protected`);
  }
});
