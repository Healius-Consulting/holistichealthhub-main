import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'onboarding-emails.router.ts'), 'utf8');

test('the send log and onboarding content are admin-only, and every write is CSRF-protected and audited', () => {
  const routes = [...source.matchAll(/router\.(get|post|put)\('([^']+)', ([^;]*?)async/g)].map(match => ({ method: match[1] ?? '', path: match[2] ?? '', guards: match[3] ?? '' }));
  assert.deepEqual(routes.map(route => `${route.method} ${route.path}`), [
    'get /portal/admin/pharmacy-onboarding-requests/:id/emails',
    'post /portal/admin/pharmacy-onboarding-requests/:id/emails/:kind/resend',
    'get /portal/admin/onboarding-content',
    'put /portal/admin/onboarding-content/:key',
    'post /portal/admin/onboarding-content/preview/:kind',
    'get /portal/admin/email-copy',
    'put /portal/admin/email-copy/:code',
    'post /portal/admin/email-copy/:code/preview',
  ]);
  for (const route of routes) {
    assert.match(route.guards, /requireStaff\('admin'\)/, `${route.path} is admin-only`);
    if (route.method !== 'get') assert.match(route.guards, /^requireCsrf, /, `${route.path} needs CSRF`);
  }
  assert.match(source, /'pharmacy_onboarding\.email_resent'/);
  assert.match(source, /'onboarding_content\.updated'/);
  assert.match(source, /ONBOARDING_CONTENT_SCHEMAS\[key\]\.parse/);
  assert.match(source, /'email_copy\.updated'/);
  assert.match(source, /parseEmailCopy\(code, /, 'saved email wording is validated against the email’s own pieces');
});
