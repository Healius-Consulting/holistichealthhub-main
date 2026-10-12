import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import HhhBrandMark from '../components/HhhBrandMark';
import { readOnboardingSpreadsheet, type OnboardingSheetRow } from './onboarding-sheet';
import { PHARMSMART_ONBOARDING_PACKETS, pharmsmartOnboardingBookingUrl } from './pharmsmart-login';
import type { PharmsmartWelcome as PharmsmartWelcomeDetails } from './types';

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

  return (
    <div className="staff-login-page auth-page staff-login-page--guide">
      <section className="staff-login-panel">
        <div className="pharmsmart-guide">
          <a className="pharmsmart-welcome-skip" href="#onboarding-packets">Skip to the documents</a>
          <div className="pharmsmart-guide__layout">
          <header className="pharmsmart-guide__intro">
            <div className="staff-login-lockup" aria-label="Holistic Health Hub">
              <HhhBrandMark />
              <span>
                <strong>Holistic Health Hub</strong>
                <small>Pharmacy onboarding</small>
              </span>
            </div>
            <h1 id="pharmsmart-welcome-title">This pharmacy is not on Holistic Health Hub yet</h1>
            {knownName ? <p className="pharmsmart-guide__person">Signed in from PharmSmart as {knownName}.</p> : null}
            <p>Send us the Curaleaf account form and the Worldpay form. You can do that without a call. After approval, you will get an email saying you can start using the platform.</p>
          </header>
          <section className="pharmsmart-guide__book" aria-labelledby="pharmsmart-welcome-book">
            <h2 id="pharmsmart-welcome-book">Want more information?</h2>
            <p>A call is optional. Book one if you would like to talk it through before you send the forms.</p>
            <iframe
              className="pharmsmart-welcome-calendar"
              title="Optional 30-minute call with Shaylen Patel"
              src={embeddedBookingUrl}
            />
            <a href={bookingUrl} target="_blank" rel="noopener noreferrer">Open the booking page</a>
          </section>
          <div className="pharmsmart-guide__materials">
            <section className="pharmsmart-guide__brochure" aria-labelledby="pharmsmart-welcome-brochure">
              <h2 id="pharmsmart-welcome-brochure">Brochure</h2>
              {PHARMSMART_ONBOARDING_PACKETS.filter(packet => packet.detail !== 'FORM').map(packet => (
                <div key={packet.href}>
                  <p>{packet.summary}</p>
                  <div className="pharmsmart-guide__actions">
                    <button className="pharmsmart-guide__view" type="button" aria-expanded={viewing === packet.href} aria-label={`View ${packet.title}`} onClick={() => setViewing(packet.href)}>View</button>
                    <a className="pharmsmart-guide__download" href={packet.href} download aria-label={`Download ${packet.title}`}>Download</a>
                  </div>
                </div>
              ))}
            </section>
            <section id="onboarding-packets" className="pharmsmart-guide__docs" aria-labelledby="pharmsmart-welcome-docs">
              <h2 id="pharmsmart-welcome-docs">Send us the forms</h2>
              <ul>
                {PHARMSMART_ONBOARDING_PACKETS.filter(packet => packet.detail === 'FORM').map(packet => (
                  <li key={packet.href}>
                    <div>
                      <span className="pharmsmart-guide__name">
                        <strong>{packet.title}</strong>
                        <span className="pharmsmart-guide__tag">FORM</span>
                      </span>
                      <p>{packet.summary}</p>
                    </div>
                    <div className="pharmsmart-guide__actions">
                      <button className="pharmsmart-guide__view" type="button" aria-expanded={viewing === packet.href} onClick={() => setViewing(packet.href)}>View</button>
                      <a className="pharmsmart-guide__download" href={packet.href} download>Download</a>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="pharmsmart-guide__send">Send us the forms here</p>
              <div className="pharmsmart-guide__contact">
                <a href="mailto:spatel@healiusconsulting.com">spatel@healiusconsulting.com</a>
              </div>
            </section>
          </div>
          </div>
          <section className="pharmsmart-guide__account" aria-labelledby="pharmsmart-welcome-account">
            <h2 id="pharmsmart-welcome-account">Already have an account</h2>
            {accountHref
              ? <a className="pharmsmart-guide__email" href={accountHref} target="_blank" rel="noopener noreferrer">Use email and password</a>
              : <button className="pharmsmart-guide__email" type="button" onClick={onUseEmail}>Use email and password</button>}
            <p>If this page should not have shown, email <a href="mailto:spatel@healiusconsulting.com">spatel@healiusconsulting.com</a> and we can look into it.</p>
          </section>
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
        </div>
      </section>
    </div>
  );
}
