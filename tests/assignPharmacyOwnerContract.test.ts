import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const api = readFileSync(new URL('../src/shared/api.ts', import.meta.url), 'utf8');
const adminPortal = readFileSync(new URL('../src/pages/AdminPortal.tsx', import.meta.url), 'utf8');

test('admin staff can assign a pharmacy owner after a setup invite', () => {
  assert.match(api, /\/v1\/portal\/admin\/staff\/\$\{encodeURIComponent\(uid\)\}\/owner/);
  assert.match(adminPortal, /Assign as owner/);
  assert.match(adminPortal, /assignPharmacyOwner/);
});
