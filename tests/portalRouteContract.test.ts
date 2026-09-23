import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMIN_VIEW_PATHS, isSupportedPortalRelativePath, parseAdminRelativePath } from '@hhh/domain/portal-route';

test('admin routes are explicit and pharmacy details are identifier-scoped', () => {
  for (const [view, path] of Object.entries(ADMIN_VIEW_PATHS)) {
    assert.deepEqual(parseAdminRelativePath(path), { kind: 'view', view });
    assert.equal(isSupportedPortalRelativePath('admin', path), true);
  }
  assert.deepEqual(parseAdminRelativePath('/pharmacy/branch_01-test'), { kind: 'organisation', organisationId: 'branch_01-test' });
  assert.equal(isSupportedPortalRelativePath('admin', '/pharmacy/branch_01-test'), true);
  assert.deepEqual(parseAdminRelativePath('/platform'), { kind: 'view', view: 'overview' });
  assert.equal(isSupportedPortalRelativePath('admin', '/platform'), true);
});

test('pharmacy help contacts is a supported workspace path', () => {
  assert.equal(isSupportedPortalRelativePath('pharmacy', '/contacts'), true);
});

test('unknown, malformed, and cross-surface routes fail closed', () => {
  for (const path of ['/settings', '/orders', '/pharmacy', '/pharmacy/branch/extra', '/pharmacy/%2e%2e', '/anything']) {
    assert.equal(isSupportedPortalRelativePath('admin', path), false, `admin path ${path}`);
  }
  for (const path of ['/platform', '/referrals', '/admin', '/settings/extra', '/anything']) {
    assert.equal(isSupportedPortalRelativePath('pharmacy', path), false, `pharmacy path ${path}`);
  }
});
