import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../apps/eligibility/src/EligibilityApp.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const contracts = readFileSync(new URL('../src/shared/contracts.ts', import.meta.url), 'utf8');

test('pharmacy eligibility headers centre the uploaded logo at the shared email size', () => {
  assert.match(contracts, /logoUrl\?: string \| null;/);
  assert.match(app, /eligibility-brand__pharmacy-logo/);
  assert.match(app, /EMAIL_LOGO_SPEC/);
  assert.match(css, /\.eligibility-brand--pharmacy-logo \.eligibility-brand__inner\{[\s\S]*?minmax\(0,\s*1fr\) auto minmax\(0,\s*1fr\)/);
  assert.match(css, /\.eligibility-brand__pharmacy-logo\{[\s\S]*?object-fit:\s*contain/);
});
