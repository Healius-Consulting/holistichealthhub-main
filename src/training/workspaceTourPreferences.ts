import type { StaffAccessibilityPreferences } from '../shared/contracts';
import type { AccessibilityPreferences } from '../accessibility/preferences';

const STORAGE_KEY = 'hhh:workspace-tour-completed';

let completed: boolean | null = null;
let replayNonce = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function readLocalFlag(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeLocalFlag(value: boolean) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false');
  } catch {
    // Tour still runs for this session when storage is unavailable.
  }
}

export function hydrateWorkspaceTourFromPreferences(workspaceTourCompleted: boolean | undefined, localPreview: boolean) {
  completed = localPreview ? readLocalFlag() : Boolean(workspaceTourCompleted);
  extras.workspaceTourCompleted = completed;
  emit();
}

export function markWorkspaceTourKnownUnset(localPreview: boolean) {
  if (completed !== null) return;
  completed = localPreview ? readLocalFlag() : false;
  extras.workspaceTourCompleted = completed;
  emit();
}

export function workspaceTourCompleted(): boolean | null {
  return completed;
}

export function workspaceTourReplayNonce() {
  return replayNonce;
}

export function setWorkspaceTourCompleted(value: boolean) {
  completed = value;
  extras.workspaceTourCompleted = value;
  writeLocalFlag(value);
  emit();
}

export function replayWorkspaceTour() {
  completed = false;
  extras.workspaceTourCompleted = false;
  writeLocalFlag(false);
  replayNonce += 1;
  emit();
}

export function subscribeWorkspaceTour(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let extras: Pick<StaffAccessibilityPreferences, 'overviewView' | 'workspaceTourCompleted'> = {};

export function rememberStaffPreferenceExtras(preferences: Partial<StaffAccessibilityPreferences>) {
  if ('overviewView' in preferences) extras.overviewView = preferences.overviewView;
  if ('workspaceTourCompleted' in preferences) extras.workspaceTourCompleted = preferences.workspaceTourCompleted;
}

export function mergeStaffPreferences(accessibility: AccessibilityPreferences): StaffAccessibilityPreferences {
  const workspaceTourCompleted = completed === true || (completed === null && extras.workspaceTourCompleted === true);
  rememberStaffPreferenceExtras({ workspaceTourCompleted });
  return {
    ...accessibility,
    ...(extras.overviewView ? { overviewView: extras.overviewView } : {}),
    workspaceTourCompleted,
  };
}
