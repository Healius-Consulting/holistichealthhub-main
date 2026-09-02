import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { deriveTenantTheme } from '../src/utils/tenantTheme.ts';

const app = readFileSync(new URL('../apps/eligibility/src/EligibilityApp.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const admin = readFileSync(new URL('../src/pages/AdminPortal.tsx', import.meta.url), 'utf8');

test('Eastwood primary derives the secondary shown in brand preview', () => {
  const theme = deriveTenantTheme('#3eb99e');
  assert.equal(theme.primary, '#3eb99e');
  assert.equal(theme.secondary, '#487c98');
  assert.equal(theme.onPrimary, '#07120f');
});

test('pharmacy token eligibility forms remap HHH forest and rust to the derived tenant palette', () => {
  assert.match(app, /pharmacyThemed = Boolean\(token && \(pharmacy \|\| loading\)\)/);
  assert.match(app, /eligibility-shell--tenant/);
  assert.match(css, /\.eligibility-shell--tenant\{[\s\S]*?--green:\s*var\(--tenant-primary-strong\)/);
  assert.match(css, /\.eligibility-shell--tenant\{[\s\S]*?--rust:\s*var\(--tenant-primary\)/);
  assert.match(css, /\.eligibility-shell--tenant \.eligibility-intro\{[\s\S]*?background:\s*var\(--tenant-sidebar\)/);
  assert.match(css, /\.eligibility-shell--tenant \.eligibility-submit:not\(:disabled\)\{[\s\S]*?color:\s*var\(--tenant-on-primary\)/);
});

test('the general HHH eligibility form keeps forest and rust until a pharmacy token is present', () => {
  assert.match(css, /\.eligibility-shell\{[\s\S]*?--green:\s*#173f33/);
  assert.match(css, /\.eligibility-shell\{[\s\S]*?--rust:\s*#a84f35/);
  assert.match(app, /HHH_PUBLIC_IDENTITY[\s\S]*?primaryColour: '#124f3b'/);
});

test('admin brand copy says the palette also reaches the pharmacy eligibility form', () => {
  assert.match(admin, /pharmacy staff portal and on that pharmacy's eligibility form/);
  assert.match(admin, /staff portal and eligibility form/);
  assert.doesNotMatch(admin, /staff portal only/);
});
