import assert from 'node:assert/strict';
import test from 'node:test';
import { pharmsmartLoginQuery, rememberPharmsmartLogin, resetPharmsmartLoginNotice } from '../src/auth/pharmsmart-login.ts';

test('a Pharmsmart login token is removed and does not replace invitation sign-in', () => {
  const result = pharmsmartLoginQuery('?token=opaque-token&returnTo=%2Fpharmacy');
  assert.equal(result.hasToken, true);
  assert.equal(result.searchWithoutToken, '?returnTo=%2Fpharmacy');
  assert.equal(result.searchWithoutToken.includes('token'), false);
});

test('an ordinary login URL is unchanged', () => {
  assert.deepEqual(pharmsmartLoginQuery(''), { hasToken: false, searchWithoutToken: '' });
  assert.deepEqual(pharmsmartLoginQuery('?returnTo=%2F'), { hasToken: false, searchWithoutToken: '?returnTo=%2F' });
});

test('the invitation notice survives after the token is removed from the address', () => {
  resetPharmsmartLoginNotice();
  assert.equal(rememberPharmsmartLogin(''), false);
  assert.equal(rememberPharmsmartLogin('?token=opaque-token'), true);
  assert.equal(rememberPharmsmartLogin(''), true);
  resetPharmsmartLoginNotice();
});
