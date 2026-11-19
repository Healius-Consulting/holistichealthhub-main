import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { partnerTermsFromResponse, partnerTermsParagraphs } from '../src/onboarding/partnerTerms.ts';
import { resolvePublicView } from '../apps/public/src/publicRoute.ts';

test('blank lines split the Terms into paragraphs; single line breaks stay inside one', () => {
  assert.deepEqual(partnerTermsParagraphs('1. Parties\r\nHHH and the pharmacy.\n\n\n  2. Term  \n \n3. Fees'), [
    '1. Parties\nHHH and the pharmacy.',
    '2. Term',
    '3. Fees',
  ]);
  assert.deepEqual(partnerTermsParagraphs('   \n\n  '), []);
});

test('published Terms carry their version; empty text reads as not published', () => {
  assert.deepEqual(partnerTermsFromResponse({ version: ' 1.0 ', text: 'One.\n\nTwo.' }), { state: 'published', version: '1.0', paragraphs: ['One.', 'Two.'] });
  assert.deepEqual(partnerTermsFromResponse({ version: '1.0', text: '  ' }), { state: 'unpublished' });
  assert.deepEqual(partnerTermsFromResponse(null), { state: 'unpublished' });
});

test('/partner-terms is a page of the public site, with its own page component', () => {
  assert.equal(resolvePublicView('/partner-terms', ''), 'site');
  const site = readFileSync(new URL('../apps/public/src/PublicSite.tsx', import.meta.url), 'utf8');
  assert.match(site, /path === '\/partner-terms'\) return <PageShell><PartnerTermsPage \/><\/PageShell>/);
  const page = readFileSync(new URL('../apps/public/src/PartnerTermsPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /The Partner Terms will be published here soon\./);
  assert.match(page, /noindex/);
});
