import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ApiRequestError, submitCuraleafAccountForm, type CompanyLookup } from '../shared/api';
import type { PharmsmartWelcome } from './types';
import { Answered, RequiredKey, Field, FormBottom, FormIntro, FormTop, Row, Section, Stepper, SummaryCard } from '../components/OnboardingFormParts';
import { curaleafFieldsFromCompany } from './company-prefill';
import { CURALEAF_FIELD_LABELS, curaleafFormProblems, curaleafProblemsFromServer, describeCuraleafProblems, type CuraleafFieldProblem } from './curaleafFormRules';

const LABELS: Record<keyof Fields, string> = CURALEAF_FIELD_LABELS;

export type CuraleafFormValues = Fields;

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

/**
 * The contact is the pharmacy's main contact PharmSmart sends, or else whoever signed in.
 * The rest comes from the pharmacy details PharmSmart sends. A field left empty stays blank.
 */
function blank(welcome: PharmsmartWelcome): Fields {
  const name = [welcome.firstName, welcome.lastName].filter(Boolean).join(' ').trim();
  const prefill = welcome.prefill ?? {};
  const from = (key: keyof NonNullable<PharmsmartWelcome['prefill']>) => prefill[key]?.trim() ?? '';
  return {
    pharmacistName: from('contactName') || name,
    pharmacyName: from('pharmacyName'),
    registeredCompanyName: from('registeredCompanyName'),
    invoiceAddress: from('invoiceAddress') || from('deliveryAddress'),
    deliveryAddress: from('deliveryAddress'),
    gphcNumber: welcome.gphcNumber?.trim() ?? '',
    pharmacyEmail: from('pharmacyEmail'),
    accountsEmail: from('accountsEmail'),
    pharmacyPhone: from('pharmacyPhone'),
    accountsPhone: from('accountsPhone'),
    faxNumber: from('faxNumber'),
  };
}


export function CuraleafAccountForm({
  open,
  welcome,
  company: startCompany = null,
  onClose,
  onSubmitted,
}: {
  open: boolean;
  welcome: PharmsmartWelcome;
  /** The company looked up on "Before you start": fills the registered name and invoice address. */
  company?: CompanyLookup | null;
  onClose: () => void;
  /**
   * The form is in; the request it made is where the Partner Terms are accepted next.
   * `company` is the Companies House record when the pharmacy looked one up.
   */
  onSubmitted: (values: CuraleafFormValues, requestId: string, company: CompanyLookup | null) => void;
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
  const company = startCompany;
  const companyRef = useRef(startCompany);
  companyRef.current = startCompany;
  const [fromCompany, setFromCompany] = useState<Array<keyof Fields>>([]);
  const pharmsmartStart = blank(welcome);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<CuraleafFieldProblem[]>([]);
  const [step, setStep] = useState<1 | 2>(1);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [alreadyReceived, setAlreadyReceived] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;
    const start = blank(welcomeRef.current);
    const looked = companyRef.current ? curaleafFieldsFromCompany(start, start, companyRef.current) : null;
    setFields(looked ? looked.fields : start);
    setFromCompany(looked ? looked.filled : []);
    setError(null);
    setProblems([]);
    setStep(1);
    setAlreadyReceived(null);
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


  const scrollTop = () => bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });

  /** Back to "Your details" with the fields that need fixing opened and named. */
  const showProblems = (found: CuraleafFieldProblem[]) => {
    setProblems(found);
    setError(describeCuraleafProblems(found));
    setStep(1);
    scrollTop();
  };

  const toCheck = () => {
    // The server's rules (lengths, a full email address), checked before the summary.
    const found = curaleafFormProblems(fields);
    if (found.length) { showProblems(found); return; }
    setProblems([]);
    setError(null);
    setStep(2);
    scrollTop();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (step === 1) { toCheck(); return; }
    const found = curaleafFormProblems(fields);
    if (found.length) { showProblems(found); return; }
    setBusy(true);
    setError(null);
    try {
      const created = await submitCuraleafAccountForm({
        ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.trim()])),
        signatureName: fields.pharmacistName.trim(),
        idempotencyKey: idempotencyKey.current,
      });
      onSubmitted(fields, created.id, company);
    } catch (cause) {
      // A second form for a pharmacy we already have is not a failure: say so plainly.
      if (cause instanceof ApiRequestError && cause.code === 'ONBOARDING_ALREADY_RECEIVED') {
        setAlreadyReceived(cause.message);
        setBusy(false);
        return;
      }
      const named = cause instanceof ApiRequestError && cause.details.length ? curaleafProblemsFromServer(cause.details, fields) : [];
      setBusy(false);
      if (named.length) { showProblems(named); return; }
      setError(cause instanceof ApiRequestError ? cause.message : 'The form could not be submitted. Try again.');
    }
  };

  const problemFor = (key: keyof Fields) => {
    const found = problems.find(problem => problem.field === key);
    return found ? `${LABELS[key]} ${found.problem}.` : null;
  };
  /** Filled in for the pharmacy (PharmSmart or Companies House): shown as a read row with Change. */
  const filledFor = (key: keyof Fields) => Boolean(pharmsmartStart[key]) || fromCompany.includes(key);
  const INPUT: Record<keyof Fields, Record<string, unknown>> = {
    pharmacyName: { required: true, autoComplete: 'organization' },
    registeredCompanyName: { required: true },
    gphcNumber: { required: true, inputMode: 'numeric', autoComplete: 'off' },
    pharmacistName: { required: true, autoComplete: 'name' },
    invoiceAddress: { required: true, autoComplete: 'billing street-address' },
    deliveryAddress: { required: true, autoComplete: 'shipping street-address' },
    pharmacyEmail: { required: true, type: 'email', autoComplete: 'email' },
    pharmacyPhone: { required: true, type: 'tel', autoComplete: 'tel' },
    accountsEmail: { required: true, type: 'email', autoComplete: 'email' },
    accountsPhone: { required: true, type: 'tel', autoComplete: 'tel' },
    faxNumber: { type: 'tel', autoComplete: 'off' },
  };
  const HINTS: Partial<Record<keyof Fields, string>> = {
    accountsEmail: 'Main contact for invoices.',
    accountsPhone: 'Main contact for invoices.',
  };
  const control = (key: keyof Fields, label?: string) => (key === 'invoiceAddress' || key === 'deliveryAddress'
    ? <textarea className="input" name={key} aria-label={label} value={fields[key]} onChange={set(key)} rows={3} {...INPUT[key]} />
    : <input className="input" name={key} aria-label={label} value={fields[key]} onChange={set(key)} {...INPUT[key]} />);

  /** A card of questions: filled-in answers first as read rows, then boxes for the rest. */
  const group = (title: string, keys: Array<keyof Fields>) => {
    const filled = keys.filter(filledFor);
    const open = keys.filter(key => !filledFor(key));
    return (
      <Section title={title}>
        {filled.map(key => (
          <Answered key={key} label={LABELS[key]} value={fields[key] || '—'} problem={problemFor(key)} optional={!INPUT[key].required}>
            {control(key, LABELS[key])}
            {HINTS[key] ? <span className="wpa-field__hint">{HINTS[key]}</span> : null}
          </Answered>
        ))}
        {open.length ? (
          <div className={filled.length ? 'wpa-grid has-rows-above' : 'wpa-grid'}>
            {open.map(key => (
              <Field key={key} label={LABELS[key]} hint={HINTS[key]} problem={problemFor(key)} optional={!INPUT[key].required} wide={key === 'invoiceAddress' || key === 'deliveryAddress' ? open.length === 1 : false}>
                {control(key)}
              </Field>
            ))}
          </div>
        ) : null}
      </Section>
    );
  };

  const filledCount = (Object.keys(fields) as Array<keyof Fields>).filter(filledFor).length;
  const signature = fields.pharmacistName.trim();

  return createPortal(
    <div className="onboarding-dialog" role="presentation">
      <button className="onboarding-dialog__backdrop" type="button" aria-label="Close form" onClick={onClose} disabled={busy} />
      <form className="onboarding-dialog__panel wpa" role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={event => void submit(event)} noValidate>
        <FormTop
          eyebrow="Curaleaf account"
          title={fields.pharmacyName.trim() || 'Your pharmacy'}
          titleId={titleId}
          onClose={onClose}
          closeLabel="Close form"
          disabled={busy}
          closeRef={closeRef}
        >
          <Stepper steps={['Your details', 'Check and sign']} current={step} onGo={index => (index === 1 ? setStep(1) : toCheck())} locked={busy || Boolean(alreadyReceived)} />
        </FormTop>
        <div className="wpa-body" ref={bodyRef}>
          <div className="wpa-content">
            {alreadyReceived ? <p className="wpa-banner is-green" role="status"><strong>Already received.</strong> {alreadyReceived}</p> : null}
            {error ? <p className="wpa-alert" role="alert">{error}</p> : null}

            {step === 1 ? (
              <>
                <FormIntro title="Your details">These go onto the Curaleaf account form, so you can order stock from Curaleaf Laboratories.</FormIntro>
                <RequiredKey />
                {filledCount ? (
                  <p className="wpa-note">We filled in {filledCount === 1 ? 'one detail' : `${filledCount} details`} for you. Check each one is right for your pharmacy, and use Change to correct it.</p>
                ) : null}
                {group('The pharmacy', ['pharmacyName', 'registeredCompanyName', 'gphcNumber', 'pharmacistName'])}
                {group('Addresses', ['invoiceAddress', 'deliveryAddress'])}
                {group('Contact details', ['pharmacyEmail', 'pharmacyPhone', 'accountsEmail', 'accountsPhone', 'faxNumber'])}
              </>
            ) : (
              <>
                <FormIntro title="Check and sign">Check your answers. They are written onto the Curaleaf account form exactly as shown.</FormIntro>
                <SummaryCard title="The pharmacy" step={1} onEdit={() => setStep(1)}>
                  <Row label="Pharmacy name" value={fields.pharmacyName} />
                  <Row label="Registered company name" value={fields.registeredCompanyName} />
                  <Row label="GPhC premises number" value={fields.gphcNumber} />
                  <Row label="Pharmacist / contact" value={fields.pharmacistName} />
                </SummaryCard>
                <SummaryCard title="Addresses" step={1} onEdit={() => setStep(1)}>
                  <Row label="Invoice address" value={fields.invoiceAddress} />
                  <Row label="Delivery address" value={fields.deliveryAddress} />
                </SummaryCard>
                <SummaryCard title="Contact details" step={1} onEdit={() => setStep(1)}>
                  <Row label="Pharmacy email" value={fields.pharmacyEmail} />
                  <Row label="Pharmacy telephone" value={fields.pharmacyPhone} />
                  <Row label="Accounts email" value={fields.accountsEmail} />
                  <Row label="Accounts telephone" value={fields.accountsPhone} />
                  <Row label="Fax number" value={fields.faxNumber} />
                </SummaryCard>
                <h4>Signature</h4>
                <div className="wpa-card">
                  <p className="curaleaf-account-form__sign"><strong className={signature ? undefined : 'is-empty'}>{signature || 'Add the pharmacist / contact name'}</strong></p>
                  <small className="wpa-tiny">Signed with the pharmacist / contact name. The date is added when you submit.</small>
                </div>
                <h4>What happens next</h4>
                <div className="wpa-card is-soft">
                  <ol>
                    <li>You accept the Partner Terms on the next screen.</li>
                    <li>Accepting sends this form to Curaleaf Laboratories to open your account.</li>
                  </ol>
                </div>
              </>
            )}
          </div>
        </div>
        <FormBottom status={<span className="wpa-save">{step === 1 ? 'Nothing is sent until you submit.' : 'The date is added when you submit.'}</span>}>
          {alreadyReceived ? (
            <button className="btn btn-primary wpa-next" type="button" onClick={onClose}>Close</button>
          ) : (
            <>
              {step === 2 ? <button type="button" className="wpa-back" onClick={() => { setStep(1); scrollTop(); }} disabled={busy}>Back</button> : null}
              <button className="btn btn-primary wpa-next" type="submit" disabled={busy}>
                {step === 1 ? 'Continue' : busy ? 'Submitting…' : 'Submit'} <span aria-hidden="true">→</span>
              </button>
            </>
          )}
        </FormBottom>
      </form>
    </div>,
    document.body,
  );
}
