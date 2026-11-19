import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PARTNERSHIP_LOGOS, PHARMACY_ONBOARDING_PITCH, PHARMSMART_LOGIN_URL } from '../src/auth/pharmsmart-login.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('there is no public Partner Terms page: the PDF is only shown in sign-up and the portal', () => {
  const site = read('../apps/public/src/PublicSite.tsx');
  assert.doesNotMatch(site, /partner-terms|PartnerTermsPage/);
});

test('the onboarding page copy follows the 19 Nov 2026 brief', () => {
  assert.equal(PHARMACY_ONBOARDING_PITCH.lede, 'Holistic Health Hub is a private medical cannabis service that runs through your pharmacy.');
  assert.deepEqual(PHARMACY_ONBOARDING_PITCH.steps.slice(3), [
    { title: 'Payment and ordering', body: 'You send the patient a payment link. Stock is ordered once they pay.' },
    { title: 'Dispense and collect', body: 'You dispense, and the patient collects from your pharmacy each month.' },
  ]);
  assert.equal(PHARMSMART_LOGIN_URL, 'https://pharmsmart.co.uk/login.php');
  assert.deepEqual(PARTNERSHIP_LOGOS.map(logo => logo.alt), ['Curaleaf', 'Pharmsmart']);
  const guide = read('../src/auth/PharmsmartOnboardingGuide.tsx');
  assert.match(guide, /Pharmsmart user\? Open from your <a[^>]*>Pharmsmart dashboard<\/a>/);
  assert.match(guide, /Not on Pharmsmart\? \{signIn\}/);
  assert.match(guide, /In partnership with/);
});

test('the Partner Terms step only shows in sign-up while HHH has the Terms switched on', () => {
  const guide = read('../src/auth/PharmsmartOnboardingGuide.tsx');
  assert.match(guide, /\{setup\.termsRequired \? \(\s*<li/);
  assert.match(guide, /of \{setup\.termsRequired \? 3 : 2\} done/);
});
