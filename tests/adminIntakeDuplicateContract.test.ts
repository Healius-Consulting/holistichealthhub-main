import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const intake = readFileSync(new URL('../src/components/AdminIntakeV2.tsx', import.meta.url), 'utf8');
const adminPortal = readFileSync(new URL('../src/pages/AdminPortal.tsx', import.meta.url), 'utf8');
const router = readFileSync(new URL('../services/api-sql/src/transport/portal/intake-v2.router.ts', import.meta.url), 'utf8');

test('every intake queue record and detail carries the other records that look like the same person', () => {
  assert.match(router, /toAdminIntakeQueueItem\(record, duplicatesFor\(record\)\)/);
  assert.match(router, /toAdminIntakeDetail\(record, conditions, names, duplicatesFor\(record\)\)/);
});

test('the intake tags a duplicate with where its other record stands, and opens that record', () => {
  assert.match(intake, /Duplicate · \{onboardingStatusLabel\(record\.duplicateOf\[0\]\.stage\)\}/);
  assert.match(intake, /className="admin-intake-duplicates"/);
  assert.match(intake, />View record<\/button>/);
  assert.match(intake, />Open in queue<\/button>/);
  // The register selects the exact row, not the first row with that email.
  assert.match(adminPortal, /setPendingRegisterKey\(`\$\{match\.organisationId \?\? ''\}:\$\{match\.kind === 'patient' \? match\.id : `sub-\$\{match\.id\}`\}`\)/);
  assert.match(adminPortal, /registerRowKey\(patient\) === pendingRegisterKey \|\| registerPatientKey\(patient\) === pendingRegisterKey/);
});
