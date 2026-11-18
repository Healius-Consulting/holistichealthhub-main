import type { AppState } from '../context/AppContext';
import { setDemoNetworkGuard } from '../shared/demoGuard.ts';
import { clearDemoChecklist } from './demoChecklist.ts';
import { hydrateSandboxWorkspace } from './sandboxPack.ts';

/**
 * Demo mode: the pharmacy swaps its own account for the demo data set, runs real flows against it,
 * then returns to live. Everything it does in demo stays in this browser tab:
 *
 * - The demo store is sessionStorage, keyed to the login (staff uid + the session's fixed absolute
 *   expiry). A refresh resumes demo; a new tab, a new sign-in or a logout opens the real account.
 * - Every read and write of storage is wrapped: with storage unavailable demo still works, it just
 *   starts again on refresh.
 * - While demo is on, the API client refuses every write (src/shared/demoGuard.ts).
 */

export const DEMO_STORAGE_KEY = 'hhh_demo_mode';

export type DemoData = Pick<AppState, 'crm' | 'enquiries' | 'orders' | 'submissions' | 'activeOrderId' | 'nextIds'>;

export interface DemoOwner {
  uid: string;
  session: string;
}

interface DemoRecord {
  version: 1;
  uid: string;
  session: string;
  /** Serialised demo data; null until the first change, meaning "the starting demo data". */
  data: string | null;
}

let activeOwner: DemoOwner | null = null;

export function demoOwnerFor(staff: { uid: string; absoluteExpiresAt?: string | null }): DemoOwner {
  return { uid: staff.uid, session: staff.absoluteExpiresAt ?? '' };
}

function sameOwner(left: Pick<DemoOwner, 'uid' | 'session'>, right: DemoOwner) {
  return left.uid === right.uid && left.session === right.session;
}

function demoStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readRecord(): DemoRecord | null {
  try {
    const raw = demoStorage()?.getItem(DEMO_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DemoRecord>;
    if (parsed?.version !== 1 || typeof parsed.uid !== 'string' || typeof parsed.session !== 'string') return null;
    return { version: 1, uid: parsed.uid, session: parsed.session, data: typeof parsed.data === 'string' ? parsed.data : null };
  } catch {
    return null;
  }
}

function writeRecord(owner: DemoOwner, data: string | null) {
  try {
    demoStorage()?.setItem(DEMO_STORAGE_KEY, JSON.stringify({ version: 1, uid: owner.uid, session: owner.session, data } satisfies DemoRecord));
  } catch {
    // Storage full or blocked: demo carries on in memory and starts again on refresh.
  }
}

function removeRecord() {
  try {
    demoStorage()?.removeItem(DEMO_STORAGE_KEY);
  } catch {
    // Nothing stored that could be read back.
  }
}

/* Dates (patient interaction timestamps) survive the round trip; everything else is plain JSON. */
const DATE_TAG = '__demoDate';

export function serialiseDemoData(data: DemoData): string {
  return JSON.stringify(data, function replacer(this: Record<string, unknown>, key: string, value: unknown) {
    const raw = this[key];
    return raw instanceof Date ? { [DATE_TAG]: raw.toISOString() } : value;
  });
}

export function parseDemoData(serialised: string): DemoData | null {
  try {
    const parsed = JSON.parse(serialised, (_key, value: unknown) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const tagged = value as Record<string, unknown>;
        if (typeof tagged[DATE_TAG] === 'string' && Object.keys(tagged).length === 1) return new Date(tagged[DATE_TAG] as string);
      }
      return value;
    }) as Partial<DemoData>;
    if (!Array.isArray(parsed.crm) || !Array.isArray(parsed.orders) || !Array.isArray(parsed.enquiries) || !parsed.nextIds) return null;
    return {
      crm: parsed.crm,
      enquiries: parsed.enquiries,
      orders: parsed.orders,
      submissions: Array.isArray(parsed.submissions) ? parsed.submissions : [],
      activeOrderId: typeof parsed.activeOrderId === 'number' ? parsed.activeOrderId : null,
      nextIds: parsed.nextIds,
    };
  } catch {
    return null;
  }
}

/** The demo data set every demo starts from, and Reset demo goes back to. */
export function startingDemoData(organisationId: string, now = new Date()): DemoData {
  const pack = hydrateSandboxWorkspace(organisationId, now);
  return {
    crm: pack.crm,
    enquiries: pack.enquiries,
    orders: pack.orders,
    submissions: [],
    activeOrderId: null,
    nextIds: pack.nextIds,
  };
}

export function isDemoActive() {
  return activeOwner !== null;
}

/** True when demo is on for a different login than this one: it must end. */
export function demoBelongsToAnotherLogin(owner: DemoOwner) {
  return activeOwner !== null && !sameOwner(activeOwner, owner);
}

function activate(owner: DemoOwner) {
  activeOwner = owner;
  setDemoNetworkGuard(true);
}

/** Turn demo on for this login with the starting data. */
export function enterDemo(owner: DemoOwner) {
  activate(owner);
  writeRecord(owner, null);
  clearDemoChecklist();
}

/**
 * After a refresh: resume this login's demo if one is stored. Returns null when there is none to
 * resume, or 'starting' when demo is on with no changes yet. A demo stored by another login is
 * deleted, so a new sign-in always opens the real account.
 */
export function resumeDemo(owner: DemoOwner): DemoData | 'starting' | null {
  const record = readRecord();
  if (!record) return null;
  if (!sameOwner(record, owner)) {
    removeRecord();
    leaveDemo();
    return null;
  }
  activate(owner);
  const data = record.data ? parseDemoData(record.data) : null;
  return data ?? 'starting';
}

/** Keep demo changes for refresh. Ignored when demo is off. */
export function saveDemo(data: DemoData) {
  if (!activeOwner) return;
  writeRecord(activeOwner, serialiseDemoData(data));
}

/** Throw away every demo change. Demo stays on. */
export function resetDemo() {
  if (!activeOwner) return;
  writeRecord(activeOwner, null);
  clearDemoChecklist();
}

/** Return to live, or logout: demo off, demo changes deleted. */
export function leaveDemo() {
  activeOwner = null;
  setDemoNetworkGuard(false);
  removeRecord();
  clearDemoChecklist();
}
