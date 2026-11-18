import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ApiRequestError, acceptPartnerTerms } from '../shared/api';
import type { PharmsmartTermsRequest } from './types';

const ROLES = [
  { id: 'SUPERINTENDENT_PHARMACIST', label: 'Superintendent pharmacist', pharmacist: true },
  { id: 'PHARMACIST', label: 'Pharmacist', pharmacist: true },
  { id: 'DIRECTOR', label: 'Director', pharmacist: false },
  { id: 'PHARMACY_MANAGER', label: 'Pharmacy manager', pharmacist: false },
  { id: 'OTHER', label: 'Other', pharmacist: false },
] as const;

type RoleId = typeof ROLES[number]['id'];

/**
 * The Partner Terms step, between the Curaleaf form and Worldpay. The Terms text is a
 * placeholder block until the client's final layout and wording replace it as content.
 * Accepting is what sends the Curaleaf application.
 */
export function PartnerTermsForm({
  open,
  request,
  pharmsmartTicket,
  signer,
  onClose,
  onAccepted,
}: {
  open: boolean;
  request: PharmsmartTermsRequest | null;
  pharmsmartTicket?: string | null;
  /** Who signed in from PharmSmart, as a starting point. */
  signer: { name: string; email: string };
  onClose: () => void;
  onAccepted: () => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(false);
  onCloseRef.current = onClose;
  const [name, setName] = useState(signer.name);
  const [email, setEmail] = useState(signer.email);
  const [role, setRole] = useState<RoleId | ''>('');
  const [gphc, setGphc] = useState('');
  const [authorised, setAuthorised] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open || !request) return null;
  const company = request.registeredCompanyName || request.pharmacyName;
  const pharmacist = ROLES.find(option => option.id === role)?.pharmacist ?? false;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !role) return;
    const form = event.currentTarget;
    if (!form.checkValidity()) {
      form.querySelector<HTMLElement>(':invalid')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      form.reportValidity();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await acceptPartnerTerms({
        onboardingRequestId: request.id,
        signerName: name.trim(),
        signerRole: role,
        signerEmail: email.trim(),
        signerGphcNumber: pharmacist ? gphc.trim() : '',
        authorised: true,
        ...(pharmsmartTicket ? { pharmsmartTicket } : {}),
      });
      onAccepted();
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? cause.message : 'The terms could not be accepted. Try again.');
      setBusy(false);
    }
  };

  return createPortal(
    <div className="onboarding-dialog" role="presentation">
      <button className="onboarding-dialog__backdrop" type="button" aria-label="Close terms" onClick={onClose} disabled={busy} />
      <form className="onboarding-dialog__panel curaleaf-account-form partner-terms-form" role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={event => void submit(event)}>
        <header>
          <h2 id={titleId}>Partner Terms</h2>
          <button ref={closeRef} type="button" onClick={onClose} disabled={busy}>Close</button>
        </header>
        <div className="curaleaf-account-form__body">
          <p>Your Curaleaf account form is in. Accept the Partner Terms to send it to Curaleaf Laboratories.</p>
          <section className="partner-terms-form__terms" aria-label="Partner Terms text">
            <p>New item — to be updated here</p>
          </section>
          {error ? <p className="curaleaf-account-form__error" role="alert">{error}</p> : null}
          <div className="curaleaf-account-form__grid">
            <fieldset>
              <legend>Who is signing</legend>
              <label>Your role
                <select className="input" name="signerRole" value={role} onChange={event => setRole(event.target.value as RoleId | '')} required>
                  <option value="">Choose your role</option>
                  {ROLES.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
              </label>
              <label>Your email<input className="input" name="signerEmail" type="email" value={email} onChange={event => setEmail(event.target.value)} required autoComplete="email" /></label>
              {pharmacist ? (
                <label>Your GPhC registration number <span>7 digits</span>
                  <input className="input" name="signerGphcNumber" value={gphc} onChange={event => setGphc(event.target.value)} required inputMode="numeric" pattern="\s*(\d\s*){7}" autoComplete="off" />
                </label>
              ) : null}
            </fieldset>
            <label className="partner-terms-form__declaration">
              <input type="checkbox" name="authorised" checked={authorised} onChange={event => setAuthorised(event.target.checked)} required />
              <span>I confirm I am authorised to accept these terms on behalf of <strong>{company}</strong></span>
            </label>
            <label>Signature <span>Type your full name to sign</span>
              <input className="input partner-terms-form__signature" name="signerName" value={name} onChange={event => setName(event.target.value)} required minLength={2} maxLength={160} autoComplete="name" />
            </label>
          </div>
        </div>
        <footer>
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Accepting…' : 'Accept and continue'}</button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
