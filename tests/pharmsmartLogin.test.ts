import assert from 'node:assert/strict';
import test from 'node:test';
import { pharmsmartLoginQuery, pharmsmartOnboardingBookingUrl, pharmsmartRedeemNext, rememberPharmsmartLogin, resetPharmsmartLoginNotice } from '../src/auth/pharmsmart-login.ts';

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

test('a welcome redemption stays on the guide and does not open a session', () => {
  const next = pharmsmartRedeemNext({
    status: 'welcome',
    firstName: 'Amina',
    lastName: 'Khan',
    email: 'amina@pharmacy.test',
  });
  assert.equal(next.action, 'welcome');
  assert.equal('customToken' in next, false);
  if (next.action !== 'welcome') return;
  const booking = new URL(pharmsmartOnboardingBookingUrl(next.welcome, {
    embed: true,
    hostname: 'portal.holistichealthhub.live',
  }));
  assert.equal(`${booking.origin}${booking.pathname}`, 'https://calendly.com/spatel-72k/30min');
  assert.equal(booking.searchParams.get('name'), 'Amina Khan');
  assert.equal(booking.searchParams.get('email'), 'amina@pharmacy.test');
  assert.equal(booking.searchParams.get('embed_type'), 'Inline');
  assert.equal(booking.searchParams.get('embed_domain'), 'portal.holistichealthhub.live');
  const fallback = new URL(pharmsmartOnboardingBookingUrl(next.welcome));
  assert.equal(fallback.searchParams.get('embed_type'), null);
  assert.equal(fallback.searchParams.get('name'), 'Amina Khan');
});

test('a ready redemption is the only path that carries a session token', () => {
  assert.deepEqual(pharmsmartRedeemNext({ status: 'ready', customToken: 'custom-1' }), {
    action: 'session',
    customToken: 'custom-1',
  });
  assert.deepEqual(pharmsmartRedeemNext({
    status: 'setup',
    ticket: 'ticket-1',
    missing: ['email'],
    email: null,
    firstName: 'Amina',
    lastName: 'Khan',
  }), { action: 'setup' });
});

test('the invitation notice survives after the token is removed from the address', () => {
  resetPharmsmartLoginNotice();
  assert.equal(rememberPharmsmartLogin(''), false);
  assert.equal(rememberPharmsmartLogin('?token=opaque-token'), true);
  assert.equal(rememberPharmsmartLogin(''), true);
  resetPharmsmartLoginNotice();
});
