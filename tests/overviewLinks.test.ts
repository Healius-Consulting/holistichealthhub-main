import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { demoPatientCensus } from '../src/utils/patientCensus.ts';

const now = new Date('2026-11-18T12:00:00Z');
const patient = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, organisationId: 'org-1', name: id, email: `${id}@example.test`, mobile: '', status: 'Referred', ...overrides,
}) as never;
const order = (patientId: string, date: string) => ({ patientId, organisationId: 'org-1', date: new Date(date), payment: { paidAt: null } }) as never;

test('demo Referred and Active counts come from the demo patients, as the Patients page groups them', () => {
  const census = demoPatientCensus([
    patient('a', { referredAt: '2026-11-03T10:00:00Z' }),
    patient('b', { referredAt: '2026-09-03T10:00:00Z' }),
    patient('c', { status: 'HHH approved' }),
    patient('d', { commercialStatus: 'Inactive' }),
    patient('e', { status: 'Referred' }),
  ], [order('e', '2026-11-10T10:00:00Z'), order('c', '2026-08-01T10:00:00Z')], now);
  // e has an order, so it is Active (as the Patients page shows it), not Referred.
  assert.deepEqual(census, { referredThisMonth: 1, referredAllTime: 2, activeThisMonth: 1, activeAllTime: 2 });
});

test('"this month" is the London month', () => {
  // 23:30 UTC on 31 March is 00:30 BST on 1 April in London: an April referral.
  const census = demoPatientCensus([patient('a', { referredAt: '2026-03-31T23:30:00Z' })], [], new Date('2026-04-02T12:00:00Z'));
  assert.equal(census.referredThisMonth, 1);
  assert.equal(demoPatientCensus([patient('a', { referredAt: '2026-03-31T23:30:00Z' })], [], new Date('2026-03-30T12:00:00Z')).referredThisMonth, 0);
});

test('the Overview pipeline tiles open Orders on the group they count', () => {
  const overview = readFileSync(new URL('../src/pages/PharmacyOverview.tsx', import.meta.url), 'utf8');
  for (const [count, filter] of [['awaitingPayment', 'awaiting-payment'], ['supplierFulfilment', 'awaiting-fulfilment'], ['readyForCollection', 'ready']]) {
    assert.match(overview, new RegExp(`openOrders\\('${filter}'\\)\\}>\\s*<strong>\\{overview\\.summary\\.${count}\\}`), `${count} tile filters to ${filter}`);
  }
  assert.match(overview, /census=\{demoCensus \?\? overview\.patientCensus\}/);
  const orders = readFileSync(new URL('../src/pages/Orders.tsx', import.meta.url), 'utf8');
  for (const filter of ['awaiting-payment', 'awaiting-fulfilment', 'ready']) assert.match(orders, new RegExp(`key: '${filter}'`), `Orders has a ${filter} filter`);
});
