import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { beforeEach } from 'node:test';
import { DemoModeWriteError, assertNotDemoWrite, demoNetworkGuardActive } from '../src/shared/demoGuard.ts';

type DemoModule = typeof import('../src/training/demoMode.ts');

/** A fresh copy of the demo module stands in for a page refresh: memory is gone, sessionStorage is not. */
let loads = 0;
async function loadPage(): Promise<DemoModule> {
  loads += 1;
  return import(`../src/training/demoMode.ts?page=${loads}`) as Promise<DemoModule>;
}

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.has(key) ? this.values.get(key)! : null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  get length() { return this.values.size; }
}

let tab: MemoryStorage;
function useStorage(storage: unknown) {
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => storage });
}
function blockStorage() {
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => { throw new Error('SecurityError: storage blocked'); } });
}

const organisationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const frozen = new Date('2026-11-18T09:00:00.000Z');
const owner = { uid: 'staff-1', session: '2026-11-18T17:00:00.000Z' };

beforeEach(() => {
  tab = new MemoryStorage();
  useStorage(tab);
});

test('turning Demo mode on and off', async () => {
  const page = await loadPage();
  assert.equal(page.isDemoActive(), false);

  page.enterDemo(owner);
  assert.equal(page.isDemoActive(), true);
  assert.equal(demoNetworkGuardActive(), true);
  assert.ok(tab.getItem(page.DEMO_STORAGE_KEY), 'demo is remembered for this tab');

  page.leaveDemo();
  assert.equal(page.isDemoActive(), false);
  assert.equal(demoNetworkGuardActive(), false);
  assert.equal(tab.getItem(page.DEMO_STORAGE_KEY), null, 'Return to live deletes the demo changes');
});

test('a refresh keeps demo on with the changes made so far', async () => {
  const before = await loadPage();
  before.enterDemo(owner);
  const data = before.startingDemoData(organisationId, frozen);
  const firstPatient = data.crm[0];
  const changed = {
    ...data,
    crm: [{ ...firstPatient, interactions: [...(firstPatient.interactions ?? []), { ts: frozen, type: 'Note', detail: 'Called the patient' }] }, ...data.crm.slice(1)],
    activeOrderId: data.orders[0].id,
  };
  before.saveDemo(changed);

  const after = await loadPage();
  assert.equal(after.isDemoActive(), false, 'nothing in memory survives a refresh');
  const resumed = after.resumeDemo(owner);
  assert.ok(resumed && resumed !== 'starting');
  assert.equal(after.isDemoActive(), true);
  assert.equal(demoNetworkGuardActive(), true);
  assert.equal(resumed.activeOrderId, data.orders[0].id);
  const interactions = resumed.crm[0].interactions ?? [];
  const note = interactions[interactions.length - 1];
  assert.ok(note.ts instanceof Date, 'interaction dates come back as dates');
  assert.equal(note.ts.toISOString(), frozen.toISOString());
  assert.equal(resumed.orders.length, data.orders.length);
  after.leaveDemo();
});

test('a refresh before any change resumes the starting demo data', async () => {
  const before = await loadPage();
  before.enterDemo(owner);
  const after = await loadPage();
  assert.equal(after.resumeDemo(owner), 'starting');
  after.leaveDemo();
});

test('logout ends demo and deletes its changes; the next sign-in opens the real account', async () => {
  const page = await loadPage();
  page.enterDemo(owner);
  page.saveDemo(page.startingDemoData(organisationId, frozen));

  page.leaveDemo(); // logout
  assert.equal(tab.getItem(page.DEMO_STORAGE_KEY), null);
  const nextSignIn = await loadPage();
  assert.equal(nextSignIn.resumeDemo({ ...owner, session: '2026-11-18T18:00:00.000Z' }), null);
  assert.equal(nextSignIn.isDemoActive(), false);
  assert.equal(demoNetworkGuardActive(), false);
});

test('a new sign-in never resumes an old demo left in the tab', async () => {
  const page = await loadPage();
  page.enterDemo(owner);
  page.saveDemo(page.startingDemoData(organisationId, frozen));

  const afterSignIn = await loadPage();
  assert.equal(afterSignIn.resumeDemo({ ...owner, session: '2026-11-18T19:30:00.000Z' }), null, 'new session for the same person');
  assert.equal(tab.getItem(afterSignIn.DEMO_STORAGE_KEY), null, 'the old demo is deleted');

  page.enterDemo(owner);
  const otherStaff = await loadPage();
  assert.equal(otherStaff.resumeDemo({ uid: 'staff-2', session: owner.session }), null, 'a different person');
  assert.equal(otherStaff.isDemoActive(), false);

  const live = await loadPage();
  live.enterDemo(owner);
  assert.equal(live.demoBelongsToAnotherLogin({ uid: 'staff-2', session: owner.session }), true);
  assert.equal(live.demoBelongsToAnotherLogin(owner), false);
  live.leaveDemo();
});

test('Reset demo throws away every change and restores the starting data', async () => {
  const page = await loadPage();
  page.enterDemo(owner);
  const starting = page.startingDemoData(organisationId, frozen);
  page.saveDemo({ ...starting, orders: starting.orders.slice(1), crm: starting.crm.slice(1), activeOrderId: 5 });

  page.resetDemo();
  assert.equal(page.isDemoActive(), true, 'demo stays on');
  const afterRefresh = await loadPage();
  assert.equal(afterRefresh.resumeDemo(owner), 'starting');

  const again = page.startingDemoData(organisationId, frozen);
  assert.deepEqual(again, starting, 'the starting data is the same every time');
  assert.equal(again.orders.length, 12);
  assert.equal(again.activeOrderId, null);
  assert.deepEqual(again.submissions, []);
  afterRefresh.leaveDemo();
});

test('with storage blocked, demo still works but starts again on refresh', async () => {
  blockStorage();
  const page = await loadPage();
  page.enterDemo(owner);
  assert.equal(page.isDemoActive(), true);
  assert.equal(demoNetworkGuardActive(), true);
  page.saveDemo(page.startingDemoData(organisationId, frozen));
  page.resetDemo();

  const after = await loadPage();
  assert.equal(after.resumeDemo(owner), null);
  page.leaveDemo();
  assert.equal(page.isDemoActive(), false);
});

test('corrupt or foreign stored data is ignored', async () => {
  const page = await loadPage();
  tab.setItem(page.DEMO_STORAGE_KEY, '{not json');
  assert.equal(page.resumeDemo(owner), null);
  tab.setItem(page.DEMO_STORAGE_KEY, JSON.stringify({ version: 1, uid: owner.uid, session: owner.session, data: '{"crm":"nope"}' }));
  assert.equal(page.resumeDemo(owner), 'starting');
  page.leaveDemo();
});

test('in demo mode the API client refuses every write; reads and the session stay open', async () => {
  const page = await loadPage();
  page.enterDemo(owner);
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE', 'post']) {
    assert.throws(() => assertNotDemoWrite(method, '/v1/portal/orders'), DemoModeWriteError);
  }
  assert.throws(() => assertNotDemoWrite('POST', '/v1/portal/orders/abc/refunds'), DemoModeWriteError);
  assert.throws(() => assertNotDemoWrite('POST', '/v1/portal/integrations/curaleaf/quote'), DemoModeWriteError);
  assert.throws(() => assertNotDemoWrite('PATCH', '/v1/portal/preferences'), DemoModeWriteError);
  assert.doesNotThrow(() => assertNotDemoWrite('GET', '/v1/portal/orders'));
  assert.doesNotThrow(() => assertNotDemoWrite('POST', '/v1/auth/activity'));
  assert.doesNotThrow(() => assertNotDemoWrite('DELETE', '/v1/auth/session'));

  page.leaveDemo();
  assert.doesNotThrow(() => assertNotDemoWrite('POST', '/v1/portal/orders'));
});

test('the API client checks the demo guard before every request it sends', () => {
  const api = readFileSync(new URL('../src/shared/api.ts', import.meta.url), 'utf8');
  const perform = api.slice(api.indexOf('async function performApiRequest'), api.indexOf('type ApiRequestInit'));
  const guard = perform.indexOf('assertNotDemoWrite(method, path)');
  assert.ok(guard > 0, 'performApiRequest runs the demo guard');
  assert.ok(guard < perform.indexOf('fetch('), 'the guard runs before the request leaves');

  // Every other fetch in the client is a read, or the storage upload that only follows a guarded API write.
  const others = [...api.matchAll(/await fetch\(([^,]+),\s*\{([\s\S]*?)\}\);/g)].filter(match => !match[1].includes('${path}'));
  assert.ok(others.length >= 3, 'found the raw fetches');
  for (const [, target, options] of others) {
    if (target === 'target.uploadUrl') {
      assert.match(api, /apiRequest<PrescriptionUploadTarget>\('\/v1\/portal\/prescription-files\/upload-url', \{\s*method: 'POST'/);
      continue;
    }
    assert.doesNotMatch(options, /method:/, `unguarded write to ${target}`);
  }
});
