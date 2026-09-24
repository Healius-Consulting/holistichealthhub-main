import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldDispatchSessionEnded } from '../src/shared/sessionEnded.ts';

test('App Check failures and login bootstrap 401s do not end a staff session', () => {
  assert.equal(shouldDispatchSessionEnded(401, 'APP_CHECK_REQUIRED', '/pharmacy'), false);
  assert.equal(shouldDispatchSessionEnded(401, 'WORLDPAY_CREDENTIALS_REJECTED', '/pharmacy'), false);
  assert.equal(shouldDispatchSessionEnded(401, 'CURALEAF_CREDENTIALS_REJECTED', '/pharmacy'), false);
  assert.equal(shouldDispatchSessionEnded(401, 'UNAUTHENTICATED', '/login'), false);
  assert.equal(shouldDispatchSessionEnded(401, 'UNAUTHENTICATED', '/reset-password'), false);
});

test('expired workspace sessions still force a re-login', () => {
  assert.equal(shouldDispatchSessionEnded(401, 'UNAUTHENTICATED', '/pharmacy'), true);
  assert.equal(shouldDispatchSessionEnded(401, 'SESSION_IDLE_EXPIRED', '/admin/orders'), true);
  assert.equal(shouldDispatchSessionEnded(403, 'UNAUTHENTICATED', '/pharmacy'), false);
});
