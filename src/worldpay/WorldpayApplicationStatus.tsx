import type { WorldpayApplicationStatus, WorldpayApplicationView } from '../shared/api';
import { worldpayStatusLine } from './statusLine';

/**
 * What the pharmacy is shown about its Worldpay application once it is sent (spec §3.5).
 * Used inside the form, on the onboarding page and in Settings → Payments.
 */

const TONE: Record<WorldpayApplicationStatus, 'green' | 'amber' | 'info' | 'red'> = {
  DRAFT: 'info',
  SUBMITTED: 'green',
  WITH_WORLDPAY: 'green',
  QUERY: 'amber',
  ACCOUNT_OPEN: 'green',
  CONNECTED: 'green',
  WITHDRAWN: 'red',
  DECLINED: 'red',
};

export function WorldpayApplicationStatusPanel({ view, onOpenPayments }: { view: WorldpayApplicationView<unknown>; onOpenPayments?: () => void }) {
  const line = worldpayStatusLine(view);
  if (!view.status || !line) return null;
  return (
    <div className={`wpa-banner is-${TONE[view.status]}`} role="status">
      <strong>{view.status === 'SUBMITTED' || view.status === 'WITH_WORLDPAY' ? 'Application sent.' : 'Worldpay application.'}</strong>{' '}
      {line}
      {view.reference ? <small>Reference {view.reference}</small> : null}
      {view.status === 'ACCOUNT_OPEN' && onOpenPayments ? (
        <button type="button" className="btn btn-sm" onClick={onOpenPayments}>Open Settings → Payments</button>
      ) : null}
    </div>
  );
}
