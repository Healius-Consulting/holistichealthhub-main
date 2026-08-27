import type { ActionCodeSettings } from 'firebase/auth';
import { appPathPrefix } from './surface-path';
import { serverSessionAuth } from './firebase';

const FALLBACK_APP_URL = 'https://portal.holistichealthhub.live/pharmacy';

export function appBaseUrl() {
  const configured = import.meta.env.VITE_APP_URL?.trim().replace(/\/$/, '');
  if (configured) return configured;
  if (typeof window !== 'undefined') return serverSessionAuth ? window.location.origin : `${window.location.origin}${appPathPrefix}`;
  return FALLBACK_APP_URL;
}

export function passwordResetActionSettings(): ActionCodeSettings {
  return { url: `${appBaseUrl()}/reset-password`, handleCodeInApp: true };
}
