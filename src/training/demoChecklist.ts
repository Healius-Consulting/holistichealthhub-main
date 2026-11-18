import type { GoLiveChecklist, GoLiveChecklistItem, GoLiveChecklistSource } from '../shared/goLiveChecklist.ts';

/**
 * The go-live checklist in Demo mode. Ticks go to a local demo store in sessionStorage,
 * never the server: the demo account starts live with its Partner Terms accepted and no
 * Worldpay, and nothing self-declared ticked. Return to live, Reset demo and logout
 * clear it (src/training/demoMode.ts).
 *
 * The item list mirrors the server's fixed list (tests/goLiveChecklist.test.ts keeps them in step).
 */

export const DEMO_CHECKLIST_STORAGE_KEY = 'hhh_demo_checklist';

type Definition = Omit<GoLiveChecklistItem, 'done' | 'doneAt' | 'tickedByUid' | 'tickedAt' | 'tickedByName'> & {
  /** Demo shows the not-yet-started Worldpay set-up, so the Required Worldpay item is hidden. */
  demoVisible: boolean;
};

export const DEMO_CHECKLIST_ITEMS: Definition[] = [
  { key: 'platform_live', section: 'required', group: 'platform_live', label: 'Curaleaf PHAR code and API key entered, platform live', detail: 'Ticks itself when HHH enters the live Curaleaf credentials.', owners: ['HHH', 'Curaleaf'], kind: 'auto', link: null, demoVisible: true },
  { key: 'partner_terms_accepted', section: 'required', group: 'platform_live', label: 'Partner Terms accepted', detail: 'Ticks itself once the Partner Terms are accepted.', owners: ['Pharmacy'], kind: 'auto', link: null, demoVisible: true },
  { key: 'worldpay_credentials_validated', section: 'required', group: 'platform_live', label: 'Worldpay credentials validated', detail: 'Ticks itself when your live Worldpay credentials pass the check in Settings.', owners: ['Pharmacy'], kind: 'auto', link: null, demoVisible: false },
  { key: 'sops_approved', section: 'required', group: 'service_live', label: 'SOPs approved by the superintendent', detail: null, owners: ['Pharmacy'], kind: 'self', link: null, demoVisible: true },
  { key: 'formulary_uploaded', section: 'required', group: 'service_live', label: 'Formulary uploaded to PMR', detail: null, owners: ['Pharmacy'], kind: 'self', link: null, demoVisible: true },
  { key: 'worldpay_setup', section: 'optional', group: null, label: 'Set up card payments with Worldpay', detail: 'Send the Worldpay form. Once it is sent, this moves to Required as "Worldpay credentials validated".', owners: ['Pharmacy'], kind: 'link', link: 'worldpay_form', demoVisible: true },
  { key: 'staff_training', section: 'optional', group: null, label: 'Staff training completed', detail: 'HHH session attended or materials read.', owners: ['Pharmacy'], kind: 'self', link: null, demoVisible: true },
  { key: 'patientsmart_campaign', section: 'optional', group: null, label: 'PatientSmart campaign set up', detail: null, owners: ['Pharmacy'], kind: 'self', link: null, demoVisible: true },
  { key: 'website_updated', section: 'optional', group: null, label: 'Website updated with the HHH kit', detail: null, owners: ['Pharmacy'], kind: 'self', link: null, demoVisible: true },
  { key: 'posters_leaflets', section: 'optional', group: null, label: 'Posters/leaflets created and printed', detail: null, owners: ['Pharmacy'], kind: 'self', link: null, demoVisible: true },
  { key: 'branding_details', section: 'optional', group: null, label: 'Details, colour scheme and logo added', detail: 'Website domain and contact details, used on the eligibility form.', owners: ['Pharmacy'], kind: 'self', link: null, demoVisible: true },
  { key: 'delivery_enabled', section: 'optional', group: null, label: 'Delivery enabled, if offering it', detail: null, owners: ['Pharmacy'], kind: 'self', link: null, demoVisible: true },
];

const DEMO_AUTO_DONE = new Set(['platform_live', 'partner_terms_accepted']);

type DemoTicks = Record<string, { done: boolean; at: string }>;

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Kept in memory too, so demo still works (until refresh) when storage is blocked. */
let memory: DemoTicks = {};

function readTicks(): DemoTicks {
  try {
    const raw = storage()?.getItem(DEMO_CHECKLIST_STORAGE_KEY);
    if (!raw) return memory;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as DemoTicks : memory;
  } catch {
    return memory;
  }
}

function writeTicks(ticks: DemoTicks) {
  memory = ticks;
  try {
    storage()?.setItem(DEMO_CHECKLIST_STORAGE_KEY, JSON.stringify(ticks));
  } catch {
    // Storage blocked: the ticks last until refresh.
  }
}

/** Return to live, Reset demo and logout all throw the demo ticks away. */
export function clearDemoChecklist() {
  memory = {};
  try {
    storage()?.removeItem(DEMO_CHECKLIST_STORAGE_KEY);
  } catch {
    // Nothing stored that could be read back.
  }
}

function percentOf(done: number, total: number) {
  return total === 0 ? 100 : Math.round((done / total) * 100);
}

export function demoChecklist(organisationId: string): GoLiveChecklist {
  const ticks = readTicks();
  const items: GoLiveChecklistItem[] = DEMO_CHECKLIST_ITEMS.filter(item => item.demoVisible).map(({ demoVisible: _visible, ...item }) => {
    const tick = item.kind === 'self' ? ticks[item.key] : undefined;
    const done = item.kind === 'auto' ? DEMO_AUTO_DONE.has(item.key) : Boolean(tick?.done);
    return {
      ...item,
      owners: [...item.owners],
      done,
      doneAt: tick?.done ? tick.at : null,
      tickedByUid: null,
      tickedAt: tick?.at ?? null,
    };
  });
  const sections = (['required', 'optional'] as const).map(section => {
    const inSection = items.filter(item => item.section === section);
    const done = inSection.filter(item => item.done).length;
    return { section, done, total: inSection.length, percent: percentOf(done, inSection.length) };
  });
  return {
    organisationId,
    items,
    sections,
    percent: percentOf(items.filter(item => item.done).length, items.length),
    requiredComplete: items.filter(item => item.section === 'required').every(item => item.done),
    complete: items.every(item => item.done),
  };
}

export function setDemoChecklistItem(organisationId: string, itemKey: string, done: boolean, now = new Date()): GoLiveChecklist {
  const item = DEMO_CHECKLIST_ITEMS.find(entry => entry.key === itemKey);
  if (!item || item.kind !== 'self') throw new Error('This item cannot be ticked by hand.');
  writeTicks({ ...readTicks(), [itemKey]: { done, at: now.toISOString() } });
  return demoChecklist(organisationId);
}

/**
 * Picks where the checklist comes from each time it is used: the demo store while demo
 * is on, otherwise the server. Nothing reaches the server in demo.
 */
export function goLiveChecklistSource(options: {
  organisationId: string;
  demoActive: () => boolean;
  server: GoLiveChecklistSource;
}): GoLiveChecklistSource {
  return {
    load: async () => (options.demoActive() ? demoChecklist(options.organisationId) : options.server.load()),
    setItem: async (itemKey, done) => (options.demoActive()
      ? setDemoChecklistItem(options.organisationId, itemKey, done)
      : options.server.setItem(itemKey, done)),
  };
}
