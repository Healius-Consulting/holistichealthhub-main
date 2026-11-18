import { useCallback, useEffect, useState } from 'react';
import { describeApiError, getBranchOnboarding, type BranchOnboardingView } from '../shared/api';
import { isLocalPortalPreview } from '../dev/localPortalPreview';

/** Local preview has no API: an activated branch that left before the Partner Terms. */
const LOCAL_PREVIEW_VIEW: BranchOnboardingView = {
  live: false,
  submittedAt: '2026-11-19T14:05:00.000Z',
  termsAccepted: false,
  termsAcceptedAt: null,
  worldpaySubmittedAt: null,
  registeredCompanyName: 'Primary Branch Ltd',
};

// One fetch per branch per page load, shared by the banner and the Onboarding page.
const cache = new Map<string, BranchOnboardingView>();

export function useBranchOnboarding(organisationId: string | null | undefined, enabled: boolean) {
  const key = organisationId ?? '';
  const [view, setView] = useState<BranchOnboardingView | null>(() => (
    isLocalPortalPreview ? cache.get(key) ?? LOCAL_PREVIEW_VIEW : cache.get(key) ?? null
  ));
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!key || !enabled || isLocalPortalPreview) return;
    try {
      const next = await getBranchOnboarding();
      cache.set(key, next);
      setView(next);
      setError(null);
    } catch (cause) {
      setError(describeApiError(cause, 'Your onboarding progress could not be loaded.'));
    }
  }, [enabled, key]);

  useEffect(() => {
    if (!enabled || !key) return;
    const known = cache.get(key);
    if (known) { setView(known); return; }
    void reload();
  }, [enabled, key, reload]);

  /** After a form is sent, show it straight away without another fetch. */
  const update = useCallback((patch: Partial<BranchOnboardingView>) => {
    setView(current => {
      const next = { ...(current ?? LOCAL_PREVIEW_VIEW), ...patch };
      if (key) cache.set(key, next);
      return next;
    });
  }, [key]);

  return { view, error, reload, update };
}
