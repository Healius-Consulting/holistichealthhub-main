import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ApiRequestError,
  type CompanyLookup,
  loadWorldpayApplication,
  lookUpCompany,
  saveWorldpayApplication,
  submitWorldpayApplication,
  type WorldpayApplicationOwner,
  type WorldpayApplicationView,
} from '../shared/api';
import {
  applyCompanyLookup,
  BAND_TEXT,
  firstStepWithProblems,
  isCompany,
  joinDob,
  markEdited,
  newPrincipal,
  peopleConfirmText,
  peopleStepName,
  shareTotal,
  splitDob,
  stepNames,
  stepProblems,
  tidyCompanyNumber,
  withGphcShown,
  worldpayWarnings,
  type WorldpayAnswers,
  type WorldpayPrincipalAnswers,
  type WorldpayProblem,
} from './applicationLogic';
import { WorldpayApplicationStatusPanel } from './WorldpayApplicationStatus';
import { Answered, Field, FormBottom, FormIntro, FormTop, OptionCards, Row, Section, Stepper, SummaryCard } from '../components/OnboardingFormParts';

/**
 * The Worldpay merchant application (spec 01, 18 Nov 2026): "Before you start" and
 * five steps, saved as a draft as the pharmacy types, then submitted once. The same
 * form opens from the onboarding page (held against the onboarding request), the
 * go-live checklist and Settings → Payments (held against the branch).
 */

const HHH_WEBSITE = 'https://www.holistichealthhub.live/';
const PRENOTE = 'Answered for you because it is the same for every Holistic Health Hub pharmacy. Change it only if it is wrong for your pharmacy.';
const TURNOVER = ['Under £500,000', '£500,000 to £1m', '£1m to £2m', '£2m to £5m', 'Over £5m'] as const;
const BUSINESS_TYPES = ['Limited company', 'PLC', 'LLP', 'Partnership', 'Sole trader'] as const;
const TITLES = ['Mr', 'Mrs', 'Miss', 'Ms', 'Dr', 'Other'] as const;
const EXISTING = [
  { value: 'no', label: 'No' },
  { value: 'online', label: 'Yes, for online payments, set up directly with Worldpay' },
  { value: 'card_machine', label: 'Yes, for a card machine only' },
] as const;
const SCHEME_QUESTIONS = [
  '1. Will sales be limited to the UK only? If not, please specify which countries.',
  '2. Please confirm that no sales can be made to the U.S.',
  '3. Please confirm: (a) you are licensed in all jurisdictions where you operate; (b) you have controls in place to ensure you only dispense and ship prescription or controlled drugs where legally permitted; (c) you do not export prescription drugs to countries where it is not allowed.',
  '4. Please confirm your agreement to the annual registration fees: Mastercard $1,000; Visa $950, waived with an approved accreditation such as GPhC.',
  '5. If online consultations are offered, please confirm who provides the service and whether they are affiliated with your business in any way.',
] as const;

type Declaration = { accurate: boolean; consent: boolean; signerName: string; signerPosition: string };
type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';
type LookupState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'found'; name: string; status: string }
  | { kind: 'not_found' }
  | { kind: 'unavailable' };

const num = (value: string) => (value.trim() === '' ? undefined : Number(value.replace(/[£,\s]/g, '')));
const shown = (value: number | undefined) => (value === undefined || Number.isNaN(value) ? '' : String(value));
const statusLabel = (status: string) => status.replace(/-/g, ' ');

export function WorldpayApplicationForm({
  open,
  owner,
  onClose,
  onChanged,
  startWithCompany,
}: {
  open: boolean;
  owner: WorldpayApplicationOwner;
  /** A Companies House lookup already run elsewhere (the Curaleaf form), applied to a new application. */
  startWithCompany?: CompanyLookup | null;
  onClose: () => void;
  /** The application was saved, submitted or answered "already have Worldpay online": refresh what depends on it. */
  onChanged?: (view: { status: WorldpayApplicationView['status']; existingAccount: string }) => void;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<WorldpayApplicationView<WorldpayAnswers> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<WorldpayAnswers | null>(null);
  const [step, setStep] = useState(0);
  const [problems, setProblems] = useState<WorldpayProblem[]>([]);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [declaration, setDeclaration] = useState<Declaration>({ accurate: false, consent: false, signerName: '', signerPosition: '' });
  const [lookup, setLookup] = useState<LookupState>({ kind: 'idle' });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const ids = useRef<{ id: string | null; version: number }>({ id: null, version: 0 });
  const dirty = useRef(false);
  const saving = useRef<Promise<void> | null>(null);
  const latest = useRef<WorldpayAnswers | null>(null);
  latest.current = answers;
  const ownerKey = owner.kind === 'branch' ? 'branch' : owner.onboardingRequestId;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const startCompanyRef = useRef(startWithCompany);
  startCompanyRef.current = startWithCompany;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setView(null);
    setAnswers(null);
    setLoadError(null);
    setProblems([]);
    setSaveState('idle');
    setSubmitError(null);
    setLookup({ kind: 'idle' });
    dirty.current = false;
    loadWorldpayApplication<WorldpayAnswers>(ownerRef.current).then(loaded => {
      if (cancelled) return;
      setView(loaded);
      ids.current = { id: loaded.id, version: loaded.version };
      if (loaded.answers) {
        const company = !loaded.id ? startCompanyRef.current : null;
        setAnswers(company ? applyCompanyLookup(loaded.answers, company) : loaded.answers);
        if (company) setLookup({ kind: 'found', name: company.companyName, status: company.status });
        setDeclaration(current => ({
          ...current,
          signerName: current.signerName || loaded.answers!.business.contactName,
          signerPosition: current.signerPosition || loaded.answers!.business.contactPosition,
        }));
      }
      setStep(0);
    }).catch(error => {
      if (!cancelled) setLoadError(error instanceof ApiRequestError ? error.message : 'The Worldpay application could not be opened. Try again.');
    });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      cancelled = true;
      document.body.style.overflow = previousOverflow;
    };
  }, [open, ownerKey]);

  /** Saves the latest answers; one save at a time, and the newest answers always win. */
  const save = useCallback(async () => {
    if (saving.current) await saving.current.catch(() => undefined);
    const current = latest.current;
    if (!current || !dirty.current) return;
    dirty.current = false;
    setSaveState('saving');
    const run = (async () => {
      try {
        const saved = await saveWorldpayApplication(ownerRef.current, { id: ids.current.id, version: ids.current.version, answers: current });
        ids.current = saved;
        setSaveState('saved');
        onChangedRef.current?.({ status: 'DRAFT', existingAccount: current.existingAccount });
      } catch (error) {
        dirty.current = true;
        setSaveState(error instanceof ApiRequestError && (error.code === 'WORLDPAY_DRAFT_CONFLICT' || error.code === 'WORLDPAY_APPLICATION_CONFLICT') ? 'conflict' : 'error');
        throw error;
      }
    })();
    saving.current = run;
    try { await run; } finally { if (saving.current === run) saving.current = null; }
  }, []);

  // Autosave a moment after the pharmacy stops typing.
  useEffect(() => {
    if (!answers || !dirty.current || saveState === 'conflict') return;
    const timer = window.setTimeout(() => { void save().catch(() => undefined); }, 1200);
    return () => window.clearTimeout(timer);
  }, [answers, save, saveState]);

  const update = useCallback((change: (current: WorldpayAnswers) => WorldpayAnswers) => {
    dirty.current = true;
    setAnswers(current => (current ? change(current) : current));
  }, []);

  const warnings = useMemo(() => (answers ? worldpayWarnings(answers) : []), [answers]);
  const problemFor = (path: string) => problems.find(problem => problem.path === path)?.message ?? null;
  const warnFor = (path: string) => warnings.find(warning => warning.path === path)?.message ?? null;

  const scrollTop = () => panelRef.current?.querySelector('.wpa-body')?.scrollTo({ top: 0, behavior: 'smooth' });

  const close = async () => {
    await save().catch(() => undefined);
    onClose();
  };

  if (!open) return null;

  const status = view?.status ?? null;
  const sent = status && status !== 'DRAFT';
  const names = answers ? stepNames(answers) : [];

  const goTo = (index: number) => {
    setProblems([]);
    setSubmitError(null);
    setStep(index);
    scrollTop();
  };

  const next = async () => {
    if (!answers) return;
    const found = stepProblems(answers, step);
    setProblems(found);
    if (found.length) { scrollTop(); return; }
    if (step === 1) {
      update(current => ({
        ...current,
        financials: { ...current.financials, accountName: current.financials.accountName.trim() ? current.financials.accountName : current.business.legalName },
      }));
      setDeclaration(current => ({
        ...current,
        signerName: current.signerName || answers.business.contactName,
        signerPosition: current.signerPosition || answers.business.contactPosition,
      }));
    }
    void save().catch(() => undefined);
    goTo(step + 1);
  };

  const chooseExisting = (value: WorldpayAnswers['existingAccount']) => {
    update(current => ({ ...current, existingAccount: value }));
    // "Already online with Worldpay" is recorded straight away: the checklist then asks for credentials instead.
    if (value === 'online') window.setTimeout(() => { void save().catch(() => undefined); }, 0);
  };

  const runLookup = async () => {
    if (!answers || lookup.kind === 'loading') return;
    const tidied = tidyCompanyNumber(answers.business.companyNumber);
    update(current => ({ ...current, business: { ...current.business, companyNumber: tidied } }));
    if (!/^(\d{8}|[A-Z]{2}\d{6})$/.test(tidied)) { setLookup({ kind: 'invalid' }); return; }
    setLookup({ kind: 'loading' });
    try {
      const company = await lookUpCompany(tidied);
      update(current => applyCompanyLookup(current, company));
      setLookup({ kind: 'found', name: company.companyName, status: company.status });
    } catch (error) {
      setLookup(error instanceof ApiRequestError && error.code === 'COMPANY_NOT_FOUND' ? { kind: 'not_found' } : { kind: 'unavailable' });
    }
  };

  const submit = async () => {
    if (!answers) return;
    const broken = firstStepWithProblems(answers);
    if (broken !== null) {
      setSubmitError(`Some answers on “${names[broken]}” need attention.`);
      setProblems(stepProblems(answers, broken));
      setStep(broken);
      scrollTop();
      return;
    }
    const declarationProblems: WorldpayProblem[] = [];
    if (!declaration.accurate || !declaration.consent) declarationProblems.push({ step: 'declaration', path: 'declaration.boxes', message: 'Tick both declaration boxes.' });
    if (declaration.signerName.trim().length < 2) declarationProblems.push({ step: 'declaration', path: 'declaration.signerName', message: 'Type your name.' });
    if (declaration.signerPosition.trim().length < 2) declarationProblems.push({ step: 'declaration', path: 'declaration.signerPosition', message: 'Type your position.' });
    setProblems(declarationProblems);
    if (declarationProblems.length) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      dirty.current = true;
      await save();
      if (!ids.current.id) throw new Error('The application could not be saved.');
      await submitWorldpayApplication(ownerRef.current, { id: ids.current.id, version: ids.current.version, answers, declaration });
      const loaded = await loadWorldpayApplication<WorldpayAnswers>(ownerRef.current);
      setView(loaded);
      onChangedRef.current?.({ status: loaded.status, existingAccount: answers.existingAccount });
      scrollTop();
    } catch (error) {
      if (error instanceof ApiRequestError && error.details.length) {
        const serverProblems = error.details.map(detail => ({ step: 'declaration' as const, path: detail.path, message: detail.message }));
        setSubmitError(`${error.message} ${serverProblems.map(problem => problem.message).join(' ')}`);
      } else {
        setSubmitError(error instanceof ApiRequestError ? error.message : 'The application could not be sent. Try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const saveLabel = {
    idle: '',
    saving: 'Saving…',
    saved: 'Saved',
    error: 'Not saved yet. Check your connection; we will try again.',
    conflict: 'Someone else at your pharmacy changed this application. Close it and open it again to see their changes.',
  }[saveState];
  const ended = step === 0 && (!answers?.existingAccount || answers.existingAccount === 'online');

  return createPortal(
    <div className="onboarding-dialog" role="presentation">
      <button className="onboarding-dialog__backdrop" type="button" aria-label="Close" onClick={() => void close()} disabled={submitting} />
      <div ref={panelRef} className="onboarding-dialog__panel wpa" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <FormTop
          eyebrow="Worldpay application"
          title={answers?.business.tradingName || 'Your pharmacy'}
          titleId={titleId}
          onClose={() => void close()}
          closeLabel={sent ? 'Close' : 'Save and close'}
          disabled={submitting}
        >
          {view && !sent && answers ? (
            <Stepper steps={names.slice(1)} current={step} introLabel="Before you start" onGo={goTo} locked={!answers.existingAccount || answers.existingAccount === 'online'} />
          ) : null}
        </FormTop>
        <div className="wpa-body">
          <div className="wpa-content">
            {loadError ? <p className="wpa-banner is-red" role="alert">{loadError}</p> : null}
            {!view && !loadError ? <p className="wpa-muted">Opening your application…</p> : null}
            {view && sent ? <WorldpayApplicationStatusPanel view={view} /> : null}
            {view && !sent && answers ? (
              <>
                {problems.length ? (
                  <div className="wpa-alert" role="alert">
                    <strong>{problems.length === 1 ? 'One answer needs attention' : `${problems.length} answers need attention`}</strong>
                    <ul>{problems.map(problem => <li key={problem.path + problem.message}>{problem.message}</li>)}</ul>
                  </div>
                ) : null}
                {submitError ? <p className="wpa-alert" role="alert">{submitError}</p> : null}

                {step === 0 ? <StartStep answers={answers} view={view} onChoose={chooseExisting} /> : null}
                {step === 1 ? <BusinessStep answers={answers} update={update} problemFor={problemFor} warnFor={warnFor} lookup={lookup} onLookup={() => void runLookup()} /> : null}
                {step === 2 ? <PeopleStep answers={answers} update={update} problemFor={problemFor} /> : null}
                {step === 3 ? <FinancialsStep answers={answers} update={update} problemFor={problemFor} warnFor={warnFor} /> : null}
                {step === 4 ? <CompletedStep answers={answers} update={update} problemFor={problemFor} s04Note={view.content.s04Note} /> : null}
                {step === 5 ? <CheckStep answers={answers} declaration={declaration} setDeclaration={setDeclaration} problemFor={problemFor} onEdit={goTo} /> : null}
              </>
            ) : null}
          </div>
        </div>
        {view && !sent && answers ? (
          <FormBottom
            status={(
              <>
                <span className={saveState === 'conflict' || saveState === 'error' ? 'wpa-save is-bad' : saveState === 'saved' ? 'wpa-save is-good' : 'wpa-save'} aria-live="polite">{saveLabel}</span>
                {step > 0 && saveState !== 'conflict' ? <button type="button" className="wpa-link" onClick={() => void close()}>Save and finish later</button> : null}
              </>
            )}
          >
            {step > 0 ? <button type="button" className="wpa-back" onClick={() => goTo(step - 1)}>Back</button> : null}
            {step < 5 ? (
              <button type="button" className="btn btn-primary wpa-next" onClick={() => void next()} disabled={ended}>
                {step === 0 ? 'Start application' : 'Continue'} <span aria-hidden="true">→</span>
              </button>
            ) : (
              <button type="button" className="btn btn-primary wpa-next" onClick={() => void submit()} disabled={submitting}>{submitting ? 'Sending…' : 'Submit application'}</button>
            )}
          </FormBottom>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

type Update = (change: (current: WorldpayAnswers) => WorldpayAnswers) => void;

function StartStep({ answers, view, onChoose }: { answers: WorldpayAnswers; view: WorldpayApplicationView<WorldpayAnswers>; onChoose: (value: WorldpayAnswers['existingAccount']) => void }) {
  const panel = view.content.pricingPanel;
  return (
    <>
      <FormIntro title="Apply for a Worldpay account">This lets your pharmacy take card payments by payment link through Holistic Health Hub.</FormIntro>
      <div className="wpa-start">
        <section className="wpa-price" aria-label="What it costs">
          <span className="wpa-price__label">{panel.label}</span>
          <strong className="wpa-price__big">{panel.price}</strong>
          <span className="wpa-price__note">{panel.priceNote}</span>
          <ul className="wpa-price__ticks">{panel.ticks.map(tick => <li key={tick}>{tick}</li>)}</ul>
          <div className="wpa-price__pci">
            <strong>{panel.pciLine}</strong>
            <span>{panel.pciNote}</span>
          </div>
          <small>{panel.footnote}</small>
        </section>
        <section className="wpa-handy" aria-label="Have these to hand">
          <h4>Have these to hand</h4>
          <ul>
            <li>Company number and VAT number</li>
            <li>Company bank details</li>
            <li>For <b>every director and every shareholder with 25% or more</b> (every shareholder, if no one has 25% or more): date of birth, home address, how long they have lived there, mobile and email</li>
          </ul>
        </section>
      </div>
      <Section title="Does this pharmacy already have a Worldpay account?" description="Choose the second option only if you activated online payments with Worldpay yourself. If your account was set up through an agent, choose No.">
        <OptionCards name="Existing Worldpay account" value={answers.existingAccount} options={EXISTING} onChange={onChoose} />
        {answers.existingAccount === 'online' ? (
          <div className="wpa-banner is-green">
            <strong>You do not need to apply.</strong>
            Get your API keys from your Worldpay dashboard and enter them in Settings → Payments. The guide there shows where to find them.
          </div>
        ) : null}
      </Section>
    </>
  );
}

function BusinessStep({ answers, update, problemFor, warnFor, lookup, onLookup }: {
  answers: WorldpayAnswers;
  update: Update;
  problemFor: (path: string) => string | null;
  warnFor: (path: string) => string | null;
  lookup: LookupState;
  onLookup: () => void;
}) {
  const b = answers.business;
  const tagged = (path: string) => Boolean(answers.companyLookup?.filled.includes(path));
  const set = (field: keyof WorldpayAnswers['business']) => (event: { target: { value: string } }) => {
    const value = event.target.value;
    update(current => markEdited({ ...current, business: { ...current.business, [field]: value } }, `business.${field}`));
  };
  const company = isCompany(answers);
  const lookupMessage = () => {
    switch (lookup.kind) {
      case 'loading': return <span className="wpa-field__hint">Looking up…</span>;
      case 'invalid': return <span className="wpa-field__warn">A company number is 8 characters, for example 01234567 or SC123456.</span>;
      case 'not_found': return <span className="wpa-field__warn">We could not find that company number at Companies House. Check it, or type your details below.</span>;
      case 'unavailable': return <span className="wpa-field__warn">Companies House is not available right now. You can type your details below and carry on.</span>;
      case 'found': return (
        <>
          <span className="wpa-found">✓ Found: {lookup.name}. <span>Not your company? Change the number and look up again.</span></span>
          {lookup.status !== 'active' ? <span className="wpa-field__warn">Companies House shows this company as {statusLabel(lookup.status)}. Check the number before you continue.</span> : null}
        </>
      );
      default: return <span className="wpa-field__hint">Your Companies House number. We use it to fill in your company details and directors.</span>;
    }
  };
  return (
    <>
      <FormIntro title="Your business">Company details first, then the pharmacy’s trading details.</FormIntro>

      <Section title="The company">
        <div className="wpa-grid">
          <Field label="Business type" problem={problemFor('business.businessType')} fromCompaniesHouse={tagged('business.businessType')}>
            <select className="input" value={b.businessType} onChange={set('businessType')}>
              <option value="">Choose…</option>
              {BUSINESS_TYPES.map(type => <option key={type}>{type}</option>)}
            </select>
          </Field>
          {company ? (
            <Field label="Company number" problem={problemFor('business.companyNumber')}>
              <span className="wpa-lookup">
                <input
                  className="input"
                  value={b.companyNumber}
                  onChange={set('companyNumber')}
                  onBlur={() => { if (/^(\d{8}|[A-Z]{2}\d{6})$/.test(tidyCompanyNumber(b.companyNumber)) && answers.companyLookup?.companyNumber !== tidyCompanyNumber(b.companyNumber)) onLookup(); }}
                  onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onLookup(); } }}
                  placeholder="e.g. 01234567"
                  autoComplete="off"
                />
                <button type="button" className="btn" onClick={onLookup} disabled={lookup.kind === 'loading'}>Look up</button>
              </span>
              {lookupMessage()}
            </Field>
          ) : <span />}
          <Field label="Legal name of business" problem={problemFor('business.legalName')} hint="Exactly as it appears on the company bank account." fromCompaniesHouse={tagged('business.legalName')}>
            <input className="input" value={b.legalName} onChange={set('legalName')} autoComplete="organization" />
          </Field>
          <Field label="Date the business started trading" problem={problemFor('business.tradingSince')} hint="If the pharmacy traded before the company was formed, keep the company’s date." fromCompaniesHouse={tagged('business.tradingSince')}>
            <input className="input" type="date" value={b.tradingSince} onChange={set('tradingSince')} />
          </Field>
          <Field label="Registered address" problem={problemFor('business.registeredAddress')} fromCompaniesHouse={tagged('business.registeredAddress')}>
            <textarea className="input" rows={3} value={b.registeredAddress} onChange={set('registeredAddress')} />
          </Field>
          <Field label="VAT registration number" problem={problemFor('business.vatNumber')} hint="Leave blank if not VAT registered.">
            <input className="input" value={b.vatNumber} onChange={set('vatNumber')} placeholder="GB123456789" />
          </Field>
        </div>
      </Section>

      <Section title="Answered for you" description={PRENOTE} tone="quiet">
        <Answered label="Nature of business" value={b.natureOfBusiness} problem={problemFor('business.natureOfBusiness')}>
          <input className="input" aria-label="Nature of business" value={b.natureOfBusiness} onChange={set('natureOfBusiness')} />
        </Answered>
        <Answered label="Description of business" value={b.businessDescription} problem={problemFor('business.businessDescription')}>
          <textarea className="input" aria-label="Description of business" rows={3} value={b.businessDescription} onChange={set('businessDescription')} />
          <span className="wpa-field__hint">Sent to Worldpay with the nature of business.</span>
        </Answered>
      </Section>

      <Section title="The pharmacy">
        <div className="wpa-grid">
          <Field label="Trading name" problem={problemFor('business.tradingName')} hint="The name patients know the pharmacy by.">
            <input className="input" value={b.tradingName} onChange={set('tradingName')} />
          </Field>
          <Field label="GPhC premises number" problem={problemFor('business.gphcNumber')} warn={warnFor('business.gphcNumber')} hint="The premises number, not a pharmacist’s own number.">
            <input className="input" value={b.gphcNumber} onChange={set('gphcNumber')} inputMode="numeric" />
          </Field>
          <Field label="Trading address" problem={problemFor('business.tradingAddress')} wide>
            <textarea className="input" rows={2} value={b.tradingAddress} onChange={set('tradingAddress')} autoComplete="street-address" />
          </Field>
          <Field label="Landline" problem={problemFor('business.landline')}>
            <input className="input" type="tel" value={b.landline} onChange={set('landline')} />
          </Field>
          <Field label="Mobile" problem={problemFor('business.mobile')}>
            <input className="input" type="tel" value={b.mobile} onChange={set('mobile')} />
          </Field>
          <Field label="Business email" problem={problemFor('business.businessEmail')} hint="The pharmacy’s general email address." wide>
            <input className="input" type="email" value={b.businessEmail} onChange={set('businessEmail')} />
          </Field>
        </div>
      </Section>

      <Section
        title="Does your pharmacy have its own website?"
        description="A website counts only if it is in your pharmacy’s trading name and shows the pharmacy’s name and address. A group or head-office page, a branch-finder entry, an NHS listing or a social media page does not count: choose No."
      >
        <OptionCards compact name="Own website" value={b.hasOwnWebsite} options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] as const} onChange={value => update(current => ({ ...current, business: { ...current.business, hasOwnWebsite: value } }))} />
        {problemFor('business.hasOwnWebsite') ? <span className="wpa-field__problem">{problemFor('business.hasOwnWebsite')}</span> : null}
        {b.hasOwnWebsite === 'yes' ? (
          <Field label="Website address" problem={problemFor('business.website')}>
            <input className="input" type="url" value={b.website} onChange={set('website')} placeholder="https://" />
          </Field>
        ) : null}
        {b.hasOwnWebsite === 'no' ? (
          <div className="wpa-banner is-green">
            We will give Worldpay the Holistic Health Hub website, and send them a short document explaining how patients are referred and how payment is taken. You do not need to do anything.
            <small>Website on the application: {HHH_WEBSITE}</small>
          </div>
        ) : null}
      </Section>

      <Section title="Who should Worldpay speak to?" description="The person Worldpay should contact about this application.">
        <div className="wpa-grid">
          <Field label="Contact name" problem={problemFor('business.contactName')}>
            <input className="input" value={b.contactName} onChange={set('contactName')} autoComplete="name" />
          </Field>
          <Field label="Contact position" problem={problemFor('business.contactPosition')}>
            <input className="input" value={b.contactPosition} onChange={set('contactPosition')} />
          </Field>
          <Field label="Contact phone" problem={problemFor('business.contactPhone')}>
            <input className="input" type="tel" value={b.contactPhone} onChange={set('contactPhone')} />
          </Field>
          <Field label="Contact email" problem={problemFor('business.contactEmail')} hint="Only needed if different from the business email.">
            <input className="input" type="email" value={b.contactEmail} onChange={set('contactEmail')} />
          </Field>
        </div>
      </Section>
    </>
  );
}

const initials = (person: WorldpayPrincipalAnswers) => `${person.firstNames.trim()[0] ?? ''}${person.surname.trim()[0] ?? ''}`.toUpperCase() || '?';

function PeopleStep({ answers, update, problemFor }: { answers: WorldpayAnswers; update: Update; problemFor: (path: string) => string | null }) {
  const type = answers.business.businessType;
  const soleTrader = type === 'Sole trader';
  const partnership = type === 'Partnership';
  const company = !soleTrader && !partnership;
  const lookup = answers.companyLookup;
  const total = shareTotal(answers);
  const setPerson = (index: number, change: Partial<WorldpayPrincipalAnswers>) => update(current => ({
    ...current,
    principals: current.principals.map((person, at) => (at === index ? { ...person, ...change } : person)),
  }));
  const people = answers.principals;
  return (
    <>
      <FormIntro title={peopleStepName(answers)}>
        {soleTrader ? 'Worldpay need details for the owner of the business.'
          : partnership ? <>Worldpay need details for <b>every partner</b> in the business.</>
            : <>Worldpay need details for <b>every director</b>, and for <b>every shareholder who owns 25% or more</b> of the company. If no one owns 25% or more, list <b>every shareholder</b>.</>}
      </FormIntro>
      {company && lookup ? (
        <div className="wpa-notes">
          <p className="wpa-note">We started this list from Companies House: current directors, and anyone recorded as owning 25% or more. Check it, complete each person, and add anyone missing.</p>
          {lookup.noSignificantOwners ? <p className="wpa-note is-amber">Companies House shows no one who owns 25% or more of this company, so please add <b>every shareholder</b>. Companies House does not give us their names.</p> : null}
          {lookup.notListed.length ? <p className="wpa-note is-amber">Not added, because we can only list people here: {lookup.notListed.join('; ')}. Worldpay may ask you about them.</p> : null}
        </div>
      ) : null}
      {problemFor('principals') ? <p className="wpa-field__problem">{problemFor('principals')}</p> : null}

      {people.map((person, index) => {
        const at = (field: string) => problemFor(`principals.${index}.${field}`);
        const dob = splitDob(person.dateOfBirth);
        const setDob = (part: 'day' | 'month' | 'year') => (event: { target: { value: string } }) => setPerson(index, { dateOfBirth: joinDob({ ...dob, [part]: event.target.value.replace(/\D/g, '').slice(0, part === 'year' ? 4 : 2) }) });
        const band = person.ownershipBand ? BAND_TEXT[person.ownershipBand] : null;
        const shareWarn = (() => {
          if (!person.ownershipBand || person.shareholding === undefined) return null;
          const [low, high] = person.ownershipBand.split('-').map(Number) as [number, number];
          const inBand = high === 100 ? person.shareholding >= low : person.shareholding > low && person.shareholding <= high;
          return inBand ? null : `This does not match Companies House (${band}). Please check.`;
        })();
        const name = `${person.firstNames} ${person.surname}`.trim();
        return (
          <article className="wpa-person" key={person.key || index}>
            <header className="wpa-person__head">
              <span className="wpa-person__avatar" aria-hidden="true">{initials(person)}</span>
              <span className="wpa-person__who">
                <strong>{name || `Person ${index + 1}`}</strong>
                <small>
                  {company ? (person.roles.map(role => (role === 'director' ? 'Director' : 'Shareholder')).join(' and ') || 'Role not chosen') : soleTrader ? 'Owner' : 'Partner'}
                  {person.fromCompaniesHouse ? ' · from Companies House' : ''}
                </small>
              </span>
              {people.length > 1 ? <button type="button" className="wpa-link is-danger" onClick={() => update(current => ({ ...current, principals: current.principals.filter((_, i) => i !== index) }))}>Remove</button> : null}
            </header>

            {company ? (
              <div className="wpa-roles" role="group" aria-label="Role">
                {(['director', 'shareholder'] as const).map(role => {
                  const on = person.roles.includes(role);
                  return (
                    <button
                      key={role}
                      type="button"
                      aria-pressed={on}
                      className={on ? 'wpa-toggle is-on' : 'wpa-toggle'}
                      onClick={() => setPerson(index, { roles: on ? person.roles.filter(r => r !== role) : [...person.roles, role] })}
                    >
                      {on ? '✓ ' : ''}{role === 'director' ? 'Director' : 'Shareholder'}
                    </button>
                  );
                })}
                {at('roles') ? <span className="wpa-field__problem">{at('roles')}</span> : null}
              </div>
            ) : null}

            <h5 className="wpa-subhead">About them</h5>
            <div className="wpa-grid">
              <Field label="Title" problem={at('title') ?? at('titleOther')}>
                <span className="wpa-inline">
                  <select className="input" value={person.title} onChange={event => setPerson(index, { title: event.target.value as WorldpayPrincipalAnswers['title'] })}>
                    <option value="">Choose…</option>
                    {TITLES.map(title => <option key={title}>{title}</option>)}
                  </select>
                  {person.title === 'Other' ? <input className="input" aria-label="Title" value={person.titleOther} onChange={event => setPerson(index, { titleOther: event.target.value })} placeholder="Type the title" /> : null}
                </span>
              </Field>
              <Field label="Date of birth" problem={at('dateOfBirth')} hint={person.fromCompaniesHouse && dob.month && !dob.day ? 'Companies House holds the month and year only. Add the day.' : undefined}>
                <span className="wpa-dob">
                  <input className={person.fromCompaniesHouse && dob.month && !dob.day ? 'input is-attention' : 'input'} aria-label="Day" placeholder="DD" inputMode="numeric" value={dob.day} onChange={setDob('day')} />
                  <input className="input" aria-label="Month" placeholder="MM" inputMode="numeric" value={dob.month} onChange={setDob('month')} />
                  <input className="input" aria-label="Year" placeholder="YYYY" inputMode="numeric" value={dob.year} onChange={setDob('year')} />
                </span>
              </Field>
              <Field label="First name(s)" problem={at('firstNames')} hint="As on their passport or driving licence.">
                <input className="input" value={person.firstNames} onChange={event => setPerson(index, { firstNames: event.target.value })} />
              </Field>
              <Field label="Surname" problem={at('surname')}>
                <input className="input" value={person.surname} onChange={event => setPerson(index, { surname: event.target.value })} />
              </Field>
              <Field label="Nationality" problem={at('nationality')}>
                <input className="input" value={person.nationality} onChange={event => setPerson(index, { nationality: event.target.value })} />
              </Field>
              <Field label="Country of residence" problem={at('countryOfResidence')}>
                <input className="input" value={person.countryOfResidence} onChange={event => setPerson(index, { countryOfResidence: event.target.value })} />
              </Field>
            </div>

            <h5 className="wpa-subhead">Home address</h5>
            <div className="wpa-grid">
              <Field label="Home address" problem={at('homeAddress')} hint="Their home address, not the pharmacy’s." wide>
                <textarea className="input" rows={2} value={person.homeAddress} onChange={event => setPerson(index, { homeAddress: event.target.value })} />
              </Field>
              <Field label="Years at this address" problem={at('yearsAtAddress')} hint="If less than 3, we will also ask for their previous home address.">
                <input className="input" type="number" min={0} step={1} value={shown(person.yearsAtAddress)} onChange={event => setPerson(index, { yearsAtAddress: num(event.target.value) })} />
              </Field>
              {person.yearsAtAddress !== undefined && person.yearsAtAddress < 3 ? (
                <Field label="Previous home address" problem={at('previousAddress')} hint="Needed because they have lived at the address above for less than 3 years." wide>
                  <textarea className="input" rows={2} value={person.previousAddress} onChange={event => setPerson(index, { previousAddress: event.target.value })} />
                </Field>
              ) : null}
            </div>

            <h5 className="wpa-subhead">Contact and shares</h5>
            <div className="wpa-grid">
              <Field label="Mobile" problem={at('mobile')}>
                <input className="input" type="tel" value={person.mobile} onChange={event => setPerson(index, { mobile: event.target.value })} />
              </Field>
              <Field label="Email" problem={at('email')}>
                <input className="input" type="email" value={person.email} onChange={event => setPerson(index, { email: event.target.value })} />
              </Field>
              <Field
                label={partnership ? 'Share of the business %' : 'Shareholding %'}
                problem={at('shareholding')}
                warn={shareWarn}
                hint={band ? `Companies House shows ${band}. Type the exact figure.` : company ? 'Type 0 for a director who holds no shares.' : undefined}
              >
                <input className="input" type="number" min={0} max={100} step={0.01} value={shown(person.shareholding)} onChange={event => setPerson(index, { shareholding: num(event.target.value) })} />
              </Field>
            </div>
          </article>
        );
      })}

      {!soleTrader || people.length === 0 ? (
        <button type="button" className="wpa-add" onClick={() => update(current => ({ ...current, principals: [...current.principals, newPrincipal({ roles: company ? ['director'] : [] })] }))}>
          + {soleTrader ? 'Add the owner' : 'Add another person'}
        </button>
      ) : null}

      <Section tone="quiet">
        <p className={total > 100 ? 'wpa-total is-bad' : 'wpa-total'}>
          {partnership ? 'Shares listed' : 'Shareholdings listed'}: <strong>{total}%</strong>{total > 100 ? ' — cannot be more than 100%' : ''}
        </p>
        <label className="wpa-check">
          <input type="checkbox" checked={answers.principalsConfirmed} onChange={event => { const checked = event.target.checked; update(current => ({ ...current, principalsConfirmed: checked })); }} />
          <span>{peopleConfirmText(answers)}</span>
        </label>
        {problemFor('principalsConfirmed') ? <span className="wpa-field__problem">{problemFor('principalsConfirmed')}</span> : null}
      </Section>
    </>
  );
}

const pounds = (value: number | undefined) => (value === undefined ? '—' : `£${value.toLocaleString('en-GB')}`);

function FinancialsStep({ answers, update, problemFor, warnFor }: { answers: WorldpayAnswers; update: Update; problemFor: (path: string) => string | null; warnFor: (path: string) => string | null }) {
  const f = answers.financials;
  const setText = (field: 'bankName' | 'accountName' | 'accountNumber' | 'sortCode' | 'turnoverBand') => (event: { target: { value: string } }) => {
    const value = event.target.value;
    update(current => ({ ...current, financials: { ...current.financials, [field]: value } }));
  };
  const setNumber = (field: 'turnoverFigure' | 'expectedCardPayments' | 'averageTransaction') => (event: { target: { value: string } }) => {
    const value = num(event.target.value);
    update(current => ({ ...current, financials: { ...current.financials, [field]: value } }));
  };
  const cardWarn = warnFor('financials.expectedCardPayments');
  return (
    <>
      <FormIntro title="Financials">Your turnover, what you expect to take by payment link, and where the money settles.</FormIntro>
      <Section title="Annual business turnover" description="Whole company, all branches, most recent financial year, including NHS income. If the company has not completed a financial year, choose your expected first-year figure.">
        <div className="wpa-grid">
          <Field label="Turnover" problem={problemFor('financials.turnoverBand')}>
            <select className="input" value={f.turnoverBand} onChange={setText('turnoverBand')}>
              <option value="">Choose…</option>
              {TURNOVER.map(band => <option key={band}>{band}</option>)}
            </select>
          </Field>
          {f.turnoverBand === 'Over £5m' ? (
            <Field label="Turnover figure (£)" problem={problemFor('financials.turnoverFigure')}>
              <input className="input" type="number" min={1} step={1} value={shown(f.turnoverFigure)} onChange={setNumber('turnoverFigure')} />
            </Field>
          ) : null}
        </div>
      </Section>

      <Section title="Answered for you" description={PRENOTE} tone="quiet">
        <Answered
          label="Expected card payments through this account, per year"
          value={pounds(f.expectedCardPayments)}
          problem={problemFor('financials.expectedCardPayments')}
          note={cardWarn ? <span className="wpa-field__warn">{cardWarn}</span> : null}
        >
          <input className="input" aria-label="Expected card payments per year (£)" type="number" min={1} step={1} value={shown(f.expectedCardPayments)} onChange={setNumber('expectedCardPayments')} />
          <span className="wpa-field__hint">Payments taken by payment link for Holistic Health Hub medicine orders in a year at this pharmacy, not your shop card machine.</span>
        </Answered>
        <Answered label="Average transaction value" value={pounds(f.averageTransaction)} problem={problemFor('financials.averageTransaction')}>
          <input className="input" aria-label="Average transaction value (£)" type="number" min={1} step={0.01} value={shown(f.averageTransaction)} onChange={setNumber('averageTransaction')} />
          <span className="wpa-field__hint">A typical patient order. Change it if you have a better figure for your pharmacy.</span>
        </Answered>
      </Section>

      <Section title="Company bank account" description="Card payments for this pharmacy settle here. Must be a UK business account.">
        <div className="wpa-grid">
          <Field label="Name of bank" problem={problemFor('financials.bankName')}>
            <input className="input" value={f.bankName} onChange={setText('bankName')} />
          </Field>
          <Field label="Name on account" problem={problemFor('financials.accountName')} hint="Normally the registered company name, exactly as shown on the account.">
            <input className="input" value={f.accountName} onChange={setText('accountName')} />
          </Field>
          <Field label="Account number" problem={problemFor('financials.accountNumber')} hint="8 digits.">
            <input className="input" value={f.accountNumber} onChange={setText('accountNumber')} inputMode="numeric" autoComplete="off" />
          </Field>
          <Field label="Sort code" problem={problemFor('financials.sortCode')} hint="6 digits, for example 12-34-56.">
            <input className="input" value={f.sortCode} onChange={setText('sortCode')} inputMode="numeric" autoComplete="off" />
          </Field>
        </div>
      </Section>
    </>
  );
}

function CompletedStep({ answers, update, problemFor, s04Note }: { answers: WorldpayAnswers; update: Update; problemFor: (path: string) => string | null; s04Note: string }) {
  const t = answers.transactions;
  type PercentKey = keyof Omit<WorldpayAnswers['transactions'], 'terminalConnection'>;
  const setPercent = (field: PercentKey) => (event: { target: { value: string } }) => {
    const value = num(event.target.value);
    update(current => ({ ...current, transactions: { ...current.transactions, [field]: value } }));
  };
  const how = (t.faceToFace ?? 0) + (t.phone ?? 0) + (t.internet ?? 0);
  const when = (t.immediate ?? 0) + (t.oneToThreeDays ?? 0) + (t.threeToFiveDays ?? 0) + (t.fivePlusDays ?? 0);
  const total = (value: number) => <p className={value === 100 ? 'wpa-total is-good' : 'wpa-total is-bad'}>Total {value}% {value === 100 ? '✓' : '— must equal 100%'}</p>;
  const percent = (label: string, field: PercentKey, hint?: string) => (
    <Field label={label} hint={hint}>
      <input className="input" type="number" min={0} max={100} step={1} value={shown(t[field])} onChange={setPercent(field)} />
    </Field>
  );
  const pct = (value: number | undefined) => `${value ?? 0}%`;
  const keys = ['s01', 's02', 's03', 's04', 's05'] as const;
  return (
    <>
      <FormIntro title="Pre-filled">These answers are the same for every Holistic Health Hub pharmacy, so we have filled them in. Please read them, because you confirm them when you submit. Change one only if it is wrong for your pharmacy.</FormIntro>

      <Section title="Nature of transactions" tone="quiet">
        <Answered label="Card machine connection" value={t.terminalConnection} problem={problemFor('transactions.terminalConnection')}>
          <input className="input" aria-label="Card machine connection" value={t.terminalConnection} onChange={event => { const value = event.target.value; update(current => ({ ...current, transactions: { ...current.transactions, terminalConnection: value } })); }} />
          <span className="wpa-field__hint">This account is for payment links only. If you also want a Worldpay card machine, tell us and we will raise it separately.</span>
        </Answered>
        <Answered label="How payments are taken" value={`Face to face ${pct(t.faceToFace)} · Over the phone ${pct(t.phone)} · Via the internet ${pct(t.internet)}`} problem={problemFor('transactions.how')}>
          <div className="wpa-grid is-three">
            {percent('Face to face %', 'faceToFace')}
            {percent('Over the phone %', 'phone')}
            {percent('Via the internet %', 'internet')}
          </div>
          <span className="wpa-field__hint">Payments are taken by a payment link emailed to the patient, so 100% is online.</span>
          {total(how)}
        </Answered>
        <Answered
          label="When the customer receives the goods"
          value={`Immediately ${pct(t.immediate)} · 1 to 3 days ${pct(t.oneToThreeDays)} · 3 to 5 days ${pct(t.threeToFiveDays)} · 5 days or more ${pct(t.fivePlusDays)}`}
          problem={problemFor('transactions.when')}
        >
          <div className="wpa-grid is-four">
            {percent('Immediately %', 'immediate')}
            {percent('1 to 3 days %', 'oneToThreeDays')}
            {percent('3 to 5 days %', 'threeToFiveDays')}
            {percent('5+ days %', 'fivePlusDays')}
          </div>
          <span className="wpa-field__hint">The patient pays before the medicine is ordered, then collects it or has it delivered.</span>
          {total(when)}
        </Answered>
      </Section>

      <Section title="Card scheme questions" description="Visa and Mastercard ask these of every pharmacy that takes payment online." tone="quiet">
        {keys.map((key, index) => (
          <Answered
            key={key}
            label={SCHEME_QUESTIONS[index]!}
            value={withGphcShown(answers.scheme[key], answers.business.gphcNumber)}
            problem={problemFor(`scheme.${key}`)}
            note={key === 's04' ? <p className="wpa-note is-amber">{s04Note}</p> : null}
          >
            <textarea
              className="input"
              aria-label={SCHEME_QUESTIONS[index]!}
              rows={key === 's05' ? 8 : 4}
              value={withGphcShown(answers.scheme[key], answers.business.gphcNumber)}
              onChange={event => { const value = event.target.value; update(current => ({ ...current, scheme: { ...current.scheme, [key]: value } })); }}
            />
          </Answered>
        ))}
      </Section>
    </>
  );
}

function CheckStep({ answers, declaration, setDeclaration, problemFor, onEdit }: {
  answers: WorldpayAnswers;
  declaration: Declaration;
  setDeclaration: (change: (current: Declaration) => Declaration) => void;
  problemFor: (path: string) => string | null;
  onEdit: (step: number) => void;
}) {
  const b = answers.business;
  const f = answers.financials;
  const t = answers.transactions;
  const s = answers.scheme;
  const website = b.hasOwnWebsite === 'yes' ? b.website : b.hasOwnWebsite === 'no' ? HHH_WEBSITE : '';
  const contactEmail = b.contactEmail || b.businessEmail;
  const role = (person: WorldpayPrincipalAnswers) => person.roles.map(r => (r === 'director' ? 'Director' : 'Shareholder')).join(' and ');
  return (
    <section>
      <h3 className="wpa-title">Check and send</h3>
      <h4>Your answers</h4>
      <SummaryCard title="Your business" step={1} onEdit={onEdit}>
        <Row label="Legal name" value={b.legalName} />
        <Row label="Business type" value={b.businessType} />
        {isCompany(answers) ? <Row label="Company number" value={b.companyNumber} /> : null}
        <Row label="Registered address" value={b.registeredAddress} />
        <Row label="Trading name" value={b.tradingName} />
        <Row label="GPhC premises number" value={b.gphcNumber} />
        <Row label="Nature of business" value={b.natureOfBusiness} />
        <Row label="Description of business" value={b.businessDescription} />
        <Row label="Website" value={website} />
        <Row label="Contact" value={[b.contactName, b.contactPosition, b.contactPhone, contactEmail].filter(Boolean).join(', ')} />
      </SummaryCard>
      <SummaryCard title={peopleStepName(answers)} step={2} onEdit={onEdit}>
        {answers.principals.map((person, index) => (
          <Row key={person.key || index} label={`${person.firstNames} ${person.surname}`.trim() || `Person ${index + 1}`} value={`${role(person) ? `${role(person)} · ` : ''}${person.shareholding ?? 0}%`} />
        ))}
      </SummaryCard>
      <SummaryCard title="Financials" step={3} onEdit={onEdit}>
        <Row label="Annual turnover" value={f.turnoverBand === 'Over £5m' && f.turnoverFigure ? `£${f.turnoverFigure.toLocaleString('en-GB')}` : f.turnoverBand} />
        <Row label="Expected card payments per year" value={f.expectedCardPayments ? `£${f.expectedCardPayments.toLocaleString('en-GB')}` : ''} />
        <Row label="Average transaction" value={f.averageTransaction ? `£${f.averageTransaction}` : ''} />
        <Row label="Bank account" value={f.bankName ? `${f.bankName} · account ending ${f.accountNumber.replace(/\s+/g, '').slice(-4)}` : ''} />
      </SummaryCard>
      <SummaryCard title="Pre-filled" step={4} onEdit={onEdit}>
        <Row label="Card machine connection" value={t.terminalConnection} />
        <Row label="How payments are taken" value={`Face to face ${t.faceToFace ?? 0}% · phone ${t.phone ?? 0}% · internet ${t.internet ?? 0}%`} />
        <Row label="When goods are received" value={`Immediately ${t.immediate ?? 0}% · 1 to 3 days ${t.oneToThreeDays ?? 0}% · 3 to 5 days ${t.threeToFiveDays ?? 0}% · 5 days or more ${t.fivePlusDays ?? 0}%`} />
        <Row label="American Express" value="No" />
        <Row label="1. UK sales only" value={s.s01} />
        <Row label="2. No sales to the U.S." value={s.s02} />
        <Row label="3. Licensing and controls" value={withGphcShown(s.s03, b.gphcNumber)} />
        <Row label="4. Card scheme fees" value={withGphcShown(s.s04, b.gphcNumber)} />
        <Row label="5. Online consultations" value={s.s05} />
      </SummaryCard>

      <h4>What happens next</h4>
      <div className="wpa-card is-soft">
        <ol>
          <li>We send your application to Worldpay.</li>
          <li>Worldpay may contact {b.contactName || 'your contact'} with questions. They may also ask for ID verification: photo ID and a recent proof of home address for each director and owner.</li>
          <li>Worldpay send you their agreement to sign. The contract is between your pharmacy and Worldpay.</li>
          <li>When your account is open, Worldpay send you login details for your Worldpay dashboard. Log in, find your API keys there, and paste them into Settings → Payments on Holistic Health Hub. That completes the set-up and switches card payments on.</li>
        </ol>
        <small className="wpa-tiny">Until then you can keep taking payment in the pharmacy and recording it on the platform as you do now.</small>
      </div>

      <h4>Declaration</h4>
      <label className="wpa-check">
        <input type="checkbox" checked={declaration.accurate} onChange={event => { const checked = event.target.checked; setDeclaration(current => ({ ...current, accurate: checked })); }} />
        <span>I confirm that the information in this application is accurate and complete, and that I am authorised to give it on behalf of {b.legalName || 'the business'}.</span>
      </label>
      <label className="wpa-check">
        <input type="checkbox" checked={declaration.consent} onChange={event => { const checked = event.target.checked; setDeclaration(current => ({ ...current, consent: checked })); }} />
        <span>I consent to Holistic Health Hub passing this information to Worldpay for our merchant account application. Holistic Health Hub uses it for no other purpose.</span>
      </label>
      {problemFor('declaration.boxes') ? <span className="wpa-field__problem">{problemFor('declaration.boxes')}</span> : null}
      <div className="wpa-grid">
        <Field label="Your name (typed, as your signature)" problem={problemFor('declaration.signerName')}>
          <input className="input" value={declaration.signerName} onChange={event => { const value = event.target.value; setDeclaration(current => ({ ...current, signerName: value })); }} autoComplete="name" />
        </Field>
        <Field label="Your position" problem={problemFor('declaration.signerPosition')}>
          <input className="input" value={declaration.signerPosition} onChange={event => { const value = event.target.value; setDeclaration(current => ({ ...current, signerPosition: value })); }} />
        </Field>
      </div>
    </section>
  );
}
