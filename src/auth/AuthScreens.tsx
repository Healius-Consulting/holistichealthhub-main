import { useEffect, useState, type FormEvent } from 'react';
import { confirmPasswordReset, verifyPasswordResetCode } from 'firebase/auth';
import { FirebaseError } from 'firebase/app';
import { AlertCircle, CheckCircle2, Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole, LogIn, Mail, RefreshCw, ShieldCheck } from 'lucide-react';
import { firebaseConfiguration, mfaRequired } from './firebase';
import { requireFirebaseAuth } from './firebase';
import { totpQrDataUrl } from './totpQr';
import { useAuth } from './useAuth';
import HhhBrandMark from '../components/HhhBrandMark';

function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="staff-login-page auth-page">
      <section className="staff-login-brand">
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
      </section>
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

export function StaffLogin() {
  const { state, signIn, sendPasswordReset } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [resetMode, setResetMode] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

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
  return (
    <div className="auth-loading-page" role="status">
      <HhhBrandMark />
      <p>Checking secure session…</p>
    </div>
  );
}
