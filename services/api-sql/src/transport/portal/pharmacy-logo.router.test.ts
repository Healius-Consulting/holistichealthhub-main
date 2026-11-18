import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'pharmacy.router.ts'), 'utf8');

function handler(method: string, path: string) {
  const start = source.indexOf(`router.${method}('${path}',`);
  assert.ok(start >= 0, `${method.toUpperCase()} ${path} exists`);
  const next = source.indexOf('router.', start + 10);
  return source.slice(start, next < 0 ? undefined : next);
}

test('a pharmacy can read, upload and remove its own logo, and only its own', () => {
  const routes = [
    handler('get', '/portal/organisation/logo'),
    handler('post', '/portal/organisation/logo/upload-url'),
    handler('post', '/portal/organisation/logo/complete'),
    handler('delete', '/portal/organisation/logo'),
  ];
  for (const route of routes) {
    assert.match(route, /requireStaff\('pharmacy'\)/);
    // The branch is always the session's: never a request parameter or body field.
    assert.match(route, /assertTenantScope\(req\.context!\)/);
    assert.match(route, /scope\.organisationId/);
    assert.doesNotMatch(route, /req\.params|organisationId: z\.|req\.query/);
  }
  for (const write of routes.slice(1)) {
    assert.match(write, /requireCsrf, requireStaff\('pharmacy'\)/);
    assert.match(write, /appendAudit/);
  }
});

test('the upload is checked server-side before it becomes the logo', () => {
  assert.match(handler('post', '/portal/organisation/logo/upload-url'), /authoriseBrandLogoUpload\(storage, scope\.organisationId/);
  assert.match(handler('post', '/portal/organisation/logo/complete'), /completeBrandLogoUpload\(storage, scope\.organisationId, input\.storagePath\)/);
  // Reading hands out a short-lived link only.
  assert.match(handler('get', '/portal/organisation/logo'), /resolveOrganisationLogo\(storage, scope\.organisationId, 15 \* 60\)/);
});
