import { readAccessibilityPreferences } from '../accessibility/preferences';
import { isLocalPortalPreview } from '../dev/localPortalPreview';
import { isApiConfigured, updateStaffAccessibilityPreferences } from '../shared/api';
import {
  mergeStaffPreferences,
  rememberStaffPreferenceExtras,
  replayWorkspaceTour,
  setWorkspaceTourCompleted,
} from './workspaceTourPreferences';

export function persistWorkspaceTourCompleted(value: boolean) {
  setWorkspaceTourCompleted(value);
  rememberStaffPreferenceExtras({ workspaceTourCompleted: value });
  if (isLocalPortalPreview || !isApiConfigured) return;
  void updateStaffAccessibilityPreferences(mergeStaffPreferences(readAccessibilityPreferences())).catch(error => {
    console.warn('Workspace tour preference could not be saved:', error);
  });
}

export function requestWorkspaceTourReplay() {
  replayWorkspaceTour();
  persistWorkspaceTourCompleted(false);
}
