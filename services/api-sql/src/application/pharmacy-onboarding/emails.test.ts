import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromAddressFor, renderEmailTemplate, replyToFor } from '../notifications/email-catalog.js';

test('the five partner onboarding emails come from, and by default reply to, onboarding@', () => {
  for (const code of ['pharmacy_onboarding_submitted', 'pharmacy_onboarding_held', 'pharmacy_onboarding_activated', 'pharmacy_onboarding_live', 'curaleaf_new_account_application'] as const) {
    assert.equal(fromAddressFor(code), 'onboarding@holistichealthhub.live');
    assert.equal(replyToFor(code), 'onboarding@holistichealthhub.live');
  }
});

test('an onboarding email renders the subject and paragraphs merged when it was queued, headings in bold', () => {
  const rendered = renderEmailTemplate('curaleaf_new_account_application', {
    subject: 'New account application: Shah Pharmacy, GPhC 1234567',
    paragraphs: ['Hello,', 'Please find attached a new account application from Shah Pharmacy.', 'Once the account is open', 'Kind regards,\nPartner Onboarding, Holistic Health Hub'],
  });
  assert.equal(rendered.subject, 'New account application: Shah Pharmacy, GPhC 1234567');
  assert.equal(rendered.text, 'Hello,\n\nPlease find attached a new account application from Shah Pharmacy.\n\nOnce the account is open\n\nKind regards,\nPartner Onboarding, Holistic Health Hub');
  assert.match(rendered.html, /<strong>Once the account is open<\/strong>/);
  assert.match(rendered.html, /Kind regards,<br>Partner Onboarding/);
});

test('an onboarding email shows only its merged wording, never other payload fields', () => {
  const rendered = renderEmailTemplate('pharmacy_onboarding_held', {
    subject: 'Your Holistic Health Hub application for Shah Pharmacy is on hold',
    paragraphs: ['We need some more information before your account can be opened.'],
    note: 'Secret admin note',
  });
  assert.equal(`${rendered.subject}${rendered.text}${rendered.html}`.includes('Secret admin note'), false);
});
