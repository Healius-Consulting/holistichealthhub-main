import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURALEAF_LIVE_BASE_URL,
  CURALEAF_TEST_BASE_URL,
  curaleafBaseUrl,
  curaleafEnvironmentLabel,
} from './curaleaf.service.js';

test('routes a production pharmacy to the live Curaleaf estate', () => {
  assert.equal(curaleafBaseUrl('PRODUCTION'), CURALEAF_LIVE_BASE_URL);
  assert.equal(curaleafEnvironmentLabel('PRODUCTION'), 'production');
});

test('routes a test pharmacy to the sandbox estate', () => {
  assert.equal(curaleafBaseUrl('TEST'), CURALEAF_TEST_BASE_URL);
  assert.equal(curaleafEnvironmentLabel('TEST'), 'test');
});

test('two pharmacies on different estates resolve to different hosts', () => {
  // The whole point: a sandbox pharmacy keeps working on its own key while a
  // live one talks to production, in the same process and the same poll tick.
  assert.notEqual(curaleafBaseUrl('TEST'), curaleafBaseUrl('PRODUCTION'));
});

test('falls back to sandbox when a connection has no environment recorded', () => {
  assert.equal(curaleafBaseUrl(null), CURALEAF_TEST_BASE_URL);
  assert.equal(curaleafBaseUrl(undefined), CURALEAF_TEST_BASE_URL);
});

test('the live estate is the documented production host', () => {
  assert.equal(CURALEAF_LIVE_BASE_URL, 'https://api.curaleaflaboratories.co.uk');
  assert.equal(CURALEAF_TEST_BASE_URL, 'https://api.curaleaflaboratories.dev');
});
