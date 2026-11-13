import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ApiRequestError, submitCuraleafAccountForm } from '../shared/api';
import type { PharmsmartWelcome } from './types';

type Fields = {
  pharmacistName: string;
  pharmacyName: string;
  registeredCompanyName: string;
  invoiceAddress: string;
  deliveryAddress: string;
  gphcNumber: string;
  pharmacyEmail: string;
  accountsEmail: string;
  pharmacyPhone: string;
  accountsPhone: string;
  faxNumber: string;
};

function blank(welcome: PharmsmartWelcome): Fields {
  const name = [welcome.firstName, welcome.lastName].filter(Boolean).join(' ').trim();
  return {
    pharmacistName: name,
    pharmacyName: '',
    registeredCompanyName: '',
    invoiceAddress: '',
    deliveryAddress: '',
    gphcNumber: welcome.gphcNumber?.trim() ?? '',
    pharmacyEmail: welcome.email?.trim() ?? '',
    accountsEmail: '',
    pharmacyPhone: '',
    accountsPhone: '',
    faxNumber: '',
  };
}

export function CuraleafAccountForm({
  open,
  welcome,
  onClose,
  onSubmitted,
}: {
  open: boolean;
  welcome: PharmsmartWelcome;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const idempotencyKey = useRef(crypto.randomUUID());
  const welcomeRef = useRef(welcome);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(false);
  welcomeRef.current = welcome;
  onCloseRef.current = onClose;
  const [fields, setFields] = useState<Fields>(() => blank(welcome));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;
    setFields(blank(welcomeRef.current));
    setError(null);
    setBusy(false);
    idempotencyKey.current = crypto.randomUUID();
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

  if (!open) return null;

  const set = (key: keyof Fields) => (event: { target: { value: string } }) => {
    setFields(current => ({ ...current, [key]: event.target.value }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.set(key, value.trim());
    body.set('signatureName', fields.pharmacistName.trim());
    body.set('idempotencyKey', idempotencyKey.current);
    try {
      await submitCuraleafAccountForm(body);
      onSubmitted();
    } catch (cause) {
      const message = cause instanceof ApiRequestError
        ? cause.message
        : 'The form could not be submitted. Try again.';
      setError(message);
      setBusy(false);
    }
  };

  return createPortal(
    <div className="onboarding-dialog" role="presentation">
      <button className="onboarding-dialog__backdrop" type="button" aria-label="Close form" onClick={onClose} disabled={busy} />
      <form className="onboarding-dialog__panel curaleaf-account-form" role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={event => void submit(event)}>
        <header>
          <h2 id={titleId}>Curaleaf account</h2>
          <button ref={closeRef} type="button" onClick={onClose} disabled={busy}>Close</button>
        </header>
        <div className="curaleaf-account-form__body">
          <p>These details are written onto the Curaleaf account form. The date is added when you submit.</p>
          {error ? <p className="curaleaf-account-form__error" role="alert">{error}</p> : null}
          <div className="curaleaf-account-form__grid">
            <label>Pharmacist / contact name<input className="input" name="pharmacistName" value={fields.pharmacistName} onChange={set('pharmacistName')} required autoComplete="name" /></label>
            <label>Pharmacy name<input className="input" name="pharmacyName" value={fields.pharmacyName} onChange={set('pharmacyName')} required autoComplete="organization" /></label>
            <label>Registered company name<input className="input" name="registeredCompanyName" value={fields.registeredCompanyName} onChange={set('registeredCompanyName')} required /></label>
            <label>Invoice address<textarea className="input" name="invoiceAddress" value={fields.invoiceAddress} onChange={set('invoiceAddress')} required rows={3} autoComplete="billing street-address" /></label>
            <label>Delivery address<textarea className="input" name="deliveryAddress" value={fields.deliveryAddress} onChange={set('deliveryAddress')} required rows={3} autoComplete="shipping street-address" /></label>
            <label>GPhC number<input className="input" name="gphcNumber" value={fields.gphcNumber} onChange={set('gphcNumber')} required inputMode="numeric" autoComplete="off" /></label>
            <label>Pharmacy email<input className="input" name="pharmacyEmail" type="email" value={fields.pharmacyEmail} onChange={set('pharmacyEmail')} required autoComplete="email" /></label>
            <label>Pharmacy telephone<input className="input" name="pharmacyPhone" type="tel" value={fields.pharmacyPhone} onChange={set('pharmacyPhone')} required autoComplete="tel" /></label>
            <label>Accounts email <span>(invoicing — main contact for questions)</span><input className="input" name="accountsEmail" type="email" value={fields.accountsEmail} onChange={set('accountsEmail')} required autoComplete="email" /></label>
            <label>Accounts telephone <span>(invoicing — main contact for questions)</span><input className="input" name="accountsPhone" type="tel" value={fields.accountsPhone} onChange={set('accountsPhone')} required autoComplete="tel" /></label>
            <label>Fax number <span>Optional</span><input className="input" name="faxNumber" type="tel" value={fields.faxNumber} onChange={set('faxNumber')} autoComplete="off" /></label>
            <p className="curaleaf-account-form__sign">
              <span>Signature</span>
              <strong className={fields.pharmacistName.trim() ? undefined : 'is-empty'}>{fields.pharmacistName.trim() || 'Appears here from the name above'}</strong>
              <em>Taken from the pharmacist / contact name. The date is added when you submit.</em>
            </p>
          </div>
        </div>
        <footer>
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Submitting…' : 'Submit'}</button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
