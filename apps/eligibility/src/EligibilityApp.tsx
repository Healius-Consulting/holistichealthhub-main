import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ClipboardCheck, HeartPulse, Home, LoaderCircle, LockKeyhole, MapPin, Search, ShieldCheck } from 'lucide-react';
import { CONDITIONS, conditionLabel } from '@hhh/domain';
import { createEligibilitySubmission, createV2Intake, resolvePublicReferralToken, searchPublicPharmacies } from '../../../src/shared/api';
import { HOLISTIC_HEALTH_HUB_ALLOCATION_LABEL, publicDirectoryPharmacyName, type EligibilitySubmissionInput, type PostcodeSearchReceipt, type PublicDirectoryResult, type PublicPharmacy, type V2IntakeReceipt } from '../../../src/shared/contracts';
import { tenantThemeVariables } from '../../../src/utils/tenantTheme';
import { EMAIL_LOGO_SPEC } from '../../../src/utils/pharmacyLogo';
import { parseEligibilityReferralRoute } from './referralRoute';

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
      {pharmacyLogo
        ? <div className="eligibility-brand__identity" aria-hidden="true" />
        : token
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
        {!token && <a className="eligibility-home" href={PUBLIC_HOME_HREF}><Home size={15} aria-hidden="true" /> Return home</a>}
        <span className="eligibility-brand__secure"><LockKeyhole size={14} /> Private and secure</span>
      </div>
    </div>
  </header>;
}

function directoryContactLine(result: PublicDirectoryResult) {
  return [result.website, result.publicPhone].filter(value => value?.trim()).join(' · ');
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
    if (treatmentHistory === 'no' || psychHistory === 'yes') return;
    if (selectedConditions.length < 1 || selectedConditions.length > 3) {
      setConditionError('Select between one and three conditions.');
      return;
    }
    if (!primaryCondition || !selectedConditions.includes(primaryCondition)) {
      setConditionError('Choose one of your selected conditions as the primary condition.');
      return;
    }
    setSubmitting(true); setError('');
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
        if (intakeVersion === 'v1') await createEligibilitySubmission(input);
        else setReceipt(await createV2Intake({
          ...(token
            ? { type: 'future_pharmacy_qr' as const, referralToken: token }
            : { type: 'general_hhh_website' as const, searchId: search!.searchId, selectedDirectoryProfileId }),
          firstName: input.firstName, surname: input.surname, dob: input.dob, mobile: input.mobile, email: input.email,
          postcode: input.postcode, conditions: input.conditions, primaryCondition: input.primaryCondition,
          tried2: input.tried2, psychExclusion: input.psychExclusion, consentReferral: true, consentShare: true,
          marketing: input.marketing, heardAbout: input.source,
          consentVersion: token ? 'pharmacy-qr-v2.1' : 'general-public-v2.1', idempotencyKey: idempotencyKey.current,
        }));
      }
      setEligible(input.tried2 && !input.psychExclusion);
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
  if (error && !pharmacy) return <EligibilityShell themeStyle={themeStyle} pharmacyThemed={pharmacyThemed}><EligibilityBrand identity={HHH_PUBLIC_IDENTITY} token={token} /><section className="eligibility-card eligibility-message"><AlertTriangle size={36} /><h1>Unable to open this form</h1><p>{error}</p><p>Please ask your pharmacy for its current eligibility link.</p>{!token && <a className="btn btn-primary eligibility-home" href={PUBLIC_HOME_HREF}><Home size={16} aria-hidden="true" /> Return home</a>}</section></EligibilityShell>;
  if (!pharmacy) return null;

  const brandIdentity = token ? pharmacy : HHH_PUBLIC_IDENTITY;

  if (complete) return <EligibilityShell themeStyle={themeStyle} pharmacyThemed={pharmacyThemed}><EligibilityBrand identity={brandIdentity} token={token} /><section className="eligibility-card eligibility-message"><div className={`eligibility-result-icon ${eligible ? 'pass' : 'review'}`}><CheckCircle2 size={32} /></div><p className="section-label">{receipt ? `Case ${receipt.caseReference}` : `Submitted via ${pharmacy.name}`}</p><h1>{intakeVersion === 'v1' ? eligible ? 'Thank you — your pharmacy will be in touch' : 'Thank you — your answers need a clinical review' : 'Thank you — HHH will be in touch'}</h1><p>{receipt ? token ? `HHH received your application for ${pharmacy.tradingName}. HHH will review it and contact you before referring it to that pharmacy; the dedicated destination will not change.` : `${receipt.provisionalPharmacyName ? `${receipt.provisionalPharmacyName} has been recorded as your preference. ` : ''}Your application remains with HHH while the team reviews it and contacts you. Nothing is sent to a pharmacy until HHH completes the referral.` : `Your enquiry has been securely linked to ${pharmacy.name}.`} This is not a diagnosis or guarantee of treatment.</p>{receipt?.warning && <div className="banner banner-amber">Your selected pharmacy became unavailable, so HHH will allocate your application manually.</div>}{!token && <a className="btn btn-primary eligibility-home" href={PUBLIC_HOME_HREF}><Home size={16} aria-hidden="true" /> Return home</a>}</section></EligibilityShell>;

  return <EligibilityShell themeStyle={themeStyle} pharmacyThemed={pharmacyThemed}>
    <EligibilityBrand identity={brandIdentity} token={token} />
    <div className="eligibility-layout">
      <aside className="eligibility-intro">
        <p className="section-label">Private pre-screening · about 2 minutes</p>
        <h1>Could specialist care be right for you?</h1>
        <p className="eligibility-intro__lead">Answer a few confidential questions so HHH can review whether a referral may be appropriate.</p>
        <div className="eligibility-trust"><span><ShieldCheck size={17} /> {token ? 'Dedicated pharmacy destination protected' : 'Reviewed by HHH before referral'}</span><span><LockKeyhole size={17} /> Health information handled securely</span></div>
        <div className="eligibility-next-steps">
          <p>What happens next</p>
          <ol>
            <li><span>1</span><div><strong>Complete this check</strong><small>Tell us about you and the support you need.</small></div></li>
            <li><span>2</span><div><strong>HHH review and call</strong><small>Your application stays with HHH while the team completes its checks.</small></div></li>
            <li><span>3</span><div><strong>Referral to pharmacy</strong><small>After HHH completes the referral, the confirmed pharmacy can support your next steps.</small></div></li>
          </ol>
        </div>
        <p className="eligibility-intro__note"><HeartPulse size={16} /> This check is not a diagnosis and does not guarantee a consultation or prescription.</p>
      </aside>
      <form className="eligibility-card eligibility-form" onSubmit={submit}>
        <header className="eligibility-form-header"><span><ClipboardCheck size={17} /> Eligibility check</span><h2>Tell us a little about yourself</h2><p>Fields marked with an asterisk are required.</p></header>
        {!token && <section className="eligibility-form-section eligibility-location-section" aria-labelledby="eligibility-location">
          <div className="eligibility-section-heading"><span>01</span><div><h3 id="eligibility-location">Choose your preferred pharmacy</h3><p>Search by postcode, then select a pin or a pharmacy from the list. HHH will confirm the final referral with you.</p></div></div>
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
                return (
                  <button type="button" aria-pressed={selectedDirectoryProfileId === result.id} className={selectedDirectoryProfileId === result.id ? 'is-selected' : ''} key={result.id} onClick={() => choosePharmacy(result)}>
                    <span className="eligibility-directory-number" aria-hidden="true">{index + 1}</span>
                    <span>
                      <strong>{publicDirectoryPharmacyName(result)}</strong>
                      <small>{result.addressSummary}</small>
                      {contact ? <small className="eligibility-directory-contact">{contact}</small> : null}
                      <small>{result.approximateMiles.toFixed(1)} miles away</small>
                    </span>
                    <span><strong>{selectedDirectoryProfileId === result.id ? 'Selected' : 'Choose'}</strong></span>
                  </button>
                );
              })}
            </div>
            {selectedDirectoryProfileId ? <div className="banner banner-green" role="status"><CheckCircle2 size={17} /> {pharmacy.tradingName} recorded as your preference. Your application stays with HHH until the referral is completed.</div> : <div className="eligibility-location-required" role="status"><MapPin size={17} /><span><strong>Select one pharmacy to continue</strong><small>You can use a pin or the list. The form cannot be submitted until you choose.</small></span></div>}
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
          <div className="eligibility-section-heading"><span>{token ? '01' : '02'}</span><div><h3 id="eligibility-about-you">About you</h3><p>Your details help the HHH team contact the right person and complete your referral review.</p></div></div>
          <div className="eligibility-form-grid"><label>First name <em>*</em><input className="input" name="firstName" required autoComplete="given-name" /></label><label>Surname <em>*</em><input className="input" name="surname" required autoComplete="family-name" /></label><label>Date of birth <em>*</em><input className="input" name="dob" type="date" required /></label>{token && <label>Postcode <em>*</em><input className="input" name="postcode" required autoComplete="postal-code" /></label>}<label>Email <em>*</em><input className="input" name="email" type="email" required autoComplete="email" /></label><label>Mobile number <em>*</em><input className="input" name="mobile" type="tel" required autoComplete="tel" /></label></div>
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
          <fieldset><legend>Have you tried at least two licensed treatments or therapies? <em>*</em></legend><div className="eligibility-choice"><label><input type="radio" name="tried2" value="yes" required checked={treatmentHistory === 'yes'} onChange={() => setTreatmentHistory('yes')} /><span><strong>Yes</strong><small>I have tried two or more</small></span></label><label><input type="radio" name="tried2" value="no" checked={treatmentHistory === 'no'} onChange={() => setTreatmentHistory('no')} /><span><strong>No</strong><small>Not yet or I am unsure</small></span></label></div>{treatmentHistory === 'no' && <div className="eligibility-screening-stop" role="alert"><AlertTriangle size={18} /><div><strong>You are not eligible to submit this check yet</strong><p>At least two licensed treatments or therapies must have been tried before a referral can be considered. If you are unsure what counts, please contact the pharmacy.</p></div></div>}</fieldset>
          <fieldset><legend>Have you or an immediate family member been diagnosed with psychosis or schizophrenia? <em>*</em></legend><div className="eligibility-choice"><label><input type="radio" name="psychExclusion" value="yes" required checked={psychHistory === 'yes'} onChange={() => setPsychHistory('yes')} /><span><strong>Yes</strong><small>This applies to me or family</small></span></label><label><input type="radio" name="psychExclusion" value="no" checked={psychHistory === 'no'} onChange={() => setPsychHistory('no')} /><span><strong>No</strong><small>This does not apply</small></span></label></div>{psychHistory === 'yes' && <div className="eligibility-screening-stop" role="alert"><AlertTriangle size={18} /><div><strong>You are not eligible to submit this check</strong><p>A diagnosis of psychosis or schizophrenia in you or an immediate family member means a referral cannot be considered through this form. Please speak to the pharmacy or your GP about other options.</p></div></div>}</fieldset>
        </section>
        <section className="eligibility-form-section eligibility-form-section--consent" aria-labelledby="eligibility-consent">
          <div className="eligibility-section-heading"><span>{token ? '03' : '04'}</span><div><h3 id="eligibility-consent">Consent and referral</h3><p>Review how your information will be used.</p></div></div>
          <label>Where did you hear about this service?<select className="input select" name="source"><option>Poster</option><option>Text</option><option>Leaflet</option><option>Website</option><option>Google</option><option>TV ad</option></select></label>
          <div className="eligibility-consents"><label><input type="checkbox" name="consentReferral" required /><span>{intakeVersion === 'v1' ? 'I understand the consultation and medicine may involve costs, and I want the pharmacy to consider me for referral.' : 'I understand the consultation and medicine may involve costs, and I want this application considered for referral.'} <em>*</em></span></label><label><input type="checkbox" name="consentShare" required /><span>{intakeVersion === 'v1' ? `I explicitly consent to my health information being collected and shared with ${pharmacy.tradingName} and relevant specialist healthcare services for this enquiry.` : token ? `I explicitly consent to HHH reviewing this information and, only after HHH completes its referral review, sharing it with ${pharmacy.tradingName}. This dedicated pharmacy destination will not be changed.` : `I explicitly consent to HHH reviewing this information. ${selectedDirectoryProfileId ? pharmacy.tradingName : 'The pharmacy I select'} is a preference only, and HHH will share my application with a pharmacy only after completing its referral review and confirming the destination with me.`} <em>*</em></span></label><label className="eligibility-consent--optional"><input type="checkbox" name="marketing" /><span>I would like to receive optional service news and offers. I can withdraw this consent at any time. <small>Optional</small></span></label></div>
        </section>
        {error && <div className="banner banner-red"><AlertTriangle size={16} /> {error}</div>}
        <footer className="eligibility-form-footer"><button className="btn btn-primary eligibility-submit" type="submit" disabled={submitting || treatmentHistory === 'no' || psychHistory === 'yes' || (!token && !selectedDirectoryProfileId && !manualProceed)}>{submitting ? 'Submitting securely…' : treatmentHistory === 'no' || psychHistory === 'yes' ? 'Not eligible to submit' : !token && !selectedDirectoryProfileId && !manualProceed ? 'Select a pharmacy before submitting' : 'Submit eligibility check'}</button><p>{treatmentHistory === 'no' ? <><AlertTriangle size={13} /> Submission is unavailable based on your treatment history.</> : psychHistory === 'yes' ? <><AlertTriangle size={13} /> Submission is unavailable based on your answer about psychosis or schizophrenia.</> : !token && !selectedDirectoryProfileId && !manualProceed ? <><MapPin size={13} /> Search and select a pharmacy in section 01.</> : <><LockKeyhole size={13} /> {intakeVersion === 'v1' ? `Your answers are sent securely to ${pharmacy.tradingName}.` : 'Your answers are sent securely to HHH first. A pharmacy receives them only after HHH completes the referral.'}</>}</p></footer>
        <p className="eligibility-legal">{isLocalPreview ? 'Local preview only — this form does not transmit or store the information entered.' : 'HHH is a platform of Healius Consulting. The approved live privacy notice must identify the verified legal entity and explain the pharmacy and platform operator’s data-protection roles before patient information is accepted.'}</p>
      </form>
    </div>
  </EligibilityShell>;
}
