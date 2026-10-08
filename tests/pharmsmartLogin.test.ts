import assert from 'node:assert/strict';
import test from 'node:test';
import { pharmsmartLoginQuery, rememberPharmsmartLogin, resetPharmsmartLoginNotice } from '../src/auth/pharmsmart-login.ts';

test('a Pharmsmart login keeps only the opaque token and removes it from the address', () => {
  const result = pharmsmartLoginQuery('?token=opaque-token&returnTo=%2Fpharmacy&email=person@pharmacy.test&name=Sylvia');
  assert.equal(result.token, 'opaque-token');
  assert.equal(result.hasToken, true);
  assert.equal(result.searchWithoutToken.includes('token='), false);
  assert.match(result.searchWithoutToken, /returnTo=%2Fpharmacy/);
  assert.match(result.searchWithoutToken, /email=person%40pharmacy\.test/);
  assert.match(result.searchWithoutToken, /name=Sylvia/);
  assert.equal(result.searchWithoutToken.includes('token'), false);
  assert.equal('email' in result, false);
  assert.equal('name' in result, false);
});

test('email and name without a token are not a PharmSmart login', () => {
  const result = pharmsmartLoginQuery('?email=person@pharmacy.test&name=Sylvia');
  assert.equal(result.hasToken, false);
  assert.equal(result.token, '');
});

test('an ordinary login URL is unchanged', () => {
  assert.deepEqual(pharmsmartLoginQuery(''), { token: '', hasToken: false, searchWithoutToken: '' });
  assert.deepEqual(pharmsmartLoginQuery('?returnTo=%2F'), { token: '', hasToken: false, searchWithoutToken: '?returnTo=%2F' });
});

test('the invitation notice survives after the token is removed from the address', () => {
  resetPharmsmartLoginNotice();
  assert.equal(rememberPharmsmartLogin(''), false);
  assert.equal(rememberPharmsmartLogin('?token=opaque-token'), true);
  assert.equal(rememberPharmsmartLogin(''), true);
  resetPharmsmartLoginNotice();
});
