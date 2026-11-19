import { ArrowRight, FileText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import HhhBrandMark from '../components/HhhBrandMark';
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
  setupFinished,
  worldpayUnlocked,
} from './onboarding-flow';
import {
  PHARMACY_ONBOARDING_CHOICES,
  PHARMACY_ONBOARDING_PITCH,
  PHARMSMART_ONBOARDING_PACKETS,
  pharmsmartOnboardingBookingUrl,
  type PharmacyOnboardingChoice,
} from './pharmsmart-login';
import { recordPharmacyOnboardingDeferral } from '../shared/api';
import type { PharmsmartWelcome as PharmsmartWelcomeDetails } from './types';
import { OnboardingHoldPage } from '../onboarding/OnboardingHold';
import { OnboardingAwaitingPage } from '../onboarding/OnboardingAwaiting';

const BROCHURE = PHARMSMART_ONBOARDING_PACKETS.find(packet => packet.title === 'Brochure')!;



function OnboardingPdfPreview({ href }: { href: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const documentRef = useRef<PDFDocumentProxy | null>(null);
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setPage(1);
    setPages(0);
    void (async () => {
      const pdfjs = await import('pdfjs-dist');
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const response = await fetch(href);
      if (!response.ok) throw new Error('The document could not be opened.');
      const data = new Uint8Array(await response.arrayBuffer());
      const task = pdfjs.getDocument({ data });
      loadingTaskRef.current = task;
      const document = await task.promise;
      if (cancelled) return;
      documentRef.current = document;
      setPages(document.numPages);
    })().catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      const task = loadingTaskRef.current;
      loadingTaskRef.current = null;
      documentRef.current = null;
      if (task && typeof task.destroy === 'function') void task.destroy().catch(() => undefined);
    };
  }, [href]);

  useEffect(() => {
    const document = documentRef.current;
    const canvas = canvasRef.current;
    if (!document || !canvas || pages < 1) return;
    let cancelled = false;
    let cancelRender = () => {};
    void (async () => {
      const pdfPage = await document.getPage(page);
      if (cancelled) return;
      const stage = canvas.parentElement;
      const maxWidth = Math.max((stage?.clientWidth ?? 800) - 32, 280);
      const base = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: maxWidth / base.width });
      const context = canvas.getContext('2d');
      if (!context) return;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const task = pdfPage.render({ canvasContext: context, canvas, viewport });
      cancelRender = () => task.cancel();
      await task.promise;
    })().catch(() => undefined);
    return () => {
      cancelled = true;
      try { cancelRender(); } catch { /* a finished page has nothing left to cancel */ }
    };
  }, [page, pages]);

  if (failed) return <p className="pharmsmart-guide__preview-status">This document could not be opened here. Download it instead.</p>;
  return (
    <div className="onboarding-pdf">
      <div className="onboarding-pdf__toolbar">
        <button type="button" onClick={() => setPage(current => Math.max(1, current - 1))} disabled={page <= 1}>Previous page</button>
        <span>{pages ? `Page ${page} of ${pages}` : 'Opening…'}</span>
        <button type="button" onClick={() => setPage(current => Math.min(pages || current, current + 1))} disabled={!pages || page >= pages}>Next page</button>
      </div>
      <div className="onboarding-pdf__stage">
        <canvas ref={canvasRef} aria-label={pages ? `Page ${page} of ${pages}` : 'Opening document'} />
      </div>
    </div>
  );
}

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

  const choose = (next: PharmacyOnboardingChoice) => {
    interacted.current = true;
    setChoice(next);
    if (next === 'later') void recordNotYet();
  };

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
          <p className="onb__account">Already on Holistic Health Hub? {signIn}</p>
        </header>

        <section className="onb__hero" aria-labelledby="onb-title">
          <div className="onb__pitch">
            <p className="onb__eyebrow">{PHARMACY_ONBOARDING_PITCH.eyebrow}</p>
            <h1 id="onb-title">{PHARMACY_ONBOARDING_PITCH.title}</h1>
            <p className="onb__lede">{PHARMACY_ONBOARDING_PITCH.lede}</p>
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
                <h2 id="onb-setup">{finished ? 'You are all set' : 'Three steps to set up'}</h2>
                <span className="onb__progress">{Number(submitted) + Number(termsAccepted) + Number(setup.worldpay === 'sent')} of 3 done</span>
              </div>
              <p>
                {finished
                  ? `Your application is with our team and Curaleaf Laboratories. We will email the pharmacy address when your account is ready.${setup.worldpay === 'skipped' ? ' You can send the Worldpay form later.' : ''}`
                  : 'Each step leads into the next and takes a few minutes. The Worldpay form can wait until later.'}
              </p>
              <ol className="onb__forms">
                <li className={submitted ? 'is-done' : undefined}>
                  <div>
                    <h3>Curaleaf account</h3>
                    <p>Opens your account with Curaleaf Laboratories, so you can order stock. You will need your GPhC premises number, company name, invoice and delivery addresses, and an accounts contact.</p>
                  </div>
                  {submitted
                    ? <p className="onb__done">Sent</p>
                    : <button type="button" className="onb__button onb__button--primary" onClick={() => setQuickStartOpen(true)}>Fill in</button>}
                </li>
                <li className={termsAccepted ? 'is-done' : undefined}>
                  <div>
                    <h3>Partner Terms</h3>
                    <p>Confirm you can accept our terms for the pharmacy and sign with your name. This sends your Curaleaf form to Curaleaf Laboratories.</p>
                  </div>
                  {termsAccepted
                    ? <p className="onb__done">Accepted</p>
                    : <button type="button" className="onb__button onb__button--primary" onClick={() => setTermsOpen(true)} disabled={!submitted}>Read and accept</button>}
                </li>
                <li className={setup.worldpay === 'sent' ? 'is-done' : undefined}>
                  <div>
                    <h3>Worldpay card payments</h3>
                    <p>Lets patients pay by card through a secure link. You will need the bank account for payouts and each owner's date of birth and home address. You can skip this and do it later.</p>
                  </div>
                  {setup.worldpay === 'sent'
                    ? <p className="onb__done">Sent</p>
                    : setup.worldpay === 'skipped'
                      ? <p className="onb__done">Skipped</p>
                      : (
                        <span className="onb__actions">
                          <button type="button" className="onb__button onb__button--primary" onClick={() => setWorldpayOpen(true)} disabled={!worldpayReady}>Fill in</button>
                          {worldpayReady
                            ? <button type="button" className="onb__button onb__button--quiet" onClick={() => setSetup(current => ({ ...current, worldpay: 'skipped' }))}>Skip for now</button>
                            : null}
                        </span>
                      )}
                </li>
              </ol>
            </section>
          ) : null}

          {choice === 'demo' ? (
            <section className="onb__panel" aria-labelledby="onb-demo">
              <div className="onb__panel-head">
                <h2 id="onb-demo">Book a 30-minute demo</h2>
                <a href={bookingUrl} target="_blank" rel="noopener noreferrer">Open in a new tab</a>
              </div>
              <p>Pick a time with Shaylen Patel. You can set up afterwards from this page.</p>
              <iframe className="onb__calendar" title="30-minute demo call with Shaylen Patel" src={embeddedBookingUrl} />
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
              // Straight on to the Terms, with no stop on this page in between.
              setTermsOpen(true);
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
              }}
            />
          ) : null}
      </div>
    </div>
  );
}
