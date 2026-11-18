import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ApiRequestError, submitWorldpayForm, describeApiError, type CompanyLookup } from '../shared/api';
import { PrefillReviewBanner } from './PrefillReviewBanner';
import { CompanyLookupBox } from './CompanyLookupBox';
import { worldpayFromCompany } from './company-prefill';

/** Worldpay's own answers, already filled in on their spreadsheet. The pharmacy can change them. */
const DEFAULTS = {
  natureOfBusiness: '47730 - Dispensing chemist in specialised stores',
  terminalConnection: 'Not required',
  faceToFacePercent: '0',
  phonePercent: '0',
  internetPercent: '100',
  immediatePercent: '0',
  oneToThreeDaysPercent: '100',
  threeToFiveDaysPercent: '0',
  fivePlusDaysPercent: '0',
  annualCardTurnover: '250000',
  averageTransaction: '187',
  takeAmex: 'No',
  salesCountries: 'Sales are limited to the UK only.',
  noUsSales: 'Confirmed.',
  complianceConfirmations: 'All confirmed.',
  registrationFees: 'Confirmed. However, Mastercard will not be used. Pharmacy GPhC registration number found above.',
  onlineConsultations: 'No online consultations are provided by the pharmacy.',
};

const PRINCIPAL = {
  title: '', firstNames: '', surname: '', dateOfBirth: '', nationality: '', homeAddress: '',
  countryOfResidence: 'United Kingdom', yearsAtAddress: '', previousAddress: '', mobile: '', email: '', shareholding: '',
};

type Principal = typeof PRINCIPAL;

const BUSINESS = {
  legalName: '', tradingName: '', contactName: '', contactPosition: '', contactPhone: '', businessType: '',
  registrationNumber: '', registeredAddress: '', gphcNumber: '', tradingAddress: '', landline: '', mobile: '',
  businessEmail: '', website: '', vatNumber: '', tradingSince: '', annualTurnover: '', bankName: '', accountName: '',
  accountNumber: '', sortCode: '',
};

type Fields = typeof BUSINESS & typeof DEFAULTS;

/** Business details the pharmacy has already given, from PharmSmart, the Curaleaf form or Companies House. */
export type WorldpayStart = Partial<Pick<Fields,
  'legalName' | 'tradingName' | 'contactName' | 'contactPosition' | 'contactPhone' | 'gphcNumber' | 'registeredAddress' | 'tradingAddress' | 'landline' | 'businessEmail'
  | 'businessType' | 'registrationNumber' | 'tradingSince'
>>;

/** A principal's details we already hold: PharmSmart's superintendent, or a director from Companies House. */
export type WorldpayPrincipalStart = Partial<Pick<Principal, 'firstNames' | 'surname' | 'email' | 'mobile' | 'nationality' | 'countryOfResidence'>>;

const BUSINESS_TYPES = ['Ltd Co', 'Sole Trader', 'Partnership', 'LLP', 'PLC'];
const MAX_PRINCIPALS = 4;

const PREFILL_LABELS: Record<keyof WorldpayStart, string> = {
  legalName: 'Legal name',
  tradingName: 'Trading name',
  contactName: 'Contact name',
  contactPosition: 'Contact position',
  contactPhone: 'Contact phone',
  gphcNumber: 'GPhC premises number',
  registeredAddress: 'Registered address',
  tradingAddress: 'Trading address',
  landline: 'Landline',
  businessEmail: 'Business email',
  businessType: 'Business type',
  registrationNumber: 'Company registration number',
  tradingSince: 'Trading since',
};

const PRINCIPAL_LABELS: Record<keyof WorldpayPrincipalStart, string> = {
  firstNames: 'Principal first name(s)',
  surname: 'Principal surname',
  email: 'Principal email',
  mobile: 'Principal mobile',
  nationality: 'Principal nationality',
  countryOfResidence: 'Principal country of residence',
};

function filledOnly<T extends Record<string, string | undefined>>(values: T) {
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => Boolean(entry[1]?.trim())),
  ) as Partial<Record<keyof T, string>>;
}

function start(prefill: WorldpayStart): Fields {
  const filled = filledOnly(prefill) as WorldpayStart;
  return { ...BUSINESS, ...DEFAULTS, ...filled, accountName: filled.legalName ?? '' };
}

function firstPrincipal(prefill: WorldpayPrincipalStart): Principal {
  return { ...PRINCIPAL, ...filledOnly(prefill) };
}

function startPrincipals(principals: WorldpayPrincipalStart[] | undefined, principal: WorldpayPrincipalStart): Principal[] {
  return principals?.length ? principals.slice(0, MAX_PRINCIPALS).map(firstPrincipal) : [firstPrincipal(principal)];
}

function Field({ label, hint, wide, children }: { label: string; hint?: string; wide?: boolean; children: ReactNode }) {
  return (
    <label className={wide ? 'is-wide' : undefined}>
      <span className="worldpay-form__label">{label}{hint ? <span>{hint}</span> : null}</span>
      {children}
    </label>
  );
}

export function WorldpayForm({
  open,
  prefill,
  principal = {},
  principalsStart,
  onClose,
  onSubmitted,
  send = submitWorldpayForm,
  prefillSource = 'your PharmSmart account and Curaleaf form',
  companyNumber,
}: {
  open: boolean;
  prefill: WorldpayStart;
  principal?: WorldpayPrincipalStart;
  /** Several principals to start with (a company's directors); used instead of `principal` when given. */
  principalsStart?: WorldpayPrincipalStart[];
  onClose: () => void;
  onSubmitted: (result: { submittedAt: string }) => void;
  /** The portal posts to its own route, recorded against the signed-in branch. */
  send?: (input: Record<string, unknown>) => Promise<{ submittedAt: string }>;
  prefillSource?: string;
  /** The Companies House number already looked up on the Curaleaf form, if any. */
  companyNumber?: string;
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const idempotencyKey = useRef(crypto.randomUUID());
  const prefillRef = useRef(prefill);
  const principalRef = useRef(principal);
  const principalsRef = useRef(principalsStart);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(false);
  prefillRef.current = prefill;
  principalRef.current = principal;
  principalsRef.current = principalsStart;
  onCloseRef.current = onClose;
  const [fields, setFields] = useState<Fields>(() => start(prefill));
  const [principals, setPrincipals] = useState<Principal[]>(() => startPrincipals(principalsStart, principal));
  // What the form opened with, so a lookup can tell untouched fields from the pharmacy's own.
  const openedWith = useRef({ fields: start(prefill), principals: startPrincipals(principalsStart, principal) });
  const current = useRef({ fields, principals });
  current.current = { fields, principals };
  const prefilled = [...new Set([
    ...(Object.keys(filledOnly(prefill)) as Array<keyof WorldpayStart>).map(key => PREFILL_LABELS[key]),
    ...(principalsStart?.length ? principalsStart : [principal]).flatMap(person => (Object.keys(filledOnly(person)) as Array<keyof WorldpayPrincipalStart>).map(key => PRINCIPAL_LABELS[key])),
  ])];
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;
    const opening = { fields: start(prefillRef.current), principals: startPrincipals(principalsRef.current, principalRef.current) };
    openedWith.current = opening;
    setFields(opening.fields);
    setPrincipals(opening.principals);
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
  const setPrincipal = (index: number, key: keyof Principal) => (event: { target: { value: string } }) => {
    setPrincipals(current => current.map((person, at) => (at === index ? { ...person, [key]: event.target.value } : person)));
  };
  const applyCompany = (company: CompanyLookup) => {
    const result = worldpayFromCompany({
      fields: current.current.fields,
      startFields: openedWith.current.fields,
      principals: current.current.principals,
      startPrincipals: openedWith.current.principals,
      blankPrincipal: PRINCIPAL,
      company,
      max: MAX_PRINCIPALS,
    });
    setFields(result.fields);
    setPrincipals(result.principals);
    return result.filled;
  };
  const input = (key: keyof Fields, props: Record<string, unknown> = {}) => (
    <input className="input" name={key} value={fields[key]} onChange={set(key)} {...props} />
  );

  const howTotal = ['faceToFacePercent', 'phonePercent', 'internetPercent'].reduce((sum, key) => sum + (Number(fields[key as keyof Fields]) || 0), 0);
  const whenTotal = ['immediatePercent', 'oneToThreeDaysPercent', 'threeToFiveDaysPercent', 'fivePlusDaysPercent']
    .reduce((sum, key) => sum + (Number(fields[key as keyof Fields]) || 0), 0);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    if (!form.checkValidity()) {
      const invalid = form.querySelector<HTMLElement>(':invalid');
      invalid?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      form.reportValidity();
      return;
    }
    if (howTotal !== 100 || whenTotal !== 100) {
      form.querySelector('.worldpay-form__defaults')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      setError('The transaction percentages must each add up to 100%.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const trimmed = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.trim()]));
      const result = await send({
        ...trimmed,
        principals: principals.map(person => Object.fromEntries(Object.entries(person).map(([key, value]) => [key, value.trim()]))),
        idempotencyKey: idempotencyKey.current,
      });
      onSubmitted(result);
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? describeApiError(cause, 'The form could not be sent. Try again.') : 'The form could not be sent. Try again.');
      setBusy(false);
    }
  };

  return createPortal(
    <div className="onboarding-dialog" role="presentation">
      <button className="onboarding-dialog__backdrop" type="button" aria-label="Close form" onClick={onClose} disabled={busy} />
      <form className="onboarding-dialog__panel curaleaf-account-form worldpay-form" role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={event => void submit(event)} noValidate={false}>
        <header>
          <h2 id={titleId}>Worldpay card payments</h2>
          <button ref={closeRef} type="button" onClick={onClose} disabled={busy}>Close</button>
        </header>
        <div className="curaleaf-account-form__body">
          <p>Worldpay needs these details to open your card account. They are emailed to our team as a PDF to pass on to Worldpay. The platform does not keep a copy.</p>
          <PrefillReviewBanner fields={prefilled} source={prefillSource} />
          <CompanyLookupBox
            intro={prefilled.length
              ? `Some details are already filled in from ${prefillSource}. If your pharmacy is a limited company, enter its Companies House number to bring in the latest registered details and its directors, and anything not filled in yet.`
              : 'If your pharmacy is a limited company, enter its Companies House number and we will fill in its registered details and its directors.'}
            initialNumber={companyNumber}
            disabled={busy}
            onFound={applyCompany}
          />
          {error ? <p className="curaleaf-account-form__error" role="alert">{error}</p> : null}
          <div className="curaleaf-account-form__grid">
            <fieldset>
              <legend>About your business</legend>
              <Field label="Legal name of business">{input('legalName', { required: true, autoComplete: 'organization' })}</Field>
              <Field label="Trading name">{input('tradingName', { required: true })}</Field>
              <Field label="Business type">
                <select className="input" name="businessType" value={fields.businessType} onChange={set('businessType')} required>
                  <option value="">Choose</option>
                  {BUSINESS_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
                </select>
              </Field>
              <Field label="Company registration number" hint="If registered">{input('registrationNumber')}</Field>
              <Field label="Registered address" wide>
                <textarea className="input" name="registeredAddress" value={fields.registeredAddress} onChange={set('registeredAddress')} required rows={2} />
              </Field>
              <Field label="Trading address" wide>
                <textarea className="input" name="tradingAddress" value={fields.tradingAddress} onChange={set('tradingAddress')} required rows={2} />
              </Field>
              <Field label="GPhC premises number">{input('gphcNumber', { required: true, inputMode: 'numeric' })}</Field>
              <Field label="Business email">{input('businessEmail', { required: true, type: 'email' })}</Field>
              <Field label="Landline" hint="Optional">{input('landline', { type: 'tel' })}</Field>
              <Field label="Mobile" hint="Optional">{input('mobile', { type: 'tel' })}</Field>
              <Field label="Website" hint="Optional">{input('website', { type: 'url', placeholder: 'https://' })}</Field>
              <Field label="VAT registration number" hint="Optional">{input('vatNumber')}</Field>
              <Field label="Trading since" hint="Optional">{input('tradingSince', { placeholder: 'e.g. March 2015' })}</Field>
            </fieldset>

            <fieldset>
              <legend>Contact for Worldpay</legend>
              <Field label="Contact name">{input('contactName', { required: true, autoComplete: 'name' })}</Field>
              <Field label="Position">{input('contactPosition', { required: true, placeholder: 'e.g. Director' })}</Field>
              <Field label="Phone">{input('contactPhone', { required: true, type: 'tel' })}</Field>
            </fieldset>

            {principals.map((person, index) => (
              <fieldset key={index}>
                <legend>
                  {principals.length > 1 ? `Principal ${index + 1}` : 'Principal'}
                  <span>Owner or director</span>
                  {index > 0 ? (
                    <button type="button" className="worldpay-form__remove" onClick={() => setPrincipals(current => current.filter((_, at) => at !== index))}>Remove</button>
                  ) : null}
                </legend>
                <Field label="Title" hint="Optional">
                  <input className="input" value={person.title} onChange={setPrincipal(index, 'title')} autoComplete="honorific-prefix" />
                </Field>
                <Field label="First name(s)"><input className="input" value={person.firstNames} onChange={setPrincipal(index, 'firstNames')} required autoComplete="given-name" /></Field>
                <Field label="Surname"><input className="input" value={person.surname} onChange={setPrincipal(index, 'surname')} required autoComplete="family-name" /></Field>
                <Field label="Date of birth"><input className="input" type="date" value={person.dateOfBirth} onChange={setPrincipal(index, 'dateOfBirth')} required autoComplete="bday" /></Field>
                <Field label="Nationality"><input className="input" value={person.nationality} onChange={setPrincipal(index, 'nationality')} required /></Field>
                <Field label="Country of residence"><input className="input" value={person.countryOfResidence} onChange={setPrincipal(index, 'countryOfResidence')} required autoComplete="country-name" /></Field>
                <Field label="Home address" wide>
                  <textarea className="input" value={person.homeAddress} onChange={setPrincipal(index, 'homeAddress')} required rows={2} autoComplete="street-address" />
                </Field>
                <Field label="Years at this address"><input className="input" value={person.yearsAtAddress} onChange={setPrincipal(index, 'yearsAtAddress')} required inputMode="numeric" /></Field>
                <Field label="Shareholding %"><input className="input" value={person.shareholding} onChange={setPrincipal(index, 'shareholding')} required inputMode="decimal" /></Field>
                <Field label="Previous address" hint="If under 3 years at this one" wide>
                  <textarea className="input" value={person.previousAddress} onChange={setPrincipal(index, 'previousAddress')} rows={2} />
                </Field>
                <Field label="Mobile"><input className="input" type="tel" value={person.mobile} onChange={setPrincipal(index, 'mobile')} required /></Field>
                <Field label="Email"><input className="input" type="email" value={person.email} onChange={setPrincipal(index, 'email')} required /></Field>
              </fieldset>
            ))}
            {principals.length < MAX_PRINCIPALS ? (
              <button type="button" className="worldpay-form__add" onClick={() => setPrincipals(current => [...current, { ...PRINCIPAL }])}>
                Add another principal
              </button>
            ) : null}

            <fieldset>
              <legend>Bank account <span>For card payouts</span></legend>
              <Field label="Bank name">{input('bankName', { required: true })}</Field>
              <Field label="Name on account">{input('accountName', { required: true })}</Field>
              <Field label="Account number">{input('accountNumber', { required: true, inputMode: 'numeric', pattern: '\\s*(\\d\\s*){8}', title: '8 digits', autoComplete: 'off' })}</Field>
              <Field label="Sort code">{input('sortCode', { required: true, inputMode: 'numeric', pattern: '\\s*\\d{2}[\\s\\-]?\\d{2}[\\s\\-]?\\d{2}\\s*', title: '6 digits, e.g. 12-34-56', placeholder: '12-34-56', autoComplete: 'off' })}</Field>
              <Field label="Annual business turnover (£)">{input('annualTurnover', { required: true, inputMode: 'numeric' })}</Field>
            </fieldset>

            <section className="worldpay-form__defaults" aria-labelledby="worldpay-defaults-title">
              <div className="worldpay-form__defaults-head">
                <span className="worldpay-form__badge">Pre-filled</span>
                <strong id="worldpay-defaults-title">Check the answers we have filled in</strong>
                <span>We have answered these from how the service works. Read each one and change anything that is not right for your pharmacy.</span>
              </div>
              <fieldset>
                <legend>Nature of business</legend>
                <Field label="Nature of business" wide>{input('natureOfBusiness', { required: true })}</Field>
                <Field label="Terminal connection">{input('terminalConnection', { required: true })}</Field>
                <Field label="Take AMEX">
                  <select className="input" name="takeAmex" value={fields.takeAmex} onChange={set('takeAmex')}>
                    <option>No</option>
                    <option>Yes</option>
                  </select>
                </Field>
                <Field label="Annual card turnover (£)">{input('annualCardTurnover', { required: true, inputMode: 'numeric' })}</Field>
                <Field label="Average transaction (£)">{input('averageTransaction', { required: true, inputMode: 'decimal' })}</Field>
              </fieldset>
              <fieldset>
                <legend>How transactions are taken <span className={howTotal === 100 ? 'is-ok' : 'is-off'}>Total {howTotal}%</span></legend>
                <Field label="Face to face %">{input('faceToFacePercent', { required: true, type: 'number', min: 0, max: 100 })}</Field>
                <Field label="Over the phone %">{input('phonePercent', { required: true, type: 'number', min: 0, max: 100 })}</Field>
                <Field label="Online %">{input('internetPercent', { required: true, type: 'number', min: 0, max: 100 })}</Field>
              </fieldset>
              <fieldset>
                <legend>When customers receive goods <span className={whenTotal === 100 ? 'is-ok' : 'is-off'}>Total {whenTotal}%</span></legend>
                <Field label="Immediately %">{input('immediatePercent', { required: true, type: 'number', min: 0, max: 100 })}</Field>
                <Field label="1-3 days %">{input('oneToThreeDaysPercent', { required: true, type: 'number', min: 0, max: 100 })}</Field>
                <Field label="3-5 days %">{input('threeToFiveDaysPercent', { required: true, type: 'number', min: 0, max: 100 })}</Field>
                <Field label="5+ days %">{input('fivePlusDaysPercent', { required: true, type: 'number', min: 0, max: 100 })}</Field>
              </fieldset>
              <fieldset>
                <legend>Visa / Mastercard questions</legend>
                {([
                  ['salesCountries', 'Will sales be limited to the UK only?'],
                  ['noUsSales', 'Confirm no sales can be made to the U.S.'],
                  ['complianceConfirmations', 'Confirm you are licensed, dispense only where legal, and do not export prescription drugs'],
                  ['registrationFees', 'Confirm the annual card scheme registration fees'],
                  ['onlineConsultations', 'If online consultations are offered, who provides them?'],
                ] as const).map(([key, label]) => (
                  <Field key={key} label={label} wide>
                    <textarea className="input" name={key} value={fields[key]} onChange={set(key)} required rows={2} />
                  </Field>
                ))}
              </fieldset>
            </section>
          </div>
        </div>
        <footer>
          <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send form'}</button>
        </footer>
      </form>
    </div>,
    document.body,
  );
}
