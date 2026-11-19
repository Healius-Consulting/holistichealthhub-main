import { useCallback, useEffect, useState } from 'react';
import { loadWorldpayApplication, type WorldpayApplicationView } from '../shared/api';
import type { WorldpayAnswers } from './applicationLogic';
import { WorldpayApplicationForm } from './WorldpayApplicationForm';
import { WorldpayApplicationStatusPanel } from './WorldpayApplicationStatus';

const CLOSED: ReadonlyArray<WorldpayApplicationView['status']> = ['WITHDRAWN', 'DECLINED'];

/**
 * Settings → Payments: "Apply for a Worldpay account" (spec §3.1), "Continue application" for a
 * saved draft, or the application's status once it is sent. Same form and draft as the
 * onboarding page and the go-live checklist. FB-19: there is always a way in until the
 * application is sent, and a way to start again after a withdrawn or declined one.
 */
export function WorldpayApplicationEntry({ onOpenPayments }: { onOpenPayments?: () => void }) {
  const [view, setView] = useState<WorldpayApplicationView<WorldpayAnswers> | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<'closed' | 'continue' | 'fresh'>('closed');

  const refresh = useCallback(() => {
    setFailed(false);
    loadWorldpayApplication<WorldpayAnswers>({ kind: 'branch' })
      .then(setView)
      .catch(() => { setView(null); setFailed(true); });
  }, []);
  useEffect(refresh, [refresh]);

  const form = (
    <WorldpayApplicationForm
      open={open !== 'closed'}
      owner={{ kind: 'branch' }}
      fresh={open === 'fresh'}
      onClose={() => { setOpen('closed'); refresh(); }}
    />
  );

  if (failed) {
    return (
      <div className="wpa-entry">
        <div className="wpa-entry__row">
          <span>
            <strong>Worldpay application</strong>
            <small>We couldn’t load your application just now.</small>
          </span>
          <button type="button" className="btn btn-sm" onClick={refresh}>Try again</button>
        </div>
      </div>
    );
  }
  if (!view) return null;
  const draft = Boolean(view.id) && view.status === 'DRAFT';
  const sent = Boolean(view.status) && view.status !== 'DRAFT';
  const closed = CLOSED.includes(view.status);

  return (
    <div className="wpa-entry">
      {sent ? <WorldpayApplicationStatusPanel view={view} onOpenPayments={onOpenPayments} /> : null}
      {!sent || closed ? (
        <div className="wpa-entry__row">
          <span>
            <strong>{draft ? 'Continue your Worldpay application' : closed ? 'Apply again' : 'No Worldpay account yet?'}</strong>
            <small>
              {draft
                ? 'Your answers are saved. Pick up where you left off, or discard them and start again.'
                : 'Apply through Holistic Health Hub. Have the company bank details and each director’s details to hand.'}
            </small>
          </span>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setOpen(closed ? 'fresh' : 'continue')}>
            {draft ? 'Continue application' : closed ? 'Start a new application' : 'Apply for a Worldpay account'}
          </button>
        </div>
      ) : null}
      {form}
    </div>
  );
}
