import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTENT_SECURITY_POLICY } from '../platform/vercel/security-headers.ts';
import {
  REQUIRED_FIREBASE_CLIENT_VARIABLES,
  assertSurfaceBuildEnvironment,
  invalidSurfaceBuildVariables,
  missingSurfaceBuildVariables,
} from '../platform/vercel/surface-build-environment.mjs';

const configuredEnvironment = Object.fromEntries(REQUIRED_FIREBASE_CLIENT_VARIABLES.map(name => [name, `${name}-value`]));

test('deployment builds require App Check whenever the API security boundary enables it', () => {
  assert.deepEqual(missingSurfaceBuildVariables('portal', configuredEnvironment), ['VITE_FIREBASE_APP_CHECK_SITE_KEY']);
  assert.deepEqual(missingSurfaceBuildVariables('public', configuredEnvironment), ['VITE_FIREBASE_APP_CHECK_SITE_KEY']);
  assert.deepEqual(
    missingSurfaceBuildVariables('portal', { ...configuredEnvironment, VITE_FIREBASE_APP_CHECK_SITE_KEY: 'site-key' }),
    [],
  );
  assert.throws(
    () => assertSurfaceBuildEnvironment('portal', { ...configuredEnvironment, VITE_REQUIRE_APP_CHECK: 'true' }),
    /VITE_FIREBASE_APP_CHECK_SITE_KEY/,
  );
});

test('only the public site and combined portal are deployable surfaces', () => {
  assert.deepEqual(missingSurfaceBuildVariables('admin', {}), []);
  assert.deepEqual(missingSurfaceBuildVariables('pharmacy', {}), []);
  assert.deepEqual(missingSurfaceBuildVariables('portal', {}), [...REQUIRED_FIREBASE_CLIENT_VARIABLES, 'VITE_FIREBASE_APP_CHECK_SITE_KEY']);
});

test('portal builds reject malformed eligibility form URLs before Settings can render', () => {
  assert.deepEqual(invalidSurfaceBuildVariables('portal', { VITE_ELIGIBILITY_FORM_URL: 'not-a-url' }), ['VITE_ELIGIBILITY_FORM_URL']);
  assert.deepEqual(invalidSurfaceBuildVariables('portal', { VITE_ELIGIBILITY_FORM_URL: 'http://example.test/eligibility' }), ['VITE_ELIGIBILITY_FORM_URL']);
  assert.deepEqual(invalidSurfaceBuildVariables('portal', { VITE_ELIGIBILITY_FORM_URL: 'https://holistichealthhub.live/eligibility' }), []);
  assert.throws(
    () => assertSurfaceBuildEnvironment('portal', {
      ...configuredEnvironment,
      VITE_FIREBASE_APP_CHECK_SITE_KEY: 'site-key',
      VITE_ELIGIBILITY_FORM_URL: 'broken-url',
    }),
    /VITE_ELIGIBILITY_FORM_URL/,
  );
});

test('the protected CSP permits only the signed Storage origin needed for uploads', () => {
  const connectDirective = CONTENT_SECURITY_POLICY.split(';').map(value => value.trim()).find(value => value.startsWith('connect-src '));
  assert.ok(connectDirective?.includes('https://storage.googleapis.com'));
  assert.equal(connectDirective?.includes('https://*'), false);
});

test('the protected CSP permits the Ecologi reporting API on the public About page', () => {
  const connectDirective = CONTENT_SECURITY_POLICY.split(';').map(value => value.trim()).find(value => value.startsWith('connect-src '));
  const imgDirective = CONTENT_SECURITY_POLICY.split(';').map(value => value.trim()).find(value => value.startsWith('img-src '));
  assert.ok(connectDirective?.includes('https://public.ecologi.com'));
  assert.equal(imgDirective?.includes('https://api.ecologi.com'), false);
});

test('the protected CSP permits the documented reCAPTCHA Enterprise browser endpoints', () => {
  const directives = CONTENT_SECURITY_POLICY.split(';').map(value => value.trim());
  assert.ok(directives.find(value => value.startsWith('script-src '))?.includes('https://www.gstatic.com/recaptcha/'));
  assert.ok(directives.find(value => value.startsWith('connect-src '))?.includes('https://www.google.com/recaptcha/'));
  assert.ok(directives.find(value => value.startsWith('connect-src '))?.includes('https://content-firebaseappcheck.googleapis.com'));
  assert.ok(directives.find(value => value.startsWith('frame-src '))?.includes('https://recaptcha.google.com/recaptcha/'));
  assert.ok(directives.find(value => value.startsWith('frame-src '))?.includes('https://calendly.com'));
  assert.equal(directives.find(value => value.startsWith('script-src '))?.includes('calendly'), false);
  assert.ok(directives.find(value => value.startsWith('worker-src '))?.includes('blob:'));
});
