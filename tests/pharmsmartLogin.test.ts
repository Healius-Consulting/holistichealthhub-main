import assert from 'node:assert/strict';
import test from 'node:test';
import { PHARMSMART_ONBOARDING_PACKETS, pharmsmartLoginQuery, pharmsmartOnboardingBookingUrl, pharmsmartRedeemNext, rememberPharmsmartLogin, resetPharmsmartLoginNotice } from '../src/auth/pharmsmart-login.ts';

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

test('the onboarding packets name the brochure and both forms with the values already on them', () => {
  assert.deepEqual(PHARMSMART_ONBOARDING_PACKETS.map(packet => packet.detail), ['Brochure', 'Form', 'Form']);
  const curaleaf = PHARMSMART_ONBOARDING_PACKETS[1];
  assert.match(curaleaf.summary, /ROK0001/);
  assert.match(curaleaf.summary, /7 April 2025/);
  assert.equal('entered' in curaleaf, false);
  const worldpay = PHARMSMART_ONBOARDING_PACKETS[2];
  assert.equal(worldpay.entered.find(item => item.label === 'Nature of business')?.value, '47730 — Dispensing chemist in specialised stores');
  assert.equal(worldpay.entered.find(item => item.label === 'Annual card processing turnover')?.value, '£250,000');
  assert.equal(worldpay.entered.find(item => item.label === 'Average transaction value')?.value, '£187');
  assert.equal(worldpay.entered.find(item => item.label === 'American Express')?.value, 'No');
  assert.equal(worldpay.entered.find(item => item.label === 'Card terminal')?.value, 'Not required');
});

test('the invitation notice survives after the token is removed from the address', () => {
  resetPharmsmartLoginNotice();
  assert.equal(rememberPharmsmartLogin(''), false);
  assert.equal(rememberPharmsmartLogin('?token=opaque-token'), true);
  assert.equal(rememberPharmsmartLogin(''), true);
  resetPharmsmartLoginNotice();
});
