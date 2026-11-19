import { useEffect, useId, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import {
  describeApiError,
  holdPharmacyOnboardingRequest,
  unholdPharmacyOnboardingRequest,
  type OnboardingHoldReason,
  type PharmacyOnboardingRequestView,
} from '../../shared/api';
import { HOLD_REASON_LABEL, ONBOARDING_HOLD_REASONS } from '../../../services/api-sql/src/domain/pharmacy-onboarding/content.ts';
import { isLocalPortalPreview } from '../../dev/localPortalPreview';
import { formatRequestDate } from './requestFormat';
import { holdReasonLabel } from './onboardingAdmin';
import '../../styles/onboarding-admin.css';

/**
 * On hold (Shay's build pack §3): one hold state with a fixed reason, on a new
 * request or on an activated branch that is not live yet. Setting a hold or changing
 * its reason emails the pharmacy the Hold email for that reason; lifting it sends
 * nothing.
 */

const REASON_USE: Record<OnboardingHoldReason, string> = {
  EXISTING_CURALEAF_CUSTOMER: 'Curaleaf reply that the pharmacy already has an account with them.',
  MORE_INFORMATION_NEEDED: 'Something on the application has to be checked or completed.',
  CURALEAF_DECLINED: 'Curaleaf will not open an account, for a reason other than A.',
};

/** Who the Hold email goes to: the Partner Terms signer and the branch's address, once each. */
export function holdEmailRecipients(request: PharmacyOnboardingRequestView) {
  const signer = request.termsAcceptances?.find(row => row.source === 'signup')?.signerEmail ?? request.termsAcceptances?.[0]?.signerEmail;
  const addresses = [signer, request.pharmacyEmail].filter((value): value is string => Boolean(value?.trim()));
  return [...new Map(addresses.map(address => [address.trim().toLowerCase(), address.trim()])).values()];
}

function previewHeld(request: PharmacyOnboardingRequestView, reason: OnboardingHoldReason): PharmacyOnboardingRequestView {
  const now = new Date().toISOString();
  return { ...request, status: 'on_hold', holdReason: reason, heldAt: now, decidedAt: now };
}

function ReasonChoices({ value, current, onChange, name }: {
  value: OnboardingHoldReason | null;
  current?: OnboardingHoldReason | null;
  onChange: (reason: OnboardingHoldReason) => void;
  name: string;
}) {
  return (
    <div className="onb-hold__reasons" role="radiogroup" aria-label="Reason for the hold">
      {ONBOARDING_HOLD_REASONS.map(reason => (
        <label key={reason} className={`onb-hold__reason${value === reason ? ' is-selected' : ''}`}>
          <input type="radio" name={name} value={reason} checked={value === reason} disabled={current === reason} onChange={() => onChange(reason)} />
          <span>
            <strong>{HOLD_REASON_LABEL[reason]}{current === reason ? <em> (current)</em> : null}</strong>
            <small>{REASON_USE[reason]}</small>
          </span>
        </label>
      ))}
    </div>
  );
}

/** Puts a new request or a branch that is not live on hold. A reason is required. */
export function OnboardingHoldPanel({
  request,
  branchName,
  onCancel,
  onHeld,
}: {
  request: PharmacyOnboardingRequestView;
  /** Set for an activated branch: its staff lose access while it is on hold. */
  branchName?: string;
  onCancel: () => void;
  onHeld: (request: PharmacyOnboardingRequestView) => void;
}) {
  const name = useId();
  const [reason, setReason] = useState<OnboardingHoldReason | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recipients = holdEmailRecipients(request);
  useEffect(() => { setReason(null); setError(null); }, [request.id]);

  const submit = async () => {
    if (!reason) { setError('Choose a reason for the hold.'); return; }
    setBusy(true);
    setError(null);
    try {
      const result = isLocalPortalPreview ? { request: previewHeld(request, reason) } : await holdPharmacyOnboardingRequest(request.id, reason);
      onHeld(result.request);
    } catch (cause) {
      setError(describeApiError(cause, 'The hold could not be set.'));
      setBusy(false);
    }
  };

  return (
    <section className="admin-request-decline onb-hold" aria-labelledby={`${name}-title`}>
      <h3 id={`${name}-title`}>Put {branchName ?? 'this request'} on hold</h3>
      <p>
        {branchName
          ? 'Its staff lose access and see only the hold message for the reason you choose. Its eligibility link goes off until you lift the hold.'
          : 'The pharmacy sees the hold message for the reason you choose when it logs in. A new Curaleaf form for this GPhC is refused while it is on hold.'}
      </p>
      <ReasonChoices name={name} value={reason} onChange={next => { setReason(next); setError(null); }} />
      <p className="onb-hold__email">
        <strong>This emails the pharmacy</strong> the Hold email for that reason{recipients.length ? <>, to {recipients.join(' and ')}</> : null}.
      </p>
      {error ? <p className="admin-activation__error" role="alert">{error}</p> : null}
      <div className="admin-request-decline__actions">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-sm btn-danger" disabled={busy || !reason} onClick={() => void submit()}>
          {busy ? 'Putting on hold…' : 'Put on hold and email'}
        </button>
      </div>
    </section>
  );
}

/** A request or branch on hold: its reason and date, with Change reason and Lift hold. */
export function OnboardingHoldCard({
  request,
  onChanged,
}: {
  request: PharmacyOnboardingRequestView;
  onChanged: (request: PharmacyOnboardingRequestView, change: 'reason' | 'lifted') => void;
}) {
  const name = useId();
  const [mode, setMode] = useState<null | 'change' | 'lift'>(null);
  const [reason, setReason] = useState<OnboardingHoldReason | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activated = Boolean(request.organisationId);
  const recipients = holdEmailRecipients(request);
  useEffect(() => { setMode(null); setReason(null); setError(null); setBusy(false); }, [request.id, request.holdReason, request.status]);

  const change = async () => {
    if (!reason) { setError('Choose the new reason.'); return; }
    setBusy(true);
    setError(null);
    try {
      const result = isLocalPortalPreview ? { request: previewHeld(request, reason) } : await holdPharmacyOnboardingRequest(request.id, reason);
      onChanged(result.request, 'reason');
    } catch (cause) {
      setError(describeApiError(cause, 'The reason could not be changed.'));
      setBusy(false);
    }
  };
  const lift = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = isLocalPortalPreview
        ? { request: { ...request, status: activated ? 'activated' as const : 'pending' as const } }
        : await unholdPharmacyOnboardingRequest(request.id);
      onChanged(result.request, 'lifted');
    } catch (cause) {
      setError(describeApiError(cause, 'The hold could not be lifted.'));
      setBusy(false);
    }
  };

  return (
    <section className="admin-activation admin-activation--stopped onb-hold-card" aria-labelledby={`${name}-title`}>
      <header>
        <span className="admin-activation__icon" aria-hidden="true"><AlertCircle size={18} /></span>
        <span>
          <small>On hold since {formatRequestDate(request.heldAt ?? request.decidedAt) || 'an unknown date'}</small>
          <strong id={`${name}-title`}>{holdReasonLabel(request.holdReason)}</strong>
        </span>
        {mode === null ? (
          <span className="onb-hold-card__actions">
            <button type="button" className="btn btn-sm" onClick={() => { setMode('change'); setReason(null); }}>Change reason</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setMode('lift')}>Lift hold</button>
          </span>
        ) : null}
      </header>
      <p className="admin-activation__body">
        {activated
          ? 'Its staff see only the hold message for this reason, and its eligibility link is off.'
          : 'The pharmacy sees the hold message for this reason when it logs in, and a new Curaleaf form for this GPhC is refused.'}
      </p>

      {mode === 'change' ? (
        <div className="onb-hold-card__confirm">
          <ReasonChoices name={name} value={reason} current={request.holdReason} onChange={next => { setReason(next); setError(null); }} />
          <p className="onb-hold__email">
            <strong>This emails the pharmacy</strong> the Hold email again, with the wording for the new reason{recipients.length ? <>, to {recipients.join(' and ')}</> : null}. The hold date is reset to today.
          </p>
          {error ? <p className="admin-activation__error" role="alert">{error}</p> : null}
          <div className="admin-request-decline__actions">
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setMode(null); setError(null); }}>Cancel</button>
            <button type="button" className="btn btn-sm btn-danger" disabled={busy || !reason} onClick={() => void change()}>{busy ? 'Changing…' : 'Change reason and email'}</button>
          </div>
        </div>
      ) : null}

      {mode === 'lift' ? (
        <div className="onb-hold-card__confirm">
          <p className="onb-hold__email">
            <strong>Lift the hold?</strong>{' '}
            {activated
              ? 'The branch goes back to awaiting Curaleaf: its staff see the demo account again and its eligibility link comes back on.'
              : 'It goes back to a new request, ready to activate.'}{' '}
            No email is sent.
          </p>
          {error ? <p className="admin-activation__error" role="alert">{error}</p> : null}
          <div className="admin-request-decline__actions">
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setMode(null); setError(null); }}>Cancel</button>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void lift()}>{busy ? 'Lifting…' : 'Yes, lift the hold'}</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
