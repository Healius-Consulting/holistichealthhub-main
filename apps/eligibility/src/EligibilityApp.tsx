import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ClipboardCheck, HeartPulse, Home, Info, LoaderCircle, LockKeyhole, MapPin, Search, ShieldCheck } from 'lucide-react';
import { CONDITIONS, conditionLabel } from '@hhh/domain';
import { createEligibilitySubmission, createV2Intake, resolvePublicReferralToken, searchPublicPharmacies } from '../../../src/shared/api';
import { HOLISTIC_HEALTH_HUB_ALLOCATION_LABEL, publicDirectoryPharmacyName, type EligibilitySubmissionInput, type PostcodeSearchReceipt, type PublicDirectoryResult, type PublicPharmacy, type V2IntakeReceipt } from '../../../src/shared/contracts';
import { tenantThemeVariables } from '../../../src/utils/tenantTheme';
import { EMAIL_LOGO_SPEC } from '../../../src/utils/pharmacyLogo';
import { parseEligibilityReferralRoute } from './referralRoute';
import { latestEligibleDateOfBirth } from '../../../src/utils/eligibilityAge';

const LOCAL_PREVIEW_TOKEN = 'local-preview';
const HHH_MARK = '/holistic-health-hub-mark.png';
const LOCAL_PREVIEW_PHARMACY: PublicPharmacy = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Holistic Health Pharmacy',
  tradingName: 'Holistic Health Pharmacy',
  logoText: 'HH',
  logoUrl: HHH_MARK,
  gphcNumber: '9012345',
  superintendent: 'Local preview',
  address: 'Local preview — no patient data is stored',
  primaryColour: '#0f766e',
};
const HHH_PUBLIC_IDENTITY: PublicPharmacy = {
  id: 'holistic-health-hub', name: 'Holistic Health Hub', tradingName: 'Holistic Health Hub', logoText: 'HHH',
  gphcNumber: '', superintendent: '', address: '', primaryColour: '#124f3b',
};
const PUBLIC_HOME_HREF = '/';
const PUBLIC_SITE_HREF = 'https://holistichealthhub.live';
const TERMS_HREF = '/terms';
const PRIVACY_HREF = '/privacy';
/** Review requests land in the pharmacist queue; a pharmacist, not the form, reconsiders. */

/**
 * The pharmacy is the controller for the referral service, so patient-facing copy
 * names it rather than HHH. A token form knows the pharmacy from the start; the
 * master site cannot name one until the patient picks, so it says "your pharmacy".
 */
function LegalLink({ href, children }: { href: string; children: ReactNode }) {
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}

function EligibilityBrand({
  identity,
  token,
}: {
  identity: Pick<PublicPharmacy, 'name' | 'logoUrl'>;
  token: string;
}) {
  const [logoFailed, setLogoFailed] = useState(false);
  const pharmacyLogo = token && identity.logoUrl && !logoFailed ? identity.logoUrl : null;
  useEffect(() => { setLogoFailed(false); }, [identity.logoUrl]);
  const identityMarkup = <>
    <img className="eligibility-brand__mark" src={HHH_MARK} alt="" width="46" height="46" />
    <span>
      <strong>Holistic Health Hub</strong>
      <small>{token ? `In partnership with ${identity.name}` : 'Personalised healthcare'}</small>
    </span>
  </>;
  return <header className={`eligibility-brand${pharmacyLogo ? ' eligibility-brand--pharmacy-logo' : ''}`} aria-label={token ? `${identity.name} eligibility` : 'Holistic Health Hub eligibility'}>
    <div className="eligibility-brand__inner">
      {token
        ? <div className="eligibility-brand__identity">{identityMarkup}</div>
        : <a className="eligibility-brand__identity" href={PUBLIC_HOME_HREF} aria-label="Holistic Health Hub Home">{identityMarkup}</a>}
      {pharmacyLogo ? (
        <img
          className="eligibility-brand__pharmacy-logo"
          src={pharmacyLogo}
          alt={`${identity.name} logo`}
          width={EMAIL_LOGO_SPEC.displayWidth}
          height={EMAIL_LOGO_SPEC.displayHeight}
          onError={() => setLogoFailed(true)}
        />
      ) : null}
      <div className="eligibility-brand__actions">
        {token
          ? <a className="eligibility-home" href={PUBLIC_SITE_HREF} target="_blank" rel="noopener noreferrer" aria-label="More info about Holistic Health Hub (opens in a new tab)"><Info size={15} aria-hidden="true" /> More info</a>
          : <a className="eligibility-home" href={PUBLIC_HOME_HREF}><Home size={15} aria-hidden="true" /> Return home</a>}
        <span className="eligibility-brand__secure"><LockKeyhole size={14} /> Private and secure</span>
      </div>
    </div>
  </header>;
}

function directoryContactLine(result: PublicDirectoryResult) {
  return result.website?.trim() ?? '';
}

/**
 * Terms 3.1 tells patients to choose a pharmacy they can collect from or that
 * delivers to them, so the picker has to show each one's option before they pick.
 */
function directoryFulfilmentLine(result: PublicDirectoryResult) {
  const options: string[] = [];
  if (result.collectionAvailable) options.push('Collection');
  if (result.deliveryCapability !== 'none') options.push(result.deliverySummary?.trim() || 'Delivery available');
  return options.join(' · ');
}

/**
 * The controller's own identity, shown where Privacy 1.1 and 1.5 promise it: beside
 * the pharmacy in the picker, and in the header of a token form where the patient
 * never sees a picker at all. Anything the pharmacy has not supplied is left out
 * rather than shown as an empty label.
 */
function PharmacyControllerDetails({ pharmacy, className }: {
  pharmacy: Pick<PublicPharmacy, 'name' | 'address' | 'gphcNumber' | 'icoRegistrationNumber' | 'privacyContactEmail' | 'dataProtectionOfficer' | 'complaintsContactEmail' | 'complaintsContactPhone'>;
  className?: string;
}) {
  const rows: Array<[string, string]> = [];
  if (pharmacy.address?.trim()) rows.push(['Address', pharmacy.address]);
  if (pharmacy.gphcNumber?.trim()) rows.push(['GPhC premises', pharmacy.gphcNumber]);
  if (pharmacy.icoRegistrationNumber?.trim()) rows.push(['ICO registration', pharmacy.icoRegistrationNumber]);
  if (pharmacy.dataProtectionOfficer?.trim()) rows.push(['Data Protection Officer', pharmacy.dataProtectionOfficer]);
  if (pharmacy.privacyContactEmail?.trim()) rows.push(['Privacy contact', pharmacy.privacyContactEmail]);
  const complaints = [pharmacy.complaintsContactEmail, pharmacy.complaintsContactPhone].filter(v => v?.trim()).join(' · ');
  if (complaints) rows.push(['Complaints', complaints]);
  if (!rows.length) return null;
  return <dl className={`eligibility-controller-details${className ? ` ${className}` : ''}`}>
    {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
  </dl>;
}

function EligibilityShell({
  themeStyle,
  pharmacyThemed = false,
  children,
}: {
  themeStyle: CSSProperties;
  pharmacyThemed?: boolean;
  children: ReactNode;
}) {
  return (
    <main
      className={`eligibility-shell tenant-surface${pharmacyThemed ? ' eligibility-shell--tenant' : ''}`}
      style={themeStyle}
    >
      {children}
    </main>
  );
}

export default function EligibilityApp() {
  const [referralRoute] = useState(() => parseEligibilityReferralRoute(window.location.search));
  const token = referralRoute.kind === 'token' ? referralRoute.token : '';
  const isLocalPreview = import.meta.env.DEV && token === LOCAL_PREVIEW_TOKEN;
  const [pharmacy, setPharmacy] = useState<PublicPharmacy | null>(null);
  const [intakeVersion, setIntakeVersion] = useState<'v1' | 'v2'>(token ? 'v1' : 'v2');
  const [search, setSearch] = useState<PostcodeSearchReceipt | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchPostcode, setSearchPostcode] = useState('');
  const [selectedDirectoryProfileId, setSelectedDirectoryProfileId] = useState<string | null>(null);
  const [manualProceed, setManualProceed] = useState(false);
  const [receipt, setReceipt] = useState<V2IntakeReceipt | null>(null);
  const idempotencyKey = useRef(crypto.randomUUID());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [complete, setComplete] = useState(false);
  const [eligible, setEligible] = useState(false);
  const [selectedConditions, setSelectedConditions] = useState<string[]>([]);
  const [primaryCondition, setPrimaryCondition] = useState('');
  const [conditionError, setConditionError] = useState('');
  const [treatmentHistory, setTreatmentHistory] = useState<'' | 'yes' | 'no'>('');
  const [psychHistory, setPsychHistory] = useState<'' | 'yes' | 'no'>('');
  const conditionMenuRef = useRef<HTMLDetailsElement>(null);
  const themeStyle = tenantThemeVariables(pharmacy?.primaryColour ?? '#0f766e') as CSSProperties;
  const pharmacyThemed = Boolean(token && (pharmacy || loading));

  useEffect(() => {
    if (referralRoute.kind === 'invalid-token') {
      setError('This pharmacy link is not valid or is no longer active.');
      setLoading(false);
      return;
    }
    if (isLocalPreview) { setPharmacy(LOCAL_PREVIEW_PHARMACY); setLoading(false); return; }
    if (referralRoute.kind === 'general') { setPharmacy(HHH_PUBLIC_IDENTITY); setLoading(false); return; }
    resolvePublicReferralToken(token)
      .then(result => { setPharmacy(result.pharmacy); setIntakeVersion(result.intakeVersion); })
      .catch(() => setError('This pharmacy link is not valid or is no longer active.'))
      .finally(() => setLoading(false));
  }, [isLocalPreview, referralRoute, token]);

  useEffect(() => {
    const closeConditionMenu = (event: PointerEvent) => {
      const menu = conditionMenuRef.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.removeAttribute('open');
    };
    const closeConditionMenuWithKeyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !conditionMenuRef.current?.open) return;
      conditionMenuRef.current.removeAttribute('open');
      conditionMenuRef.current.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', closeConditionMenu);
    document.addEventListener('keydown', closeConditionMenuWithKeyboard);
    return () => {
      document.removeEventListener('pointerdown', closeConditionMenu);
      document.removeEventListener('keydown', closeConditionMenuWithKeyboard);
    };
  }, []);

  const resetLocationChoice = () => {
    setSearch(null);
    setSelectedDirectoryProfileId(null);
    setManualProceed(false);
    setPharmacy(HHH_PUBLIC_IDENTITY);
  };

  const runPostcodeSearch = async () => {
    if (!searchPostcode.trim()) return;
    setSearching(true); setError(''); setSelectedDirectoryProfileId(null); setManualProceed(false);
    setPharmacy(HHH_PUBLIC_IDENTITY);
    try {
      const result = await searchPublicPharmacies(searchPostcode);
      setSearch(result);
      setSearchPostcode(result.postcode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'We could not check that postcode. Please try again.');
    } finally { setSearching(false); }
  };

  const choosePharmacy = (result: PublicDirectoryResult) => {
    setSelectedDirectoryProfileId(result.id);
    setManualProceed(false);
    const pharmacyName = publicDirectoryPharmacyName(result);
    setPharmacy({ ...HHH_PUBLIC_IDENTITY, id: result.id, name: pharmacyName, tradingName: pharmacyName, gphcNumber: result.gphcNumber, address: result.addressSummary });
  };

  const continueManual = () => { setSelectedDirectoryProfileId(null); setPharmacy(HHH_PUBLIC_IDENTITY); setManualProceed(true); };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!pharmacy || (!token && (!search || (!selectedDirectoryProfileId && !manualProceed)))) return;
    if (selectedConditions.length < 1 || selectedConditions.length > 3) {
      setConditionError('Select between one and three conditions.');
      return;
    }
    if (!primaryCondition || !selectedConditions.includes(primaryCondition)) {
      setConditionError('Choose one of your selected conditions as the primary condition.');
      return;
    }
    setSubmitting(true); setError('');
    const consentVersion = token ? 'pharmacy-qr-v2.2' as const : 'general-public-v2.2' as const;
    const data = new FormData(event.currentTarget);
    const input: EligibilitySubmissionInput = {
      referralToken: token,
      firstName: String(data.get('firstName')), surname: String(data.get('surname')),
      dob: String(data.get('dob')), mobile: String(data.get('mobile')), email: String(data.get('email')),
      postcode: String(data.get('postcode')), conditions: selectedConditions, primaryCondition,
      tried2: data.get('tried2') === 'yes', psychExclusion: data.get('psychExclusion') === 'yes',
      consentReferral: data.get('consentReferral') === 'on', consentShare: data.get('consentShare') === 'on',
      marketing: data.get('marketing') === 'on', source: String(data.get('source') || 'Not provided'),
    };
    try {
      if (!isLocalPreview) {
        if (intakeVersion === 'v1') await createEligibilitySubmission({ ...input, heardAbout: input.source, consentVersion });
        else setReceipt(await createV2Intake({
          ...(token
            ? { type: 'future_pharmacy_qr' as const, referralToken: token }
            : { type: 'general_hhh_website' as const, searchId: search!.searchId, selectedDirectoryProfileId }),
          firstName: input.firstName, surname: input.surname, dob: input.dob, mobile: input.mobile, email: input.email,
          postcode: input.postcode, conditions: input.conditions, primaryCondition: input.primaryCondition,
          tried2: input.tried2, psychExclusion: input.psychExclusion, consentReferral: true, consentShare: true,
          marketing: input.marketing, heardAbout: input.source,
          consentVersion, idempotencyKey: idempotencyKey.current,
        }));
      }
      // The screening answers are recorded for HHH admin to weigh; every application
      // is received the same way and the decision comes from a person.
      setEligible(true);
      setComplete(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'We could not submit the form. Please try again.');
    } finally { setSubmitting(false); }
  };

  const toggleCondition = (conditionId: string) => {
    const isSelected = selectedConditions.includes(conditionId);
    if (!isSelected && selectedConditions.length >= 3) return;
    const next = isSelected
      ? selectedConditions.filter(id => id !== conditionId)
      : [...selectedConditions, conditionId];
    setSelectedConditions(next);
    if (primaryCondition === conditionId) setPrimaryCondition(next.length === 1 ? next[0] ?? '' : '');
    else if (next.length === 1) setPrimaryCondition(next[0] ?? '');
    setConditionError('');
  };

  if (loading) return <EligibilityShell themeStyle={themeStyle} pharmacyThemed={pharmacyThemed}><EligibilityBrand identity={HHH_PUBLIC_IDENTITY} token={token} /><section className="eligibility-card eligibility-message"><LoaderCircle className="spin" size={34} /><h1>Checking your pharmacy link</h1></section></EligibilityShell>;
  if (error && !pharmacy) return <EligibilityShell themeStyle={themeStyle} pharmacyThemed={pharmacyThemed}><EligibilityBrand identity={HHH_PUBLIC_IDENTITY} token={token} /><section className="eligibility-card eligibility-message"><AlertTriangle size={36} /><h1>Unable to open this form</h1><p>{error}</p><p>Please ask your pharmacy for its current eligibility link.</p>{!token && <a className="eligibility-home" href={PUBLIC_HOME_HREF}><Home size={16} aria-hidden="true" /> Return home</a>}</section></EligibilityShell>;
  if (!pharmacy) return null;

  const brandIdentity = token ? pharmacy : HHH_PUBLIC_IDENTITY;
  const maxDateOfBirth = latestEligibleDateOfBirth();
  // "[Pharmacy]" in the approved copy: the trading name on a token form, and a
  // generic reference on the master site, where the choice is made in section 01.
  const pharmacyRef = token ? pharmacy.name : 'your pharmacy';
  const consentPharmacyRef = token ? pharmacy.name : 'my pharmacy';

  if (complete) return <EligibilityShell themeStyle={themeStyle} pharmacyThemed={pharmacyThemed}><EligibilityBrand identity={brandIdentity} token={token} /><section className="eligibility-card eligibility-message"><div className={`eligibility-result-icon ${eligible ? 'pass' : 'review'}`}><CheckCircle2 size={32} /></div><p className="section-label">{receipt ? `Case ${receipt.caseReference}` : `Submitted via ${pharmacy.name}`}</p><h1>Thank you — your application has gone to {pharmacy.name}</h1><p>A registered pharmacist will review it and contact you within 3 working days. This is not a diagnosis or guarantee of treatment.</p>{receipt?.warning && <div className="banner banner-amber">Your selected pharmacy became unavailable, so HHH will allocate your application manually.</div>}{!token && <a className="eligibility-home" href={PUBLIC_HOME_HREF}><Home size={16} aria-hidden="true" /> Return home</a>}</section></EligibilityShell>;

  return <EligibilityShell themeStyle={themeStyle} pharmacyThemed={pharmacyThemed}>
    <EligibilityBrand identity={brandIdentity} token={token} />
    <div className="eligibility-layout">
      <aside className="eligibility-intro">
        <p className="section-label">Private pre-screening · about 2 minutes</p>
        <h1>Could specialist care be right for you?</h1>
        <p className="eligibility-intro__lead">Answer a few confidential questions so {pharmacyRef} can review whether a referral may be appropriate.</p>
        <div className="eligibility-trust"><span><ShieldCheck size={17} /> {token ? `Your details go to ${pharmacy.name} only` : 'Your details go to the pharmacy you choose'}</span><span><LockKeyhole size={17} /> Health information handled securely</span></div>
        <div className="eligibility-next-steps">
          <p>What happens next</p>
          <ol>
            <li><span>1</span><div><strong>Complete this check</strong><small>Tell us about you and the support you need.</small></div></li>
            <li><span>2</span><div><strong>Pharmacy review</strong><small>A registered pharmacist or technician reviews your application and may call, email or text you within 3 working days.</small></div></li>
            <li><span>3</span><div><strong>Referral to the clinic</strong><small>If suitable, {pharmacyRef} refers you to its partner clinic. The clinic decides whether to see you.</small></div></li>
          </ol>
        </div>
        <p className="eligibility-intro__note"><HeartPulse size={16} /> This check is not a diagnosis and does not guarantee a consultation or prescription.</p>
        {token ? <PharmacyControllerDetails pharmacy={pharmacy} className="eligibility-controller-details--intro" /> : null}
      </aside>
      <form className="eligibility-card eligibility-form" onSubmit={submit}>
        <header className="eligibility-form-header"><span><ClipboardCheck size={17} /> Eligibility check</span><h2>Tell us a little about yourself</h2><p>Fields marked with an asterisk are required.</p></header>
        {!token && <section className="eligibility-form-section eligibility-location-section" aria-labelledby="eligibility-location">
          <div className="eligibility-section-heading"><span>01</span><div><h3 id="eligibility-location">Choose your pharmacy</h3><p>Choose the pharmacy you are applying to. Nothing is shared with any other pharmacy unless you agree.</p></div></div>
          <div className="eligibility-location-search">
            <label htmlFor="eligibility-postcode-search">UK postcode <em>*</em><input id="eligibility-postcode-search" className="input" name="postcode" value={searchPostcode} onChange={event => {
              const next = event.target.value;
              setSearchPostcode(next);
              const compact = next.toUpperCase().replace(/\s+/g, '');
              if (search && compact !== search.postcode.replace(/\s+/g, '')) resetLocationChoice();
              setError('');
            }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void runPostcodeSearch(); } }} autoComplete="postal-code" required /></label>
            <button className="btn btn-primary" type="button" onClick={() => void runPostcodeSearch()} disabled={searching || !searchPostcode.trim()}>{searching ? <><LoaderCircle className="spin" size={16} /> Searching…</> : <><Search size={16} /> Find pharmacies</>}</button>
          </div>
          <p className="eligibility-location-privacy"><LockKeyhole size={13} /> Your postcode stays out of the page URL, browser storage and analytics.</p>
          {error && <div className="banner banner-red" role="alert"><AlertTriangle size={16} /> {error}</div>}
          {search?.results.length ? <div className="eligibility-location-results" aria-live="polite">
            <div className="eligibility-location-copy"><strong>{search.results.length} nearest participating {search.results.length === 1 ? 'pharmacy' : 'pharmacies'}</strong><span>Results for {search.postcode}. Distances and map positions are approximate.</span></div>
            <div className="eligibility-location-map" role="group" aria-label={`Approximate pharmacy locations near ${search.postcode}`}>
              <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="M-5 76 C18 60 26 67 43 47 S72 30 105 13" /><path d="M9 -5 C20 20 13 34 34 49 S62 69 79 105" /><path d="M-5 29 C23 32 38 18 56 28 S78 56 105 58" /></svg>
              <span className="eligibility-location-origin" style={{ left: `${search.mapOrigin.xPercent}%`, top: `${search.mapOrigin.yPercent}%` }}><span aria-hidden="true" />Your postcode</span>
              {search.results.map((result, index) => <button
                key={result.id}
                className={selectedDirectoryProfileId === result.id ? 'is-selected' : ''}
                type="button"
                style={{ left: `${result.mapPosition.xPercent}%`, top: `${result.mapPosition.yPercent}%` }}
                aria-label={`${index + 1}. Select ${publicDirectoryPharmacyName(result)}, ${result.addressSummary}, ${result.approximateMiles.toFixed(1)} miles away`}
                aria-pressed={selectedDirectoryProfileId === result.id}
                onClick={() => choosePharmacy(result)}
              ><MapPin aria-hidden="true" /><span>{index + 1}</span></button>)}
            </div>
            <div className="eligibility-directory-results" role="group" aria-label="Choose a pharmacy">
              {search.results.map((result, index) => {
                const contact = directoryContactLine(result);
                const fulfilment = directoryFulfilmentLine(result);
                return (
                  <button type="button" aria-pressed={selectedDirectoryProfileId === result.id} className={selectedDirectoryProfileId === result.id ? 'is-selected' : ''} key={result.id} onClick={() => choosePharmacy(result)}>
                    <span className="eligibility-directory-number" aria-hidden="true">{index + 1}</span>
                    <span>
                      <strong>{publicDirectoryPharmacyName(result)}</strong>
                      <small>{result.addressSummary}</small>
                      {contact ? <small className="eligibility-directory-contact">{contact}</small> : null}
                      {fulfilment ? <small className="eligibility-directory-fulfilment">{fulfilment}</small> : null}
                      <small>{result.approximateMiles.toFixed(1)} miles away</small>
                    </span>
                    <span><strong>{selectedDirectoryProfileId === result.id ? 'Selected' : 'Choose'}</strong></span>
                  </button>
                );
              })}
            </div>
            {selectedDirectoryProfileId ? <><div className="banner banner-green" role="status"><CheckCircle2 size={17} /> You are applying to {pharmacy.name}. Nothing is shared with any other pharmacy unless you agree.</div>{(() => {
              const chosen = search.results.find(result => result.id === selectedDirectoryProfileId);
              return chosen ? <PharmacyControllerDetails pharmacy={{ ...chosen, address: chosen.addressSummary }} /> : null;
            })()}</> : <div className="eligibility-location-required" role="status"><MapPin size={17} /><span><strong>Select one pharmacy to continue</strong><small>You can use a pin or the list. The form cannot be submitted until you choose.</small></span></div>}
          </div> : search ? <div className="eligibility-location-manual" aria-live="polite">
            <div className="banner banner-amber"><AlertTriangle size={17} /><span>{search.status === 'provider_unavailable' ? 'The postcode service is temporarily unavailable.' : search.status === 'not_found' ? 'We could not find that postcode.' : 'No participating pharmacy is currently available nearby.'} You can still send the form to {HOLISTIC_HEALTH_HUB_ALLOCATION_LABEL}.</span></div>
            <div className={`eligibility-hhh-allocation${manualProceed ? ' is-selected' : ''}`}>
              <span className="eligibility-hhh-allocation__mark" aria-hidden="true"><img src={HHH_MARK} alt="" /></span>
              <span><strong>{HOLISTIC_HEALTH_HUB_ALLOCATION_LABEL}</strong><small>Your application stays with HHH until an appropriate pharmacy is confirmed.</small></span>
              {manualProceed ? <span className="eligibility-hhh-allocation__selected" role="status"><CheckCircle2 size={16} /> Selected</span> : <button className="btn btn-secondary" type="button" onClick={continueManual}>Choose {HOLISTIC_HEALTH_HUB_ALLOCATION_LABEL}</button>}
            </div>
          </div> : <div className="eligibility-location-required" role="status"><Search size={17} /><span><strong>Search before submitting</strong><small>Your remaining form fields are available below, but a pharmacy choice is required before submission.</small></span></div>}
        </section>}
        <section className="eligibility-form-section" aria-labelledby="eligibility-about-you">
          <div className="eligibility-section-heading"><span>{token ? '01' : '02'}</span><div><h3 id="eligibility-about-you">About you</h3><p>Your details let {pharmacyRef} contact you about your application.</p></div></div>
          <div className="eligibility-form-grid"><label>First name <em>*</em><input className="input" name="firstName" required autoComplete="given-name" /></label><label>Surname <em>*</em><input className="input" name="surname" required autoComplete="family-name" /></label><label>Date of birth <em>*</em><input className="input" name="dob" type="date" required max={maxDateOfBirth} onInvalid={event => event.currentTarget.setCustomValidity(event.currentTarget.validity.rangeOverflow ? 'You must be 18 or over to apply.' : '')} onInput={event => event.currentTarget.setCustomValidity('')} /></label>{token && <label>Postcode <em>*</em><input className="input" name="postcode" required autoComplete="postal-code" /></label>}<label>Email <em>*</em><input className="input" name="email" type="email" required autoComplete="email" /></label><label>Mobile number <em>*</em><input className="input" name="mobile" type="tel" required autoComplete="tel" /></label></div>
        </section>
        <section className="eligibility-form-section" aria-labelledby="eligibility-health-needs">
          <div className="eligibility-section-heading"><span>{token ? '02' : '03'}</span><div><h3 id="eligibility-health-needs">Your health needs</h3><p>Select up to three conditions, then choose the main one.</p></div></div>
          <fieldset className={`eligibility-condition-field ${conditionError ? 'has-error' : ''}`} aria-describedby={conditionError ? 'condition-error' : undefined}>
            <legend>Conditions you would like support with <em>*</em></legend>
            <details ref={conditionMenuRef} className="eligibility-condition-menu">
              <summary><span><strong>{selectedConditions.length ? `${selectedConditions.length} condition${selectedConditions.length === 1 ? '' : 's'} selected` : 'Choose conditions'}</strong><small>{selectedConditions.length ? selectedConditions.map(conditionLabel).join(', ') : 'Select up to three from the list'}</small></span><ChevronDown size={18} /></summary>
              <div className="eligibility-condition-options">
                <div className="eligibility-condition-options__head"><strong>Choose up to three</strong><span>{selectedConditions.length}/3 selected</span></div>
                <div className="eligibility-condition-options__list" role="group" aria-label="Conditions">
                  {CONDITIONS.map(condition => {
                    const checked = selectedConditions.includes(condition.id);
                    const disabled = !checked && selectedConditions.length >= 3;
                    return <label key={condition.id} className={disabled ? 'disabled' : ''}><input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggleCondition(condition.id)} /><span>{condition.label}</span></label>;
                  })}
                </div>
              </div>
            </details>
            {conditionError && <span className="eligibility-field-error" id="condition-error" role="alert">{conditionError}</span>}
          </fieldset>
          <label>Primary condition <em>*</em><select className="input select" value={primaryCondition} disabled={selectedConditions.length === 0} required onChange={event => { setPrimaryCondition(event.target.value); setConditionError(''); }}><option value="">Select the main condition</option>{selectedConditions.map(conditionId => <option key={conditionId} value={conditionId}>{conditionLabel(conditionId)}</option>)}</select></label>
          <fieldset><legend>Have you tried at least two licensed treatments or therapies? <em>*</em></legend><div className="eligibility-choice"><label><input type="radio" name="tried2" value="yes" required checked={treatmentHistory === 'yes'} onChange={() => setTreatmentHistory('yes')} /><span><strong>Yes</strong><small>I have tried two or more</small></span></label><label><input type="radio" name="tried2" value="no" checked={treatmentHistory === 'no'} onChange={() => setTreatmentHistory('no')} /><span><strong>No</strong><small>Not yet or I am unsure</small></span></label></div></fieldset>
          <fieldset><legend>Have you or an immediate family member been diagnosed with psychosis or schizophrenia? <em>*</em></legend><p className="eligibility-field-help">We record only your answer, not who the family member is.</p><div className="eligibility-choice"><label><input type="radio" name="psychExclusion" value="yes" required checked={psychHistory === 'yes'} onChange={() => setPsychHistory('yes')} /><span><strong>Yes</strong><small>This applies to me or family</small></span></label><label><input type="radio" name="psychExclusion" value="no" checked={psychHistory === 'no'} onChange={() => setPsychHistory('no')} /><span><strong>No</strong><small>This does not apply</small></span></label></div></fieldset>
        </section>
        <section className="eligibility-form-section eligibility-form-section--consent" aria-labelledby="eligibility-consent">
          <div className="eligibility-section-heading"><span>{token ? '03' : '04'}</span><div><h3 id="eligibility-consent">Consent and referral</h3><p>Please read the <LegalLink href={TERMS_HREF}>Terms of Use</LegalLink> and <LegalLink href={PRIVACY_HREF}>Privacy Notice</LegalLink>, then confirm:</p></div></div>
          <label>Where did you hear about this service? <em>*</em><select className="input select" name="source" defaultValue="" required><option value="" disabled>Please select an option</option><option>Poster</option><option>Text</option><option>Leaflet</option><option>Website</option><option>Google</option><option>TV ad</option></select></label>
          <div className="eligibility-consents"><label><input type="checkbox" name="consentReferral" required /><span>I am 18 or over, this application is about me and is accurate, and I accept the <LegalLink href={TERMS_HREF}>Terms of Use</LegalLink>. <em>*</em></span></label><label><input type="checkbox" name="consentShare" required /><span>I consent to {consentPharmacyRef} and Holistic Health Hub using my health information — including my GP record and automatic screening of my answers — to assess me for referral, as set out in the <LegalLink href={PRIVACY_HREF}>Privacy Notice</LegalLink>. <em>*</em></span></label><label className="eligibility-consent--optional"><input type="checkbox" name="marketing" /><span>Email and text me news about this service from {pharmacyRef} and Holistic Health Hub. Unsubscribe any time. <small>Optional</small></span></label></div>
          <p className="eligibility-consent-withdraw">You can withdraw at any time before referral by contacting {pharmacyRef}.</p>
        </section>
        {error && <div className="banner banner-red"><AlertTriangle size={16} /> {error}</div>}
        <footer className="eligibility-form-footer"><button className="btn btn-primary eligibility-submit" type="submit" disabled={submitting || (!token && !selectedDirectoryProfileId && !manualProceed)}>{submitting ? 'Submitting securely…' : !token && !selectedDirectoryProfileId && !manualProceed ? 'Select a pharmacy before submitting' : 'Submit eligibility check'}</button><p>{!token && !selectedDirectoryProfileId && !manualProceed ? <><MapPin size={13} /> Search and select a pharmacy in section 01.</> : <><LockKeyhole size={13} /> Your answers go securely to {pharmacyRef}. Holistic Health Hub’s registered pharmacists and technicians help the pharmacy review them.</>}</p></footer>
        <p className="eligibility-legal">{isLocalPreview ? 'Local preview only — this form does not transmit or store the information entered.' : <>This service is provided by {token ? pharmacy.name : 'the partner pharmacy you select'}. Website operated by Holistic Health Hub, a trading name of Fit-Pharma Ltd (company no. 11950925), 124 City Road, London EC1V 2NX · ICO ZB639206 · <LegalLink href={TERMS_HREF}>Terms of Use</LegalLink> · <LegalLink href={PRIVACY_HREF}>Privacy Notice</LegalLink> · Protected by reCAPTCHA; the Google <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a> and <a href="https://policies.google.com/terms" target="_blank" rel="noopener noreferrer">Terms of Service</a> apply.</>}</p>
      </form>
    </div>
  </EligibilityShell>;
}
