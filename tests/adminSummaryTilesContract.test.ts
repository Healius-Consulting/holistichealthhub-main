import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
const adminPortal = readFileSync(new URL('../src/pages/AdminPortal.tsx', import.meta.url), 'utf8');
const adminIntake = readFileSync(new URL('../src/components/AdminIntakeV2.tsx', import.meta.url), 'utf8');

test('admin summary metrics sit in the four-up tile row, not a one-column stack', () => {
  assert.match(css, /\.order-crm-summary__tiles\{[\s\S]*?repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  for (const label of [
    'Pharmacy portfolio summary',
    'Patient register summary',
    'Referral finance summary',
    'HHH intake summary',
  ]) {
    const source = label === 'HHH intake summary' ? adminIntake : adminPortal;
    const block = source.match(new RegExp(`aria-label="${label}"[\\s\\S]{0,220}`));
    assert.ok(block, `missing ${label}`);
    assert.match(block[0], /order-crm-summary__tiles/);
  }
});
