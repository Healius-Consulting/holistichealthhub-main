import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import HhhBrandMark from '../components/HhhBrandMark';
import { readOnboardingSpreadsheet, type OnboardingSheetRow } from './onboarding-sheet';
import { CuraleafAccountForm, type CuraleafFormValues } from './CuraleafAccountForm';
import { WorldpayForm, type WorldpayPrincipalStart, type WorldpayStart } from './WorldpayForm';
import {
  PHARMACY_ONBOARDING_CHOICES,
  PHARMACY_ONBOARDING_PITCH,
  PHARMSMART_ONBOARDING_PACKETS,
  pharmsmartOnboardingBookingUrl,
  type PharmacyOnboardingChoice,
} from './pharmsmart-login';
import { recordPharmacyOnboardingDeferral } from '../shared/api';
import type { PharmsmartWelcome as PharmsmartWelcomeDetails } from './types';

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

function OnboardingSheetPreview({ href }: { href: string }) {
  const [rows, setRows] = useState<OnboardingSheetRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setFailed(false);
    void fetch(href)
      .then(response => {
        if (!response.ok) throw new Error('The form could not be opened.');
        return response.arrayBuffer();
      })
      .then(readOnboardingSpreadsheet)
      .then(next => { if (!cancelled) setRows(next); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [href]);

  if (failed) return <p className="pharmsmart-guide__preview-status">This form could not be opened here. Download it instead.</p>;
  if (!rows) return <p className="pharmsmart-guide__preview-status">Opening the form…</p>;
  return (
    <div className="pharmsmart-guide__sheet" tabIndex={0}>
      {rows.map((row, index) => (
        <div key={`${index}:${row.label}`}>
          {row.label ? <strong>{row.label}</strong> : null}
          {row.value ? <span>{row.value}</span> : null}
        </div>
      ))}
    </div>
  );
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
  const [submitted, setSubmitted] = useState(false);
  const [curaleafValues, setCuraleafValues] = useState<CuraleafFormValues | null>(null);
  const [worldpayOpen, setWorldpayOpen] = useState(false);
  const [worldpaySent, setWorldpaySent] = useState(false);
  const [choice, setChoice] = useState<PharmacyOnboardingChoice | null>(null);
  const [deferral, setDeferral] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const deferralKey = useRef(crypto.randomUUID());

  const panelRef = useRef<HTMLDivElement>(null);

  const choose = (next: PharmacyOnboardingChoice) => {
    setChoice(next);
    if (next === 'later') void recordNotYet();
  };

  // The chosen panel sits below the hero; bring it into view, mostly for phones.
  useEffect(() => {
    if (!choice || formOpen || worldpayOpen) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    panelRef.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
  }, [choice, formOpen, worldpayOpen]);

  // Whatever the pharmacy has already told us carries into the Worldpay form.
  const worldpayPrefill: WorldpayStart = {
    legalName: curaleafValues?.registeredCompanyName ?? welcome.prefill?.registeredCompanyName,
    tradingName: curaleafValues?.pharmacyName ?? welcome.prefill?.pharmacyName,
    contactName: curaleafValues?.pharmacistName ?? knownName,
    gphcNumber: curaleafValues?.gphcNumber ?? welcome.gphcNumber ?? undefined,
    registeredAddress: curaleafValues?.invoiceAddress ?? welcome.prefill?.invoiceAddress,
    tradingAddress: curaleafValues?.deliveryAddress ?? welcome.prefill?.deliveryAddress,
    landline: curaleafValues?.pharmacyPhone ?? welcome.prefill?.pharmacyPhone,
    businessEmail: curaleafValues?.pharmacyEmail ?? welcome.prefill?.pharmacyEmail,
  };
  // PharmSmart's superintendent is the likeliest owner or director, so they start as the first principal.
  const worldpayPrincipal: WorldpayPrincipalStart = {
    firstNames: welcome.prefill?.superintendentFirstName,
    surname: welcome.prefill?.superintendentLastName,
    email: welcome.prefill?.superintendentEmail,
    mobile: welcome.prefill?.superintendentPhone,
  };

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
            <p className="onb__brochure">
              Want the detail first? <button type="button" onClick={() => setViewing(BROCHURE.href)}>Read the brochure</button>
            </p>
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
                <h2 id="onb-setup">{submitted && worldpaySent ? 'You are all set' : 'Two forms to set up'}</h2>
                <span className="onb__progress">{Number(submitted) + Number(worldpaySent)} of 2 sent</span>
              </div>
              <p>
                {submitted && worldpaySent
                  ? 'Both forms are with our team. We will email the pharmacy address when your account is ready.'
                  : 'Fill both in on this page. Each one takes a few minutes, and you can do them in either order.'}
              </p>
              <ol className="onb__forms">
                <li className={submitted ? 'is-done' : undefined}>
                  <div>
                    <h3>Curaleaf account</h3>
                    <p>Opens your account with Curaleaf Laboratories, so you can order stock. You will need your GPhC premises number, company name, invoice and delivery addresses, and an accounts contact.</p>
                  </div>
                  {submitted
                    ? <p className="onb__done">Sent</p>
                    : <button type="button" className="onb__button onb__button--primary" onClick={() => setFormOpen(true)}>Fill in</button>}
                </li>
                <li className={worldpaySent ? 'is-done' : undefined}>
                  <div>
                    <h3>Worldpay card payments</h3>
                    <p>Lets patients pay by card through a secure link. You will need the bank account for payouts and each owner's date of birth and home address.</p>
                  </div>
                  {worldpaySent
                    ? <p className="onb__done">Sent</p>
                    : <button type="button" className="onb__button onb__button--primary" onClick={() => setWorldpayOpen(true)}>Fill in</button>}
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
                {openPacket.preview === 'sheet'
                  ? <OnboardingSheetPreview href={openPacket.href} />
                  : <OnboardingPdfPreview href={openPacket.href} />}
              </div>
            </div>,
            document.body,
          ) : null}
          <CuraleafAccountForm
            open={formOpen}
            welcome={welcome}
            onClose={() => setFormOpen(false)}
            onSubmitted={values => { setFormOpen(false); setSubmitted(true); setCuraleafValues(values); }}
          />
          <WorldpayForm
            open={worldpayOpen}
            prefill={worldpayPrefill}
            principal={worldpayPrincipal}
            onClose={() => setWorldpayOpen(false)}
            onSubmitted={() => { setWorldpayOpen(false); setWorldpaySent(true); }}
          />
      </div>
    </div>
  );
}
