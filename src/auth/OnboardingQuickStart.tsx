import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiRequestError, lookUpCompany, type CompanyLookup } from '../shared/api';
import { Field, FormBottom, FormIntro, FormTop, Section } from '../components/OnboardingFormParts';

/**
 * "Before you start" for partner onboarding: what the three forms are, what to have to
 * hand, and the Companies House lookup. The company found here fills in all three
 * forms (Curaleaf account, Partner Terms through the company name, Worldpay), so it is
 * asked once, here, not inside one of them.
 */

type LookupState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'not_found' }
  | { kind: 'unavailable' };

const tidy = (input: string) => {
  const compact = input.replace(/\s+/g, '').toUpperCase();
  return /^\d{1,7}$/.test(compact) ? compact.padStart(8, '0') : compact;
};
const valid = (number: string) => /^(\d{8}|[A-Z]{2}\d{6})$/.test(number);
const statusLabel = (status: string) => status.replace(/-/g, ' ');

const STEPS = [
  { title: 'Curaleaf account', detail: 'Opens your account with Curaleaf Laboratories, so you can order stock.', tag: 'Required' },
  { title: 'Partner Terms', detail: 'You accept the terms for the pharmacy. Accepting sends your Curaleaf form.', tag: 'Required' },
  { title: 'Worldpay card payments', detail: 'Lets patients pay by card through a secure link. You can do this later.', tag: 'Optional' },
] as const;

export function OnboardingQuickStart({ open, pharmacyName, company, onClose, onStart }: {
  open: boolean;
  pharmacyName: string;
  /** A company already looked up in this visit. */
  company: CompanyLookup | null;
  onClose: () => void;
  /** Go on to the Curaleaf form, with the company found (or none). */
  onStart: (company: CompanyLookup | null) => void;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [number, setNumber] = useState(company?.companyNumber ?? '');
  const [found, setFound] = useState<CompanyLookup | null>(company);
  const [lookup, setLookup] = useState<LookupState>({ kind: 'idle' });

  useEffect(() => {
    if (!open) return;
    setNumber(company?.companyNumber ?? '');
    setFound(company);
    setLookup({ kind: 'idle' });
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCloseRef.current(); };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, company]);

  if (!open) return null;

  const run = async () => {
    const tidied = tidy(number);
    setNumber(tidied);
    if (!valid(tidied)) { setLookup({ kind: 'invalid' }); return; }
    if (found?.companyNumber === tidied) return;
    setLookup({ kind: 'loading' });
    try {
      setFound(await lookUpCompany(tidied));
      setLookup({ kind: 'idle' });
    } catch (error) {
      setFound(null);
      setLookup(error instanceof ApiRequestError && error.code === 'COMPANY_NOT_FOUND' ? { kind: 'not_found' } : { kind: 'unavailable' });
    }
  };

  const people = found?.people.length ?? 0;
  const message = {
    idle: null,
    loading: <span className="wpa-field__hint">Looking up…</span>,
    invalid: <span className="wpa-field__warn">A company number is 8 characters, for example 01234567 or SC123456.</span>,
    not_found: <span className="wpa-field__warn">We could not find that company number at Companies House. Check it, or skip this and type your details in the forms.</span>,
    unavailable: <span className="wpa-field__warn">Companies House is not available right now. You can skip this and type your details in the forms.</span>,
  }[lookup.kind];

  return createPortal(
    <div className="onboarding-dialog" role="presentation">
      <button className="onboarding-dialog__backdrop" type="button" aria-label="Close" onClick={onClose} />
      <div className="onboarding-dialog__panel wpa" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <FormTop eyebrow="Set up with Holistic Health Hub" title={pharmacyName || 'Your pharmacy'} titleId={titleId} onClose={onClose} closeLabel="Close" closeRef={closeRef} />
        <div className="wpa-body">
          <div className="wpa-content">
            <FormIntro title="Before you start">Setting up takes three short forms. What you tell us in one carries into the next, so you only type it once.</FormIntro>

            <ol className="wpa-journey" aria-label="The three forms">
              {STEPS.map((step, index) => (
                <li key={step.title}>
                  <span className="wpa-journey__number" aria-hidden="true">{index + 1}</span>
                  <span className="wpa-journey__text">
                    <strong>{step.title}</strong>
                    <span>{step.detail}</span>
                  </span>
                  <span className={step.tag === 'Optional' ? 'wpa-journey__tag is-optional' : 'wpa-journey__tag'}>{step.tag}</span>
                </li>
              ))}
            </ol>

            <Section
              title="Your company number"
              description="If your pharmacy is a limited company, we look it up at Companies House and use it in all three forms. You can skip this and type your details instead."
            >
              <Field label="Companies House number">
                <span className="wpa-lookup">
                  <input
                    className="input"
                    value={number}
                    onChange={event => { setNumber(event.target.value); setLookup({ kind: 'idle' }); }}
                    onBlur={() => { if (valid(tidy(number)) && found?.companyNumber !== tidy(number)) void run(); }}
                    onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void run(); } }}
                    placeholder="e.g. 01234567"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button type="button" className="btn" onClick={() => void run()} disabled={lookup.kind === 'loading'}>Look up</button>
                </span>
                {message}
              </Field>

              {found ? (
                <div className="wpa-company" aria-live="polite">
                  <div className="wpa-company__head">
                    <strong>{found.companyName}</strong>
                    <span className={found.active ? 'wpa-pill is-ok' : 'wpa-pill is-warn'}>{found.active ? 'Active' : statusLabel(found.status)}</span>
                  </div>
                  <span className="wpa-company__meta">Company {found.companyNumber} · {found.registeredAddress}</span>
                  {!found.active ? (
                    <p className="wpa-note is-amber">Companies House shows this company as {statusLabel(found.status)}. Check the number before you carry on.</p>
                  ) : null}
                  <ul className="wpa-company__uses">
                    <li><b>Curaleaf account</b> the registered company name and invoice address</li>
                    <li><b>Partner Terms</b> the company you sign for</li>
                    <li><b>Worldpay</b> the company details{people ? ` and ${people === 1 ? 'one director or owner' : `${people} directors and owners`}` : ''}</li>
                  </ul>
                  <button type="button" className="wpa-link" onClick={() => { setFound(null); setNumber(''); }}>Not your company? Clear it</button>
                </div>
              ) : null}
            </Section>

            <div className="wpa-handy">
              <h4>Have these to hand</h4>
              <ul>
                <li>The pharmacy’s GPhC premises number</li>
                <li>Invoice and delivery addresses, and an accounts contact (email and phone)</li>
                <li>For Worldpay: the company bank details, and each director’s date of birth and home address</li>
              </ul>
            </div>
          </div>
        </div>
        <FormBottom status={<span className="wpa-save">Nothing is sent until you submit a form.</span>}>
          <button type="button" className="btn btn-primary wpa-next" onClick={() => onStart(found)} disabled={lookup.kind === 'loading'}>
            Start with the Curaleaf form <span aria-hidden="true">→</span>
          </button>
        </FormBottom>
      </div>
    </div>,
    document.body,
  );
}
