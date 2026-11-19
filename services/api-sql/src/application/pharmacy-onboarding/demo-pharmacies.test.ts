import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../../domain/common/errors.js';
import { DEMO_PHARMACIES_KEY, demoGphcNumbersFrom } from '../../domain/pharmacy-onboarding/demo.js';
import { deleteDemoPharmacy, isDemoGphc, type DemoPharmacyRecords, type DemoPharmacyRepository } from './demo-pharmacies.js';

function content(values: Record<string, unknown> = {}) {
  return { async read(keys: string[]) { return Object.fromEntries(keys.filter(k => k in values).map(k => [k, values[k]])); }, async write() {} };
}

function harness(records: Partial<DemoPharmacyRecords> = {}) {
  const deletes: unknown[] = [];
  const removed: string[] = [];
  const repo: DemoPharmacyRepository = {
    async find() {
      return {
        organisations: [{ id: 'org-1', name: 'TEST', status: 'ONBOARDING', createdAt: '2026-11-18T20:23:35Z' }],
        requests: [{ id: 'req-1', pharmacyName: 'TEST', status: 'ACTIVATED', filledFormStoragePath: 'pharmacy-onboarding/req-1/curaleaf-account.pdf', licenceStoragePath: null, createdAt: '2026-11-18T20:17:53Z' }],
        staffUids: ['uid-1'],
        worldpayFiles: ['worldpay-applications/app-1/a.pdf'],
        hasPatientsOrOrders: false,
        ...records,
      };
    },
    async delete(input) { deletes.push(input); return { branches: 1, requests: 1 }; },
  };
  return { repo, deletes, removed, storage: { async deleteFile(path: string) { removed.push(path); } } };
}

describe('demo pharmacies', () => {
  it('defaults to the HHH demo number, and reads an admin list', async () => {
    assert.deepEqual(demoGphcNumbersFrom(undefined), ['9012605']);
    assert.deepEqual(demoGphcNumbersFrom(['1234567', '1234567']), ['1234567']);
    assert.deepEqual(demoGphcNumbersFrom(['not a number']), ['9012605']);
    assert.equal(await isDemoGphc(content(), ' 9012605 '), true);
    assert.equal(await isDemoGphc(content({ [DEMO_PHARMACIES_KEY]: ['1234567'] }), '9012605'), false);
  });

  it('deletes everything for a demo number, files too', async () => {
    const h = harness();
    const result = await deleteDemoPharmacy({ repo: h.repo, content: content(), storage: h.storage }, '9012605');
    assert.deepEqual(h.deletes, [{ gphc: '9012605', organisationIds: ['org-1'], requestIds: ['req-1'], staffUids: ['uid-1'] }]);
    assert.deepEqual(h.removed, ['pharmacy-onboarding/req-1/curaleaf-account.pdf', 'worldpay-applications/app-1/a.pdf']);
    assert.equal(result.files, 2);
  });

  it('never touches a number off the demo list, or a branch with patients or orders', async () => {
    const h = harness();
    await assert.rejects(deleteDemoPharmacy({ repo: h.repo, content: content(), storage: h.storage }, '1099017'), (e: HttpError) => e.code === 'NOT_A_DEMO_PHARMACY');
    const busy = harness({ hasPatientsOrOrders: true });
    await assert.rejects(deleteDemoPharmacy({ repo: busy.repo, content: content(), storage: busy.storage }, '9012605'), (e: HttpError) => e.code === 'DEMO_PHARMACY_IN_USE');
    assert.equal(h.deletes.length + busy.deletes.length, 0);
  });
});
