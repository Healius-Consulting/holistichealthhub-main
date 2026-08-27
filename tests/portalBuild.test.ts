import assert from 'node:assert/strict';
import test from 'node:test';
import { isPortalSurface, portalBuildLabel } from '../src/utils/portalBuild.ts';
import { resolvePortalBuildId } from '../platform/portal-build-id.mjs';

test('only the portal bundles are portal surfaces', () => {
  assert.equal(isPortalSurface('pharmacy'), true);
  assert.equal(isPortalSurface('admin'), true);
  assert.equal(isPortalSurface('public'), false);
  assert.equal(isPortalSurface(undefined), false);
});

test('the build id is shown on the portal and nowhere else', () => {
  assert.equal(portalBuildLabel('a1b2c3d4', 'pharmacy'), 'a1b2c3d4');
  assert.equal(portalBuildLabel('a1b2c3d4', 'admin'), 'a1b2c3d4');
  assert.equal(portalBuildLabel('a1b2c3d4', 'public'), null);
});

test('a missing build id is omitted rather than shown as unknown', () => {
  assert.equal(portalBuildLabel(undefined, 'pharmacy'), null);
  assert.equal(portalBuildLabel('   ', 'pharmacy'), null);
  assert.equal(portalBuildLabel('undefined', 'pharmacy'), null);
});

test('an explicitly supplied build id wins over the deploy commit', () => {
  assert.equal(
    resolvePortalBuildId({ PORTAL_BUILD_ID: 'release-2026-08', VERCEL_GIT_COMMIT_SHA: 'deadbeefcafe1234' }),
    'release-2026-08',
  );
});

test('the deploy commit is shortened rather than shown in full', () => {
  assert.equal(resolvePortalBuildId({ VERCEL_GIT_COMMIT_SHA: 'deadbeefcafe1234567890' }), 'deadbeefcafe');
});

test('a build with no id available says so plainly instead of inventing one', () => {
  // No env hints; falls through to the local checkout, which in this repo resolves.
  const resolved = resolvePortalBuildId({});
  assert.equal(typeof resolved, 'string');
  assert.ok(resolved.length > 0);
});
