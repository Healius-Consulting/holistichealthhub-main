import './PharmacyOnboarding.css';
import type { ReactNode } from 'react';
import { Ban, Clock3, PauseCircle } from 'lucide-react';
import { PHARMACY_ACCOUNT_STATE_COPY, type PharmacyAccountState } from '../onboarding/branchOnboarding';

const ICONS: Record<PharmacyAccountState, ReactNode> = {
  being_set_up: <Clock3 size={18} aria-hidden="true" />,
  not_available: <Ban size={18} aria-hidden="true" />,
  suspended: <PauseCircle size={18} aria-hidden="true" />,
};

/**
 * The pharmacy's account status, in one place for all three states. Being set up shows
 * in the portal (the pharmacy carries on into its pre-live account). Not available and
 * Suspended have no portal access, so they show on the sign-in page instead.
 */
export default function PharmacyAccountStatus({ state, children }: { state: PharmacyAccountState; children?: ReactNode }) {
  const copy = PHARMACY_ACCOUNT_STATE_COPY[state];
  return (
    <section className={`pharmacy-account-status pharmacy-account-status--${state}`} role="status" aria-labelledby={`pharmacy-account-status-${state}`}>
      <span className="pharmacy-account-status__icon">{ICONS[state]}</span>
      <div className="pharmacy-account-status__text">
        <strong id={`pharmacy-account-status-${state}`}>{copy.title}</strong>
        <p>{copy.body}</p>
        {children ? <div className="pharmacy-account-status__actions">{children}</div> : null}
      </div>
    </section>
  );
}
