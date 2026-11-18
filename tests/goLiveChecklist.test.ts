import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { beforeEach } from 'node:test';
import { assertNotDemoWrite, DemoModeWriteError, setDemoNetworkGuard } from '../src/shared/demoGuard.ts';
import {
  clearDemoChecklist,
  DEMO_CHECKLIST_ITEMS,
  DEMO_CHECKLIST_STORAGE_KEY,
  demoChecklist,
  goLiveChecklistSource,
  setDemoChecklistItem,
} from '../src/training/demoChecklist.ts';
import type { GoLiveChecklist } from '../src/shared/goLiveChecklist.ts';

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.has(key) ? this.values.get(key)! : null; }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  get length() { return this.values.size; }
}

const organisationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let tab: MemoryStorage;

beforeEach(() => {
  tab = new MemoryStorage();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => tab });
  clearDemoChecklist();
});

test('the demo list mirrors the server\'s fixed list, in order, with the same owners and kinds', () => {
  const server = readFileSync(new URL('../services/api-sql/src/domain/organisation/go-live-checklist.ts', import.meta.url), 'utf8');
  const block = server.slice(server.indexOf('export const GO_LIVE_CHECKLIST'), server.indexOf('] as const satisfies'));
  const serverItems = [...block.matchAll(/key: '([a-z_]+)',\s*section: '(\w+)',[\s\S]*?label: '([^']+)',[\s\S]*?owners: \[([^\]]*)\],\s*kind: '(\w+)'/g)]
    .map(match => ({ key: match[1], section: match[2], label: match[3], owners: match[4]!.replace(/'/g, '').split(/,\s*/).join('/'), kind: match[5] }));
  assert.equal(serverItems.length, 12);
  assert.deepEqual(
    DEMO_CHECKLIST_ITEMS.map(item => ({ key: item.key, section: item.section, label: item.label, owners: item.owners.join('/'), kind: item.kind })),
    serverItems,
  );
});

test('the demo checklist starts live with Terms accepted, Worldpay not started and nothing self-ticked', () => {
  const view = demoChecklist(organisationId);
  const done = Object.fromEntries(view.items.map(item => [item.key, item.done]));
  assert.equal(done.platform_live, true);
  assert.equal(done.partner_terms_accepted, true);
  assert.equal(done.worldpay_setup, false);
  assert.equal(done.worldpay_credentials_validated, undefined);
  assert.equal(view.items.filter(item => item.kind === 'self' && item.done).length, 0);
  assert.deepEqual(view.sections.map(section => [section.section, section.percent]), [['required', 50], ['optional', 0]]);
});

test('demo ticks go to the local demo store, survive a reload and clear with the demo', () => {
  setDemoChecklistItem(organisationId, 'sops_approved', true, new Date('2026-11-20T10:00:00.000Z'));
  assert.ok(tab.getItem(DEMO_CHECKLIST_STORAGE_KEY));
  assert.equal(demoChecklist(organisationId).items.find(item => item.key === 'sops_approved')!.done, true);
  setDemoChecklistItem(organisationId, 'sops_approved', false);
  assert.equal(demoChecklist(organisationId).items.find(item => item.key === 'sops_approved')!.done, false);
  setDemoChecklistItem(organisationId, 'formulary_uploaded', true);
  clearDemoChecklist();
  assert.equal(tab.getItem(DEMO_CHECKLIST_STORAGE_KEY), null);
  assert.equal(demoChecklist(organisationId).items.find(item => item.key === 'formulary_uploaded')!.done, false);
});

test('auto and link items cannot be ticked in demo either', () => {
  for (const key of ['platform_live', 'partner_terms_accepted', 'worldpay_setup', 'made_up']) {
    assert.throws(() => setDemoChecklistItem(organisationId, key, true));
  }
});

test('in demo mode the checklist never reaches the server', async () => {
  const calls: string[] = [];
  const server = {
    load: async (): Promise<GoLiveChecklist> => { calls.push('load'); throw new Error('server'); },
    setItem: async (): Promise<GoLiveChecklist> => { calls.push('setItem'); throw new Error('server'); },
  };
  let demo = true;
  const source = goLiveChecklistSource({ organisationId, demoActive: () => demo, server });
  await source.load();
  const ticked = await source.setItem('staff_training', true);
  assert.equal(ticked.items.find(item => item.key === 'staff_training')!.done, true);
  assert.deepEqual(calls, []);

  demo = false;
  await assert.rejects(source.load());
  assert.deepEqual(calls, ['load']);
});

test('the API client guard also refuses a checklist tick while demo is on', () => {
  setDemoNetworkGuard(true);
  try {
    assert.throws(() => assertNotDemoWrite('POST', '/v1/portal/go-live-checklist/items/sops_approved'), DemoModeWriteError);
    assert.doesNotThrow(() => assertNotDemoWrite('GET', '/v1/portal/go-live-checklist'));
  } finally {
    setDemoNetworkGuard(false);
  }
});

test('Return to live, Reset demo and entering demo clear the demo checklist', () => {
  const source = readFileSync(new URL('../src/training/demoMode.ts', import.meta.url), 'utf8');
  for (const name of ['enterDemo', 'resetDemo', 'leaveDemo']) {
    const body = source.match(new RegExp(`export function ${name}\\([\\s\\S]*?\\n}`))?.[0];
    assert.ok(body, name);
    assert.match(body, /clearDemoChecklist\(\)/, name);
  }
});
