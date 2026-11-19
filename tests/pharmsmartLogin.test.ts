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
  assert.deepEqual(next.welcome.prefill, {});
  assert.equal(next.welcome.pharmsmartPharmacyId, null);
  assert.equal(next.welcome.onboardingRequest, null);
  assert.equal(next.welcome.termsRequest, null);
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

test('a welcome redemption carries a pending or on-hold request through to the page', () => {
  for (const state of ['pending', 'on_hold'] as const) {
    const next = pharmsmartRedeemNext({
      status: 'welcome',
      firstName: 'Amina',
      lastName: 'Khan',
      email: 'amina@pharmacy.test',
      gphcNumber: '1234471',
      onboardingRequest: state,
    });
    assert.equal(next.action === 'welcome' && next.welcome.onboardingRequest, state);
  }
});

test('an on-hold welcome carries the merged hold message, and a missing or malformed one becomes null', () => {
  const hold = {
    reason: 'EXISTING_CURALEAF_CUSTOMER' as const,
    heading: 'Your application is on hold',
    paragraphs: ['Curaleaf Laboratories have told us that Shah Pharmacy already has an account with them.'],
    footer: 'Questions? Email onboarding@holistichealthhub.live',
  };
  const welcome = (extra: Record<string, unknown>) => pharmsmartRedeemNext({
    status: 'welcome',
    firstName: 'Amina',
    lastName: 'Khan',
    email: 'amina@pharmacy.test',
    onboardingRequest: 'on_hold',
    ...extra,
  } as Parameters<typeof pharmsmartRedeemNext>[0]);
  const next = welcome({ hold });
  assert.equal(next.action, 'welcome');
  if (next.action !== 'welcome') return;
  assert.deepEqual(next.welcome.hold, hold);
  const missing = welcome({});
  assert.equal(missing.action === 'welcome' && missing.welcome.hold, null);
  const malformed = welcome({ hold: { heading: 'On hold', paragraphs: 'not a list', footer: '' } });
  assert.equal(malformed.action === 'welcome' && malformed.welcome.hold, null);
});

test('a welcome redemption with the Terms outstanding carries the request to resume at', () => {
  const termsRequest = { id: '6c1c5a0e-1a1f-4f43-9d1b-6f7a6f3f0a11', pharmacyName: 'Shah Pharmacy', registeredCompanyName: 'Shah Health Ltd' };
  const next = pharmsmartRedeemNext({
    status: 'welcome',
    firstName: 'Amina',
    lastName: 'Khan',
    email: 'amina@pharmacy.test',
    gphcNumber: '1234471',
    onboardingRequest: 'terms_outstanding',
    termsRequest,
    pharmsmartTicket: 'signed.ticket',
  });
  assert.equal(next.action, 'welcome');
  if (next.action !== 'welcome') return;
  assert.equal(next.welcome.onboardingRequest, 'terms_outstanding');
  assert.deepEqual(next.welcome.termsRequest, termsRequest);
  assert.equal(next.welcome.pharmsmartTicket, 'signed.ticket');
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

test('the onboarding packets are the brochure and the Curaleaf form; Worldpay is an in-app step, not a spreadsheet', () => {
  assert.deepEqual(PHARMSMART_ONBOARDING_PACKETS.map(packet => packet.title), ['Brochure', 'Curaleaf account']);
  assert.deepEqual(PHARMSMART_ONBOARDING_PACKETS.map(packet => packet.detail), ['PDF', 'FORM']);
  assert.match(PHARMSMART_ONBOARDING_PACKETS[1].summary, /Fill this in and submit it here/);
  assert.equal(PHARMSMART_ONBOARDING_PACKETS.some(packet => /\.xlsx$/.test(packet.href)), false);
});

test('the invitation notice survives after the token is removed from the address', () => {
  resetPharmsmartLoginNotice();
  assert.equal(rememberPharmsmartLogin(''), false);
  assert.equal(rememberPharmsmartLogin('?token=opaque-token'), true);
  assert.equal(rememberPharmsmartLogin(''), true);
  resetPharmsmartLoginNotice();
});
