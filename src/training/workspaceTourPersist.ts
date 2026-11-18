import { readAccessibilityPreferences } from '../accessibility/preferences';
import { isLocalPortalPreview } from '../dev/localPortalPreview';
import { isApiConfigured, updateStaffAccessibilityPreferences } from '../shared/api';
import { isDemoActive } from './demoMode';
import {
  mergeStaffPreferences,
  rememberStaffPreferenceExtras,
  replayWorkspaceTour,
  setWorkspaceTourCompleted,
} from './workspaceTourPreferences';

export function persistWorkspaceTourCompleted(value: boolean) {
  setWorkspaceTourCompleted(value);
  rememberStaffPreferenceExtras({ workspaceTourCompleted: value });
  // In demo the tour is remembered in this browser only: demo mode never writes to the server.
  if (isLocalPortalPreview || isDemoActive() || !isApiConfigured) return;
  void updateStaffAccessibilityPreferences(mergeStaffPreferences(readAccessibilityPreferences())).catch(error => {
    console.warn('Workspace tour preference could not be saved:', error);
  });
}

export function requestWorkspaceTourReplay() {
  replayWorkspaceTour();
  persistWorkspaceTourCompleted(false);
}
