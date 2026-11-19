import { ArrowRight, FileText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import HhhBrandMark from '../components/HhhBrandMark';
import { PdfPreview as OnboardingPdfPreview } from '../components/PdfPreview';
import { NeedMark } from '../components/OnboardingFormParts';
import { CuraleafAccountForm } from './CuraleafAccountForm';
import { OnboardingQuickStart } from './OnboardingQuickStart';
import { PartnerTermsForm } from './PartnerTermsForm';
import { WorldpayApplicationForm } from '../worldpay/WorldpayApplicationForm';
import type { CompanyLookup } from '../shared/api';
import {
  afterCuraleafSent,
  afterTermsAccepted,
  initialSetupState,
  requestStateView,
  setUpNowTarget,
  setupFinished,
  worldpayUnlocked,
} from './onboarding-flow';
import {
  PHARMACY_ONBOARDING_CHOICES,
  PARTNERSHIP_LOGOS,
  PHARMACY_ONBOARDING_PITCH,
  PHARMSMART_LOGIN_URL,
  PHARMSMART_ONBOARDING_PACKETS,
  pharmsmartOnboardingBookingUrl,
  type PharmacyOnboardingChoice,
} from './pharmsmart-login';
import { getPartnerTermsRequirement, loadWorldpayApplication, partnerTermsSignupFileUrl, recordPharmacyOnboardingDeferral } from '../shared/api';
import type { PharmsmartWelcome as PharmsmartWelcomeDetails } from './types';
import { OnboardingHoldPage } from '../onboarding/OnboardingHold';
import { OnboardingAwaitingPage } from '../onboarding/OnboardingAwaiting';

const BROCHURE = PHARMSMART_ONBOARDING_PACKETS.find(packet => packet.title === 'Brochure')!;



/** The partner brochure, opened in the preview on this page. */
function BrochureCard({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="onb__brochure-card" onClick={onOpen}>
      <span className="onb__brochure-icon" aria-hidden="true"><FileText size={20} /></span>
      <span className="onb__brochure-text">
        <strong>Read the partner brochure</strong>
        <span>Everything on this page in more detail, as a PDF you can download.</span>
      </span>
      <ArrowRight size={18} aria-hidden="true" className="onb__brochure-arrow" />
    </button>
  );
}

/** A person PharmSmart named, when it sent at least a name. */
function personFromPrefill(first?: string | null, last?: string | null, email?: string | null) {
  const name = [first, last].filter(Boolean).join(' ').trim();
  return name ? { name, email: email?.trim() ?? '' } : null;
}

export function PharmsmartWelcome({
  welcome,
  onUseEmail,
  accountHref,
}: {
  welcome: PharmsmartWelcomeDetails;
  onUseEmail?: () => void;
  /** Public embed: open staff sign-in outside the frame. */
  accountHref?: string;
}) {
  const hostname = typeof window === 'undefined' ? '' : window.location.hostname;
  const bookingUrl = pharmsmartOnboardingBookingUrl(welcome);
  const embeddedBookingUrl = pharmsmartOnboardingBookingUrl(welcome, { embed: true, hostname });
  const knownName = [welcome.firstName, welcome.lastName].filter(Boolean).join(' ');
  const [viewing, setViewing] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  // "Before you start" comes first: it explains the three forms and looks the company up once for all of them.
  const [quickStartOpen, setQuickStartOpen] = useState(false);
  const [company, setCompany] = useState<CompanyLookup | null>(null);
  // Curaleaf form, then Partner Terms, then Worldpay (skippable). A pharmacy that left
  // before the Terms comes back straight to them.
  const [setup, setSetup] = useState(() => initialSetupState(welcome));
  const [termsVersion, setTermsVersion] = useState<string | null>(null);
  // The public page has no PharmSmart welcome to say whether the Terms are on, so it asks.
  useEffect(() => {
    let active = true;
    void getPartnerTermsRequirement()
      .then(result => {
        if (!active) return;
        setTermsVersion(result.version);
        if (welcome.termsRequired === undefined) setSetup(current => (current.termsRequest ? current : { ...current, termsRequired: result.required }));
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [welcome.termsRequired]);
  const [termsOpen, setTermsOpen] = useState(() => setup.termsRequest !== null);
  const [worldpayOpen, setWorldpayOpen] = useState(false);
  // Set up is open from the start; Book a demo and Not yet are a click away.
  const [choice, setChoice] = useState<PharmacyOnboardingChoice | null>('setup');
  /** Only scroll to the panel after the visitor has done something, never on arrival. */
  const interacted = useRef(false);
  const submitted = setup.termsRequest !== null;
  const termsAccepted = setup.termsAccepted;
  const worldpayReady = worldpayUnlocked(setup);
  const finished = setupFinished(setup);
  const [deferral, setDeferral] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const deferralKey = useRef(crypto.randomUUID());

  const panelRef = useRef<HTMLDivElement>(null);
  const setupHeadingRef = useRef<HTMLHeadingElement>(null);
  // FB-04: the demo calendar starts loading once the visitor points at or focuses "Book a demo",
  // never on arrival (Calendly sets cookies), and stays loaded after that.
  const [calendarWanted, setCalendarWanted] = useState(false);
  const [calendarLoaded, setCalendarLoaded] = useState(false);
  // FB-19: a Worldpay application already started for this request (after a reload, say).
  const [worldpayDraft, setWorldpayDraft] = useState(false);

  /** FB-03: brings the set-up card into view and moves focus to its heading. */
  const showSetupCard = () => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    requestAnimationFrame(() => {
      panelRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
      setupHeadingRef.current?.focus({ preventScroll: true });
    });
  };

  const choose = (next: PharmacyOnboardingChoice) => {
    interacted.current = true;
    setChoice(next);
    if (next === 'demo') setCalendarWanted(true);
    if (next === 'later') void recordNotYet();
    if (next !== 'setup') return;
    // FB-03: every click on "Set up now" opens the first step not done, or shows the card.
    const target = setUpNowTarget(setup);
    if (target === 'curaleaf') setQuickStartOpen(true);
    else if (target === 'terms') setTermsOpen(true);
    else if (target === 'worldpay' && worldpayReady) setWorldpayOpen(true);
    else showSetupCard();
  };

  // FB-04: open the connection to Calendly early. A preconnect sends no cookies and loads nothing.
  useEffect(() => {
    const href = 'https://calendly.com';
    if (document.head.querySelector(`link[rel="preconnect"][href="${href}"]`)) return;
    const link = Object.assign(document.createElement('link'), { rel: 'preconnect', href });
    document.head.appendChild(link);
  }, []);

  // FB-19: after a reload, show "Continue application" for a started draft, or "Sent" for a sent one.
  const requestId = setup.termsRequest?.id ?? null;
  useEffect(() => {
    if (!requestId) return;
    let active = true;
    // Only on arrival and when the form closes; the form loads the application itself when it opens.
    if (worldpayOpen) return;
    void loadWorldpayApplication<{ existingAccount?: string }>({ kind: 'request', onboardingRequestId: requestId })
      .then(view => {
        if (!active) return;
        if (view.status && view.status !== 'DRAFT') setSetup(current => ({ ...current, worldpay: 'sent' }));
        else setWorldpayDraft(Boolean(view.id) && view.answers?.existingAccount !== 'online');
      })
      // After activation the public route sends the pharmacy to the portal; nothing to show here.
      .catch(() => undefined);
    return () => { active = false; };
  }, [requestId, worldpayOpen]);

  // The chosen panel sits below the hero; bring it into view, mostly for phones.
  useEffect(() => {
    if (formOpen || quickStartOpen || termsOpen || worldpayOpen) { interacted.current = true; return; }
    if (!choice || !interacted.current) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    panelRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
  }, [choice, formOpen, quickStartOpen, termsOpen, worldpayOpen]);


  // Only a PharmSmart visit says who chose "Not yet"; an anonymous visit records nothing.
  const recordNotYet = async () => {
    const gphcNumber = welcome.gphcNumber?.trim();
    if (!gphcNumber || deferral === 'saving' || deferral === 'saved') return;
    setDeferral('saving');
    try {
      await recordPharmacyOnboardingDeferral({
        gphcNumber,
        pharmsmartPharmacyId: welcome.pharmsmartPharmacyId ?? '',
        personName: knownName,
        personEmail: welcome.email ?? '',
        idempotencyKey: deferralKey.current,
      });
      setDeferral('saved');
    } catch {
      setDeferral('failed');
    }
  };
  const closePreview = useRef<HTMLButtonElement>(null);
  const openPacket = PHARMSMART_ONBOARDING_PACKETS.find(packet => packet.href === viewing) ?? null;

  useEffect(() => {
    if (!openPacket) return;
    closePreview.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setViewing(null);
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [openPacket]);

  const fromPharmsmart = Boolean(welcome.gphcNumber?.trim());
  const signIn = accountHref
    ? <a className="onb__signin" href={accountHref} target="_blank" rel="noopener noreferrer">Sign in</a>
    : <button className="onb__signin" type="button" onClick={onUseEmail}>Sign in</button>;

  const requestState = requestStateView(welcome.onboardingRequest);
  // On hold: only the message for the reason. No forms, demo, sign-in link or way into the account.
  if (requestState === 'on_hold' || welcome.hold) {
    return <OnboardingHoldPage hold={welcome.hold} person={knownName ? { name: knownName, gphcNumber: welcome.gphcNumber } : null} />;
  }
  if (requestState === 'pending') {
    return (
      <OnboardingAwaitingPage
        message={welcome.awaiting}
        branchName={welcome.prefill?.pharmacyName || 'your pharmacy'}
        person={knownName ? { name: knownName, gphcNumber: welcome.gphcNumber } : null}
        account={<>Already on Holistic Health Hub? {signIn}</>}
        bookingUrl={bookingUrl}
      />
    );
  }
  return (
    <div className="staff-login-page auth-page staff-login-page--guide">
      <div className="onb">
        <header className="onb__top">
          <div className="staff-login-lockup" aria-label="Holistic Health Hub">
            <HhhBrandMark />
            <span>
              <strong>Holistic Health Hub</strong>
              <small>Pharmacy onboarding</small>
            </span>
          </div>
          <div className="onb__account onb__account--routes">
            <h2 className="onb__account-title">Already have an account?</h2>
            <p>Pharmsmart user? Open from your <a className="onb__signin" href={PHARMSMART_LOGIN_URL} target="_blank" rel="noopener noreferrer">Pharmsmart dashboard</a></p>
            <p>Not on Pharmsmart? {signIn}</p>
          </div>
        </header>

        <section className="onb__hero" aria-labelledby="onb-title">
          <div className="onb__pitch">
            <p className="onb__eyebrow">{PHARMACY_ONBOARDING_PITCH.eyebrow}</p>
            <h1 id="onb-title">{PHARMACY_ONBOARDING_PITCH.title}</h1>
            <p className="onb__lede">{PHARMACY_ONBOARDING_PITCH.lede}</p>
            <p className="onb__partners">
              <span>In partnership with</span>
              <span className="onb__partner-logos">
                {PARTNERSHIP_LOGOS.map(logo => <img key={logo.alt} src={logo.src} alt={logo.alt} width={logo.width} height={logo.height} />)}
              </span>
            </p>
            <ul className="onb__facts">
              {PHARMACY_ONBOARDING_PITCH.facts.map(fact => <li key={fact}>{fact}</li>)}
            </ul>
            {knownName ? <p className="onb__person">Signed in from PharmSmart as <strong>{knownName}</strong>{welcome.gphcNumber ? <> · GPhC {welcome.gphcNumber}</> : null}</p> : null}
            <div className="onb__choices" role="group" aria-label="How would you like to start?">
              {PHARMACY_ONBOARDING_CHOICES.map(option => (
                <button
                  key={option.id}
                  type="button"
                  className={`onb__choice onb__choice--${option.id}`}
                  aria-pressed={choice === option.id}
                  aria-controls="onb-panel"
                  onClick={() => choose(option.id)}
                  onPointerEnter={option.id === 'demo' ? () => setCalendarWanted(true) : undefined}
                  onFocus={option.id === 'demo' ? () => setCalendarWanted(true) : undefined}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <BrochureCard onOpen={() => setViewing(BROCHURE.href)} />
          </div>

          <aside className="onb__how" aria-labelledby="onb-how">
            <h2 id="onb-how">How it works for patients</h2>
            <ol>
              {PHARMACY_ONBOARDING_PITCH.steps.map(step => (
                <li key={step.title}>
                  <strong>{step.title}</strong>
                  <span>{step.body}</span>
                </li>
              ))}
            </ol>
          </aside>

        <div id="onb-panel" ref={panelRef} className="onb__panel-slot" aria-live="polite">
          {choice === 'setup' ? (
            <section className="onb__panel" aria-labelledby="onb-setup">
              <div className="onb__panel-head">
                <h2 id="onb-setup" ref={setupHeadingRef} tabIndex={-1}>{finished ? 'You are all set' : setup.termsRequired ? 'Three steps to set up' : 'Two steps to set up'}</h2>
                <span className="onb__progress">{Number(submitted) + (setup.termsRequired ? Number(termsAccepted) : 0) + Number(setup.worldpay === 'sent')} of {setup.termsRequired ? 3 : 2} done</span>
              </div>
              <p>
                {finished
                  ? `Your application is with our team and Curaleaf Laboratories. We will email the pharmacy address when your account is ready.${setup.worldpay === 'skipped' ? ' You can send the Worldpay form later.' : ''}`
                  : 'Each step leads into the next and takes a few minutes. The Worldpay form can wait until later.'}
              </p>
              <ol className="onb__forms">
                <li className={submitted ? 'is-done' : undefined}>
                  <div>
                    <h3>Curaleaf account<NeedMark /></h3>
                    <p>Opens your account with Curaleaf Laboratories, so you can order stock. You will need your GPhC premises number, company name, invoice and delivery addresses, and an accounts contact.</p>
                  </div>
                  {submitted
                    ? <p className="onb__done">Sent</p>
                    : <button type="button" className="onb__button onb__button--primary" onClick={() => setQuickStartOpen(true)}>Fill in</button>}
                </li>
                {setup.termsRequired ? (
                  <li className={termsAccepted ? 'is-done' : undefined}>
                    <div>
                      <h3>Partner Terms<NeedMark /></h3>
                      <p>Read our terms, confirm you can accept them for the pharmacy and sign with your name. This sends your Curaleaf form to Curaleaf Laboratories.</p>
                    </div>
                    {termsAccepted
                      ? <p className="onb__done">Accepted</p>
                      : <button type="button" className="onb__button onb__button--primary" onClick={() => setTermsOpen(true)} disabled={!submitted}>Read and accept</button>}
                  </li>
                ) : null}
                <li className={setup.worldpay === 'sent' ? 'is-done' : undefined}>
                  <div>
                    <h3>Worldpay card payments<NeedMark optional /></h3>
                    <p>Lets patients pay by card through a secure link. You will need the bank account for payouts and each owner's date of birth and home address. You can skip this and do it later.</p>
                  </div>
                  {setup.worldpay === 'sent'
                    ? <p className="onb__done">Sent</p>
                    : setup.worldpay === 'skipped'
                      ? <p className="onb__done">Skipped</p>
                      : (
                        <span className="onb__actions">
                          <button type="button" className="onb__button onb__button--primary" onClick={() => setWorldpayOpen(true)} disabled={!worldpayReady}>{worldpayDraft ? 'Continue application' : 'Fill in'}</button>
                          {worldpayReady
                            ? <button type="button" className="onb__button onb__button--quiet" onClick={() => setSetup(current => ({ ...current, worldpay: 'skipped' }))}>Skip for now</button>
                            : null}
                        </span>
                      )}
                </li>
              </ol>
            </section>
          ) : null}

          {choice === 'demo' || calendarWanted ? (
            <section className="onb__panel" aria-labelledby="onb-demo" hidden={choice !== 'demo'}>
              <div className="onb__panel-head">
                <h2 id="onb-demo">Book a 30-minute demo</h2>
                <a href={bookingUrl} target="_blank" rel="noopener noreferrer">Open in a new tab</a>
              </div>
              <p>Pick a time with Shaylen Patel. You can set up afterwards from this page.</p>
              <div className="onb__calendar-wrap" aria-busy={!calendarLoaded}>
                {calendarLoaded ? null : <p className="onb__calendar-loading" role="status">Loading calendar…</p>}
                <iframe className="onb__calendar" title="30-minute demo call with Shaylen Patel" src={embeddedBookingUrl} onLoad={() => setCalendarLoaded(true)} />
              </div>
            </section>
          ) : null}

          {choice === 'later' ? (
            <section className="onb__panel" aria-labelledby="onb-later">
              <h2 id="onb-later">No problem</h2>
              <p>Nothing has been set up for this pharmacy. Come back to this page whenever you are ready, or read the brochure in the meantime.</p>
              <BrochureCard onOpen={() => setViewing(BROCHURE.href)} />
              {deferral === 'failed'
                ? <p className="onb__error">We could not save your answer. <button type="button" onClick={() => void recordNotYet()}>Try again</button></p>
                : null}
            </section>
          ) : null}
        </div>
        </section>

        {fromPharmsmart ? (
          <footer className="onb__foot">
            <p>Seeing this page by mistake? Email <strong className="onb__address">spatel@healiusconsulting.com</strong> and we will look into it.</p>
          </footer>
        ) : null}
          {openPacket ? createPortal(
            <div className="onboarding-dialog" role="presentation">
              <button className="onboarding-dialog__backdrop" type="button" aria-label="Close preview" onClick={() => setViewing(null)} />
              <div className="onboarding-dialog__panel" role="dialog" aria-modal="true" aria-labelledby="onboarding-preview-title">
                <header>
                  <h2 id="onboarding-preview-title">{openPacket.title}</h2>
                  <a href={openPacket.href} download>Download</a>
                  <button ref={closePreview} type="button" onClick={() => setViewing(null)}>Close</button>
                </header>
                <OnboardingPdfPreview href={openPacket.href} />
              </div>
            </div>,
            document.body,
          ) : null}
          <OnboardingQuickStart
            open={quickStartOpen}
            termsRequired={setup.termsRequired}
            pharmacyName={welcome.prefill?.pharmacyName ?? ''}
            company={company}
            onClose={() => setQuickStartOpen(false)}
            onStart={found => {
              setCompany(found);
              setQuickStartOpen(false);
              setFormOpen(true);
            }}
          />
          <CuraleafAccountForm
            open={formOpen}
            company={company}
            welcome={welcome}
            onClose={() => setFormOpen(false)}
            onSubmitted={(values, requestId, found) => {
              setFormOpen(false);
              if (found) setCompany(found);
              setSetup(current => afterCuraleafSent(current, {
                id: requestId,
                pharmacyName: values.pharmacyName,
                registeredCompanyName: values.registeredCompanyName,
              }));
              // Straight on to the next step, with no stop on this page in between:
              // the Terms when they are asked for, otherwise Worldpay (the application has gone).
              if (setup.termsRequired) setTermsOpen(true);
              else setWorldpayOpen(true);
            }}
          />
          <PartnerTermsForm
            open={termsOpen}
            request={setup.termsRequest}
            pharmsmartTicket={welcome.pharmsmartTicket}
            signer={{ name: knownName, email: welcome.email ?? '' }}
            people={{
              superintendent: personFromPrefill(welcome.prefill?.superintendentFirstName, welcome.prefill?.superintendentLastName, welcome.prefill?.superintendentEmail),
              manager: personFromPrefill(welcome.prefill?.managerFirstName, welcome.prefill?.managerLastName, welcome.prefill?.managerEmail),
            }}
            termsFile={async () => partnerTermsSignupFileUrl(setup.termsRequest!.id)}
            termsVersion={termsVersion}
            onClose={() => setTermsOpen(false)}
            onAccepted={() => {
              setTermsOpen(false);
              setSetup(afterTermsAccepted);
              // Then Worldpay, which the pharmacy can close to skip.
              setWorldpayOpen(true);
            }}
          />
          {setup.termsRequest ? (
            <WorldpayApplicationForm
              open={worldpayOpen}
              owner={{ kind: 'request', onboardingRequestId: setup.termsRequest.id }}
              // A company looked up on the Curaleaf form starts a new application already filled in.
              startWithCompany={company}
              onClose={() => setWorldpayOpen(false)}
              onChanged={change => {
                if (change.status && change.status !== 'DRAFT') setSetup(current => ({ ...current, worldpay: 'sent' }));
                else setWorldpayDraft(change.status === 'DRAFT' && change.existingAccount !== 'online');
              }}
            />
          ) : null}
      </div>
    </div>
  );
}
