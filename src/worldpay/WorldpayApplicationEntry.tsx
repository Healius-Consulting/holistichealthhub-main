import { useCallback, useEffect, useState } from 'react';
import { loadWorldpayApplication, type WorldpayApplicationView } from '../shared/api';
import type { WorldpayAnswers } from './applicationLogic';
import { WorldpayApplicationForm } from './WorldpayApplicationForm';
import { WorldpayApplicationStatusPanel } from './WorldpayApplicationStatus';

/**
 * Settings → Payments: "Apply for a Worldpay account" (spec §3.1), or "Continue" for a
 * saved draft, or the application's status once it is sent. Same form and draft as the
 * onboarding page and the go-live checklist.
 */
export function WorldpayApplicationEntry({ onOpenPayments }: { onOpenPayments?: () => void }) {
  const [view, setView] = useState<WorldpayApplicationView<WorldpayAnswers> | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(() => {
    loadWorldpayApplication<WorldpayAnswers>({ kind: 'branch' }).then(setView).catch(() => setView(null));
  }, []);
  useEffect(refresh, [refresh]);

  if (!view) return null;
  // A pharmacy that already takes online payments with Worldpay only needs its keys, below.
  if (view.status === 'DRAFT' && view.answers?.existingAccount === 'online') return null;
  const sent = view.status && view.status !== 'DRAFT';

  return (
    <div className="wpa-entry">
      {sent ? (
        <WorldpayApplicationStatusPanel view={view} onOpenPayments={onOpenPayments} />
      ) : (
        <div className="wpa-entry__row">
          <span>
            <strong>{view.id ? 'Continue your Worldpay application' : 'No Worldpay account yet?'}</strong>
            <small>{view.id ? 'Your answers are saved. Pick up where you left off.' : 'Apply through Holistic Health Hub. Have the company bank details and each director’s details to hand.'}</small>
          </span>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setOpen(true)}>
            {view.id ? 'Continue' : 'Apply for a Worldpay account'}
          </button>
        </div>
      )}
      <WorldpayApplicationForm open={open} owner={{ kind: 'branch' }} onClose={() => { setOpen(false); refresh(); }} />
    </div>
  );
}
