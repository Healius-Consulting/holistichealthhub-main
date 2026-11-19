import { useCallback, useEffect, useState } from 'react';
import { CreditCard, Mail } from 'lucide-react';
import { isLocalPortalPreview } from '../../dev/localPortalPreview';
import {
  describeApiError,
  getBranchWorldpayStatus,
  markWorldpayFormReceivedByEmail,
  undoWorldpayFormReceivedByEmail,
  type AdminBranchWorldpayStatus,
} from '../../shared/api';

const STATUS_TEXT: Record<string, string> = {
  DRAFT: 'Started on the platform, not sent yet',
  SUBMITTED: 'Sent from the platform',
  WITH_WORLDPAY: 'With Worldpay',
  QUERY: 'Worldpay has a query',
  ACCOUNT_OPEN: 'Worldpay account open',
  CONNECTED: 'Connected',
  WITHDRAWN: 'Withdrawn',
  DECLINED: 'Declined by Worldpay',
};

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' }) : '');
const todayLondon = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());

/**
 * Admin, one pharmacy: its Worldpay application, and the switch for a form the pharmacy
 * sent by email instead of through the platform. Recording it makes the branch's
 * application "With Worldpay", so Settings, the go-live checklist and the Onboarding page
 * stop offering the form. Undo puts back what was there (a started draft, or nothing).
 */
export function WorldpayEmailCard({ organisationId, onToast }: { organisationId: string; onToast: (message: string) => void }) {
  const [view, setView] = useState<AdminBranchWorldpayStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<'mark' | 'undo' | null>(null);
  const [receivedOn, setReceivedOn] = useState(todayLondon);

  const load = useCallback(() => {
    setError(null);
    if (isLocalPortalPreview) { setView({ status: null, submittedAt: null, reference: null, receivedByEmail: false }); return; }
    getBranchWorldpayStatus(organisationId).then(setView).catch(cause => setError(describeApiError(cause, 'The Worldpay application could not be loaded.')));
  }, [organisationId]);
  useEffect(() => { setAsking(null); setReceivedOn(todayLondon()); load(); }, [load]);

  const act = async (work: () => Promise<AdminBranchWorldpayStatus>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      setView(await work());
      setAsking(null);
      onToast(done);
    } catch (cause) {
      setError(describeApiError(cause, 'That did not work. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const open = !view?.status || view.status === 'DRAFT' || view.status === 'WITHDRAWN' || view.status === 'DECLINED';
  const statusText = !view ? 'Loading…'
    : view.receivedByEmail ? `Received by email on ${day(view.submittedAt)}`
      : view.status ? `${STATUS_TEXT[view.status] ?? view.status}${view.submittedAt && view.status !== 'DRAFT' ? ` · ${day(view.submittedAt)}` : ''}${view.reference ? ` · ${view.reference}` : ''}`
        : 'No application yet';

  return (
    <section className="pharmacy-details__card" aria-labelledby="pharmacy-details-worldpay-form">
      <header>
        <span className="pharmacy-details__icon" aria-hidden="true"><CreditCard size={16} /></span>
        <h4 id="pharmacy-details-worldpay-form">Worldpay application</h4>
      </header>
      <dl className="pharmacy-details__list">
        <div className="pharmacy-details__row"><dt>Status</dt><dd>{statusText}</dd></div>
      </dl>
      {error ? <p className="pharmacy-details__error" role="alert">{error}</p> : null}

      {view && open && asking !== 'mark' ? (
        <>
          <p className="pharmacy-details__note">Sent its Worldpay form by email? Record it here so the platform stops asking for it.</p>
          <div className="pharmacy-details__actions is-start">
            <button type="button" className="btn btn-sm" disabled={busy || isLocalPortalPreview} onClick={() => setAsking('mark')}><Mail size={13} /> Mark form received by email</button>
          </div>
        </>
      ) : null}
      {asking === 'mark' ? (
        <div className="pharmacy-details__form">
          <label className="pharmacy-details__fields">
            <span>Date the form arrived</span>
            <input className="input" type="date" value={receivedOn} max={todayLondon()} onChange={event => setReceivedOn(event.target.value)} />
            <small>{view?.status === 'DRAFT' ? 'The draft the pharmacy started is kept with it.' : 'The pharmacy will see “We received your Worldpay form by email” instead of the form.'}</small>
          </label>
          <div className="pharmacy-details__actions">
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setAsking(null)}>Cancel</button>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !receivedOn} onClick={() => void act(() => markWorldpayFormReceivedByEmail(organisationId, receivedOn || null), 'Worldpay form recorded as received by email.')}>
              {busy ? 'Saving…' : 'Record it'}
            </button>
          </div>
        </div>
      ) : null}

      {view?.receivedByEmail && view.status === 'WITH_WORLDPAY' ? (
        asking === 'undo' ? (
          <div className="pharmacy-details__actions is-start">
            <span className="pharmacy-details__note">Undo? The platform will offer the form again.</span>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setAsking(null)}>Keep it</button>
            <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => void act(() => undoWorldpayFormReceivedByEmail(organisationId), 'Undone. The platform offers the Worldpay form again.')}>{busy ? 'Undoing…' : 'Undo'}</button>
          </div>
        ) : (
          <div className="pharmacy-details__actions is-start">
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setAsking('undo')}>Undo “received by email”</button>
          </div>
        )
      ) : null}
    </section>
  );
}
