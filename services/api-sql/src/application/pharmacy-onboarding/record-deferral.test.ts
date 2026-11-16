import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordPharmacyOnboardingDeferral, type DeferralRepository } from './record-deferral.js';
import type { PharmacyOnboardingDeferralRecord } from '../../domain/pharmacy-onboarding/deferral.js';

function memoryRepo() {
  const rows: PharmacyOnboardingDeferralRecord[] = [];
  const repo: DeferralRepository = {
    async findDeferralByIdempotencyKey(key) {
      return rows.find(row => row.idempotencyKey === key) ?? null;
    },
    async insertDeferral(record) { rows.push(record); },
  };
  return { rows, repo };
}

test('records Not yet with the PharmSmart details, compacting the GPhC', async () => {
  const { rows, repo } = memoryRepo();
  await recordPharmacyOnboardingDeferral(repo, {
    gphcNumber: '  1234 567 ',
    pharmsmartPharmacyId: 'PS-42',
    personName: 'Asha Shah',
    personEmail: 'Asha@Example.com',
    idempotencyKey: 'not-yet-key-1',
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.gphcNumber, '1234567');
  assert.equal(rows[0]?.pharmsmartPharmacyId, 'PS-42');
  assert.equal(rows[0]?.personEmail, 'asha@example.com');
});

test('a retry with the same key records nothing new', async () => {
  const { rows, repo } = memoryRepo();
  const input = { gphcNumber: '1234567', idempotencyKey: 'not-yet-key-2' };
  const first = await recordPharmacyOnboardingDeferral(repo, input);
  const second = await recordPharmacyOnboardingDeferral(repo, input);
  assert.equal(rows.length, 1);
  assert.equal(second.id, first.id);
});

test('empty optional details are stored as null', async () => {
  const { rows, repo } = memoryRepo();
  await recordPharmacyOnboardingDeferral(repo, {
    gphcNumber: '1234567',
    pharmsmartPharmacyId: '',
    personName: '',
    personEmail: '',
    idempotencyKey: 'not-yet-key-3',
  });
  assert.equal(rows[0]?.pharmsmartPharmacyId, null);
  assert.equal(rows[0]?.personName, null);
  assert.equal(rows[0]?.personEmail, null);
});

test('rejects a GPhC that is not a number', async () => {
  const { repo } = memoryRepo();
  await assert.rejects(
    recordPharmacyOnboardingDeferral(repo, { gphcNumber: '--', idempotencyKey: 'not-yet-key-4' }),
    /GPhC/,
  );
});
