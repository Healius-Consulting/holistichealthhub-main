import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../apps/eligibility/src/EligibilityApp.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const contracts = readFileSync(new URL('../src/shared/contracts.ts', import.meta.url), 'utf8');

test('pharmacy eligibility headers centre the uploaded logo at header height', () => {
  assert.match(contracts, /logoUrl\?: string \| null;/);
  assert.match(app, /eligibility-brand__pharmacy-logo/);
  assert.match(app, /EMAIL_LOGO_SPEC/);
  assert.match(css, /\.eligibility-brand--pharmacy-logo \.eligibility-brand__inner\{[\s\S]*?minmax\(0,\s*560px\)/);
  assert.match(css, /\.eligibility-brand__pharmacy-logo\{[\s\S]*?height:\s*88px/);
  assert.match(css, /\.eligibility-brand__pharmacy-logo\{[\s\S]*?object-fit:\s*contain/);
});

test('QR eligibility keeps the HHH mark and opens the public site in a new tab', () => {
  assert.match(app, /src=\{HHH_MARK\}/);
  assert.doesNotMatch(app, /eligibility-brand__identity" aria-hidden="true"/);
  assert.match(app, /More info/);
  assert.match(app, /https:\/\/holistichealthhub\.live/);
  assert.match(app, /target="_blank"/);
  assert.match(app, /rel="noopener noreferrer"/);
  assert.match(app, /opens in a new tab/);
});
