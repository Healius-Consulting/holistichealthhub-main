import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { confirmPasswordReset, verifyPasswordResetCode } from 'firebase/auth';
import { FirebaseError } from 'firebase/app';
import { AlertCircle, CheckCircle2, Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole, LogIn, Mail, RefreshCw, ShieldCheck } from 'lucide-react';
import { firebaseConfiguration, mfaRequired } from './firebase';
import { requireFirebaseAuth } from './firebase';
import { totpQrDataUrl } from './totpQr';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { readOnboardingSpreadsheet, type OnboardingSheetRow } from './onboarding-sheet';
import { PHARMSMART_ONBOARDING_PACKETS, pharmsmartLoginQuery, pharmsmartOnboardingBookingUrl } from './pharmsmart-login';
import type { PharmsmartWelcome as PharmsmartWelcomeDetails } from './types';
import { useAuth } from './useAuth';
import HhhBrandMark from '../components/HhhBrandMark';

function AuthShell({ children, guide = false }: { children: React.ReactNode; guide?: boolean }) {
  return (
    <div className={`staff-login-page auth-page${guide ? ' staff-login-page--guide' : ''}`}>
      {guide ? null : <section className="staff-login-brand">
        <div className="staff-login-lockup" aria-label="Holistic Health Hub">
          <HhhBrandMark />
          <span>
            <strong>Holistic Health Hub</strong>
            <small>Staff workspace</small>
          </span>
        </div>
        <p className="staff-login-kicker">Staff portal</p>
        <h1>Referrals, payments and stock ordering made easy.</h1>
        <p>Patient accounts are not supported in this staff application. Active patients will have access to their own Curaleaf portal for ordering Rx and appointments.</p>
        <div className="staff-login-trust">
          <span><ShieldCheck size={16} aria-hidden="true" /> Tenant isolation</span>
          <span><KeyRound size={16} aria-hidden="true" /> {mfaRequired ? 'Mandatory MFA' : 'Verified staff access'}</span>
        </div>
      </section>}
      <section className="staff-login-panel">{children}</section>
    </div>
  );
}

function passwordResetErrorMessage(cause: unknown) {
  if (!(cause instanceof FirebaseError)) return 'Your password could not be updated. Check your connection and try again.';
  if (cause.code === 'auth/expired-action-code' || cause.code === 'auth/invalid-action-code') return 'This reset link has expired or has already been used. Request a new one.';
  if (cause.code === 'auth/network-request-failed') return 'The password could not be updated because the network connection was interrupted. Try again.';
  if (cause.code === 'auth/too-many-requests') return 'Too many attempts were made. Wait a few minutes, then try again.';
  if (cause.code === 'auth/user-disabled' || cause.code === 'auth/user-not-found') return 'This staff account is no longer available. Contact an HHH administrator.';
  if (cause.code === 'auth/weak-password' || cause.code === 'auth/password-does-not-meet-requirements') {
    const detail = cause.message.replace(/^Firebase:\s*/i, '').replace(/\s*\(auth\/[^)]+\)\.?$/i, '').trim();
    return detail || 'The new password does not meet the account password policy. Use a longer, unique passphrase and try again.';
  }
  return 'Your password could not be updated. Try again or request a new reset link.';
}

export function ConfigurationRequired() {
  return (
    <AuthShell>
      <section className="card staff-login-card auth-configuration-required" role="status">
        <div className="staff-login-heading"><div className="resource-icon"><LockKeyhole size={20} aria-hidden="true" /></div><div><p className="staff-login-kicker">Configuration required</p><h2>Connect Firebase security services</h2></div></div>
        <p>This deployment is intentionally locked because Firebase Authentication or App Check has not been configured.</p>
        <div className="banner banner-amber"><AlertCircle size={16} /><span>Add the following Vercel environment variables, then redeploy.</span></div>
        <ul className="auth-config-list">
          {firebaseConfiguration.missingKeys.map(key => <li key={key}><code>{key}</code></li>)}
          <li><code>VITE_API_BASE_URL</code> <small>required for backend operations</small></li>
        </ul>
        <p className="staff-login-note">No demo password or bypass is enabled. Configure invited staff users with role claims in Firebase before testing.</p>
      </section>
    </AuthShell>
  );
}

function PharmsmartSetupForm() {
  const { state, completePharmsmartSetup, clearPharmsmartSetup } = useAuth();
  const setup = state.pharmsmartSetup;
  const [email, setEmail] = useState(setup?.email ?? '');
  const [firstName, setFirstName] = useState(setup?.firstName ?? '');
  const [lastName, setLastName] = useState(setup?.lastName ?? '');
  const [saving, setSaving] = useState(false);
  if (!setup) return null;
  const needsEmail = setup.missing.includes('email');
  const needsName = setup.missing.includes('name');
  const knownName = [setup.firstName, setup.lastName].filter(Boolean).join(' ');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    try {
      await completePharmsmartSetup({
        email: needsEmail ? email.trim() : undefined,
        firstName: needsName ? firstName.trim() : undefined,
        lastName: needsName ? lastName.trim() : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <AuthShell>
      <form className="card staff-login-card" onSubmit={submit}>
        <div className="staff-login-heading"><div className="resource-icon"><LockKeyhole size={20} aria-hidden="true" /></div><div><p className="staff-login-kicker">PharmSmart sign-in</p><h2>Finish your pharmacy account</h2></div></div>
        <p className="staff-login-note">PharmSmart did not send every detail for this account. Add what's missing. Pharmacy messages still go to the pharmacy inbox, not this sign-in.</p>
        {knownName && !needsName ? <p className="staff-login-note">{knownName}</p> : null}
        {setup.email && !needsEmail ? <p className="staff-login-note">{setup.email}</p> : null}
        {needsName && <label className="staff-login-field">First name<div className="staff-login-input"><input value={firstName} onChange={event => setFirstName(event.target.value)} autoComplete="given-name" required /></div></label>}
        {needsName && <label className="staff-login-field">Last name<div className="staff-login-input"><input value={lastName} onChange={event => setLastName(event.target.value)} autoComplete="family-name" required /></div></label>}
        {needsEmail && <label className="staff-login-field">Email address<div className="staff-login-input"><Mail size={16} /><input type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="username" required placeholder="name@pharmacy.co.uk" /></div></label>}
        {state.error && <div className="banner banner-red" role="alert"><AlertCircle size={15} /> {state.error}</div>}
        <button className="btn btn-primary staff-login-submit" type="submit" disabled={saving || state.phase === 'loading'}>{saving || state.phase === 'loading' ? <LoaderCircle size={16} /> : <LogIn size={16} />} {saving || state.phase === 'loading' ? 'Opening…' : 'Continue'}</button>
        <button className="btn btn-sm auth-link-button" type="button" onClick={clearPharmsmartSetup}>Use email and password instead</button>
      </form>
    </AuthShell>
  );
}

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

export function PharmsmartWelcome({ welcome, onUseEmail }: { welcome: PharmsmartWelcomeDetails; onUseEmail: () => void }) {
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
    <AuthShell guide>
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
          <button className="pharmsmart-guide__email" type="button" onClick={onUseEmail}>Use email and password</button>
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
    </AuthShell>
  );
}

export function StaffLogin() {
  const { state, signIn, sendPasswordReset, signInWithPharmsmart, clearPharmsmartSetup } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [resetMode, setResetMode] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    const current = pharmsmartLoginQuery(window.location.search);
    if (!current.hasToken) return;
    window.history.replaceState(null, '', `${window.location.pathname}${current.searchWithoutToken}${window.location.hash}`);
    void signInWithPharmsmart(current.token);
  }, [signInWithPharmsmart]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    if (resetMode) {
      try {
        await sendPasswordReset(email);
        setMessage('If an invited staff account exists for that address, reset instructions will be sent.');
      } catch {
        setMessage('Password reset is temporarily unavailable. Contact an HHH administrator.');
      }
      return;
    }
    await signIn(email, password);
  };

  if (state.pharmsmartSetup) return <PharmsmartSetupForm />;
  if (state.pharmsmartWelcome) return <PharmsmartWelcome welcome={state.pharmsmartWelcome} onUseEmail={clearPharmsmartSetup} />;

  return (
    <AuthShell>
      <form className="card staff-login-card" onSubmit={submit}>
        <div className="staff-login-heading"><div className="resource-icon"><LockKeyhole size={20} aria-hidden="true" /></div><div><p className="staff-login-kicker">Staff access</p><h2>{resetMode ? 'Reset your password' : 'Sign in to Holistic Health Hub'}</h2></div></div>
        {state.notice && <div className="banner banner-blue" role="status"><CheckCircle2 size={15} /> {state.notice}</div>}
        <label className="staff-login-field">Email address<div className="staff-login-input"><Mail size={16} /><input type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="username" required placeholder="name@pharmacy.co.uk" /></div></label>
        {!resetMode && <label className="staff-login-field">Password<div className="staff-login-input"><LockKeyhole size={16} /><input type={showPassword ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required /><button className="auth-password-toggle" type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>}
        {state.error && <div className="banner banner-red" role="alert"><AlertCircle size={15} /> {state.error}</div>}
        {message && <div className="banner banner-blue" role="status">{message}</div>}
        <button className="btn btn-primary staff-login-submit" type="submit" disabled={state.phase === 'loading'}>{state.phase === 'loading' ? <LoaderCircle size={16} /> : resetMode ? <RefreshCw size={16} /> : <LogIn size={16} />} {state.phase === 'loading' ? 'Checking…' : resetMode ? 'Send reset email' : 'Sign in'}</button>
        <button className="btn btn-sm auth-link-button" type="button" onClick={() => { setResetMode(value => !value); setMessage(null); }}>{resetMode ? 'Back to sign in' : 'Forgotten your password?'}</button>
        <p className="staff-login-note">Access is invite-only. Authentication events and access to pharmacy data are auditable.</p>
      </form>
    </AuthShell>
  );
}

export function PasswordResetScreen() {
  const params = new URLSearchParams(window.location.search);
  const oobCode = params.get('oobCode') ?? '';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [phase, setPhase] = useState<'checking' | 'ready' | 'saving' | 'complete' | 'invalid'>('checking');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!oobCode) {
      setPhase('invalid');
      return;
    }
    void verifyPasswordResetCode(requireFirebaseAuth(), oobCode)
      .then(address => { setEmail(address); setPhase('ready'); })
      .catch(() => setPhase('invalid'));
  }, [oobCode]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Use at least 8 characters for your new password.');
      return;
    }
    if (password !== confirmation) {
      setError('The passwords do not match.');
      return;
    }
    setPhase('saving');
    try {
      await confirmPasswordReset(requireFirebaseAuth(), oobCode, password);
      setPhase('complete');
    } catch (cause) {
      setError(passwordResetErrorMessage(cause));
      setPhase('ready');
    }
  };

  return (
    <AuthShell>
      <section className="card staff-login-card password-reset-card">
        <div className="staff-login-heading"><div className="resource-icon"><KeyRound size={20} aria-hidden="true" /></div><div><p className="staff-login-kicker">Secure account</p><h2>{phase === 'complete' ? 'Password updated' : phase === 'invalid' ? 'Reset link unavailable' : phase === 'checking' ? 'Checking your reset link' : 'Choose a new password'}</h2></div></div>
        {phase === 'checking' && <div className="auth-reset-status" role="status"><LoaderCircle className="spin" size={20} aria-hidden="true" /> Checking your secure reset link…</div>}
        {phase === 'invalid' && <><div className="banner banner-red" role="alert"><AlertCircle size={16} aria-hidden="true" /> This reset link is invalid or has expired.</div><a className="btn btn-primary staff-login-submit" href="/login">Request a new reset email</a></>}
        {phase === 'complete' && <><div className="auth-reset-success"><CheckCircle2 size={30} aria-hidden="true" /><div><strong>Your password is ready</strong><span>You can now sign in to the Holistic Health Hub staff portal.</span></div></div><a className="btn btn-primary staff-login-submit" href="/login">Continue to staff sign in</a></>}
        {(phase === 'ready' || phase === 'saving') && <form onSubmit={submit}>
          <p>Updating the password for <strong>{email}</strong>.</p>
          <label className="staff-login-field">New password<div className="staff-login-input"><LockKeyhole size={16} aria-hidden="true" /><input type={showPassword ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" minLength={8} required /><button className="auth-password-toggle" type="button" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? 'Hide passwords' : 'Show passwords'} aria-pressed={showPassword}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
          <label className="staff-login-field">Confirm new password<div className="staff-login-input"><LockKeyhole size={16} aria-hidden="true" /><input type={showPassword ? 'text' : 'password'} value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="new-password" minLength={8} required /></div></label>
          <small className="auth-password-guidance">Use at least 8 characters. A longer, unique passphrase is recommended.</small>
          {error && <div className="banner banner-red" role="alert"><AlertCircle size={15} aria-hidden="true" /> {error}</div>}
          <button className="btn btn-primary staff-login-submit" type="submit" disabled={phase === 'saving'}>{phase === 'saving' ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} aria-hidden="true" />} {phase === 'saving' ? 'Updating password…' : 'Update password'}</button>
        </form>}
      </section>
    </AuthShell>
  );
}

export function EmailVerificationGate() {
  const { state, resendVerification, refreshVerification, signOutStaff } = useAuth();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <AuthShell>
      <section className="card staff-login-card">
        <div className="staff-login-heading"><div className="resource-icon"><Mail size={20} aria-hidden="true" /></div><div><p className="staff-login-kicker">Identity check</p><h2>Verify your email address</h2></div></div>
        <p>Open the verification email sent to <strong>{state.staff?.email}</strong>. Workspace data remains locked until verification is complete.</p>
        {message && <div className="banner banner-blue" role="status">{message}</div>}
        <button className="btn btn-primary" disabled={busy} onClick={() => { setBusy(true); void refreshVerification().catch(() => setMessage('Verification could not be checked yet.')).finally(() => setBusy(false)); }}><RefreshCw size={15} aria-hidden="true" /> I have verified my email</button>
        <button className="btn" disabled={busy} onClick={() => { setBusy(true); void resendVerification().then(() => setMessage('A new verification email has been sent.')).catch(() => setMessage('A new email could not be sent yet.')).finally(() => setBusy(false)); }}>Resend verification</button>
        <button className="btn btn-sm" onClick={() => void signOutStaff()}>Use another account</button>
      </section>
    </AuthShell>
  );
}

export function MfaChallenge() {
  const { state, completeMfaChallenge, signOutStaff } = useAuth();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <AuthShell>
      <form className="card staff-login-card" onSubmit={event => { event.preventDefault(); setBusy(true); void completeMfaChallenge(code).finally(() => setBusy(false)); }}>
        <div className="staff-login-heading"><div className="resource-icon"><ShieldCheck size={20} aria-hidden="true" /></div><div><p className="staff-login-kicker">Two-step verification</p><h2>Enter your authenticator code</h2></div></div>
        <p>Enter the current six-digit code from the authenticator app registered to your Holistic Health Hub staff account.</p>
        <label className="staff-login-field">Verification code<input className="input auth-code-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} required /></label>
        {state.error && <div className="banner banner-red" role="alert"><AlertCircle size={15} aria-hidden="true" /> {state.error}</div>}
        <button className="btn btn-primary" type="submit" disabled={busy || code.length !== 6}>Verify and continue</button>
        <button className="btn btn-sm" type="button" onClick={() => void signOutStaff()}>Cancel sign-in</button>
      </form>
    </AuthShell>
  );
}

export function MfaEnrollmentGate() {
  const { state, beginTotpEnrollment, completeTotpEnrollment, signOutStaff } = useAuth();
  const [details, setDetails] = useState<{ secretKey: string; qrImageSrc: string | null } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const begin = () => {
    setBusy(true);
    setError(null);
    void beginTotpEnrollment()
      .then(async enrollment => {
        const qrImageSrc = await totpQrDataUrl(enrollment.qrCodeUrl);
        setDetails({ secretKey: enrollment.secretKey, qrImageSrc });
        if (!qrImageSrc) setError('The QR code could not be drawn. Use the manual setup key.');
      })
      .catch(cause => setError(cause instanceof Error ? cause.message : 'Authenticator enrolment could not begin.'))
      .finally(() => setBusy(false));
  };

  const complete = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    void completeTotpEnrollment(code).catch(cause => setError(cause instanceof Error ? cause.message : 'That code could not be verified.')).finally(() => setBusy(false));
  };

  return (
    <AuthShell>
      <form className="card staff-login-card mfa-enrollment-card" onSubmit={complete}>
        <div className="staff-login-heading"><div className="resource-icon"><ShieldCheck size={20} aria-hidden="true" /></div><div><p className="staff-login-kicker">Required security setup</p><h2>Protect your staff account</h2></div></div>
        <p>{mfaRequired ? 'Holistic Health Hub requires a time-based one-time password (TOTP) before staff can access pharmacy data.' : 'Set up a time-based one-time password (TOTP) to add another layer of protection to this staff account.'}</p>
        {!details ? (
          <button className="btn btn-primary" type="button" disabled={busy} onClick={begin}>Set up authenticator</button>
        ) : (
          <>
            {details.qrImageSrc ? (
              <figure className="mfa-qr-figure">
                <img className="mfa-qr-code" src={details.qrImageSrc} width={220} height={220} alt="QR code for authenticator enrolment" />
                <figcaption>Scan with your authenticator app</figcaption>
              </figure>
            ) : null}
            <div className="mfa-manual-key"><span>Manual setup key</span><code>{details.secretKey}</code></div>
            <label className="staff-login-field">Six-digit verification code<input className="input auth-code-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} required /></label>
            <button className="btn btn-primary" type="submit" disabled={busy || code.length !== 6}>Verify and finish</button>
          </>
        )}
        {(error || state.error) && <div className="banner banner-red" role="alert"><AlertCircle size={15} aria-hidden="true" /> {error || state.error}</div>}
        <button className="btn btn-sm" type="button" onClick={() => void signOutStaff()}>Sign out</button>
      </form>
    </AuthShell>
  );
}

export function AuthLoading() {
  const { state } = useAuth();
  return (
    <div className="auth-loading-page" role="status">
      <HhhBrandMark />
      <p>{state.notice ?? 'Checking secure session…'}</p>
    </div>
  );
}
