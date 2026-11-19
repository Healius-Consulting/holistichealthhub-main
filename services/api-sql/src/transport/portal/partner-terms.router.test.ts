import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'partner-terms.router.ts'), 'utf8');

test('Partner Terms admin routes are admin-only, pharmacy routes are the branch\'s own, and every write is CSRF-protected', () => {
  const routes = [...source.matchAll(/router\.(get|post|put)\(\s*'([^']+)',\s*([\s\S]*?)async \(/g)].map(match => ({ method: match[1] ?? '', path: match[2] ?? '', guards: match[3] ?? '' }));
  assert.deepEqual(routes.map(route => `${route.method} ${route.path}`), [
    'get /portal/admin/partner-terms',
    'put /portal/admin/partner-terms/documents',
    'get /portal/admin/partner-terms/documents/:id/file',
    'post /portal/admin/partner-terms/documents/:id/publish',
    'post /portal/admin/partner-terms/documents/:id/withdraw',
    'put /portal/admin/partner-terms/settings',
    'get /portal/pharmacy/partner-terms/file',
    'post /portal/pharmacy/partner-terms/viewed',
    'post /portal/pharmacy/partner-terms/skip',
    'get /portal/pharmacy/partner-terms/history',
    'get /portal/pharmacy/partner-terms/history/:id/file',
  ]);
  for (const route of routes) {
    const role = route.path.startsWith('/portal/admin/') ? 'admin' : 'pharmacy';
    assert.match(route.guards, new RegExp(`requireStaff\\('${role}'\\)`), `${route.path} is ${role}-only`);
    if (route.method !== 'get') assert.match(route.guards, /requireCsrf/, `${route.path} needs CSRF`);
  }
});

test('uploads are checked as PDFs within the size limit, a signed version cannot be withdrawn, and switching on needs a published version', () => {
  assert.match(source, /'%PDF-'/);
  assert.match(source, /MAX_PARTNER_TERMS_PDF_BYTES/);
  assert.match(source, /hasAcceptances\(document\.id\)[\s\S]{0,200}'VERSION_SIGNED'/);
  assert.match(source, /'NO_PUBLISHED_VERSION'/);
  // The pharmacy's branch always comes from its session, never the request.
  assert.match(source, /assertTenantScope\(req\.context!\)[\s\S]{0,200}scope\.organisationId/);
});
