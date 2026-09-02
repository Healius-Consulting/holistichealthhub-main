import {
  browserSessionPersistence,
  getMultiFactorResolver,
  inMemoryPersistence,
  multiFactor,
  onIdTokenChanged,
  reload,
  sendEmailVerification,
  setPersistence,
  signInWithEmailAndPassword,
  signOut,
  TotpMultiFactorGenerator,
  type MultiFactorError,
  type MultiFactorResolver,
  type TotpSecret,
  type User,
} from 'firebase/auth';
import { FirebaseError } from 'firebase/app';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  continueAuthenticatedSession,
  createAuthenticatedSession,
  deleteAuthenticatedSession,
  getAuthenticatedSession,
  getStaffAccessibilityPreferences,
  notifyStaffMfaEnrolled,
  requestStaffPasswordReset,
  setApiCsrfToken,
  setApiSecurityTokenProvider,
  updateStaffAccessibilityPreferences,
} from '../shared/api';
import type { AuthenticatedSession } from '../shared/contracts';
import { configureAccessibilitySync, saveAccessibilityPreferences } from '../accessibility/preferences';
import { hydrateWorkspaceTourFromPreferences, mergeStaffPreferences, rememberStaffPreferenceExtras } from '../training/workspaceTourPreferences';
import { firebaseConfiguration, mfaRequired, readAppCheckToken, requireFirebaseAuth, serverSessionAuth } from './firebase';
import { AuthContext, type AuthContextValue } from './AuthContext';
import type { AuthState, AuthenticatedStaff, StaffRole } from './types';
import { isLocalPortalPreview, localPreviewStaff } from '../dev/localPortalPreview';
import { appPathPrefix, isCurrentSurfacePath, surfacePath } from './surface-path';

const IDLE_LIMIT_MS = 15 * 60 * 1000;
const ABSOLUTE_LIMIT_MS = 8 * 60 * 60 * 1000;
const WARNING_WINDOW_MS = 2 * 60 * 1000;
const appSurface = import.meta.env.VITE_APP_SURFACE as 'pharmacy' | 'admin' | undefined;

function friendlyAuthError(error: unknown): string {
  if (!(error instanceof FirebaseError)) return error instanceof Error ? error.message : 'Authentication is unavailable.';
  const messages: Record<string, string> = {
    'auth/invalid-credential': 'Email or password not recognised.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
    'auth/user-disabled': 'This staff account has been disabled. Contact an HHH administrator.',
    'auth/code-expired': 'That verification code has expired. Request a new code.',
    'auth/invalid-verification-code': 'That verification code is not valid.',
    'auth/requires-recent-login': 'Please sign in again before changing security settings.',
  };
  return messages[error.code] || error.message;
}

function hasTotp(user: User) {
  return multiFactor(user).enrolledFactors.some(factor => factor.factorId === TotpMultiFactorGenerator.FACTOR_ID);
}

async function staffFromUser(user: User): Promise<AuthenticatedStaff> {
  const token = await user.getIdTokenResult(true);
  const role = token.claims.role;
  if (role !== 'hhh_admin' && role !== 'pharmacy_staff') throw new Error('This account does not have an HHH staff role. Ask an administrator to assign access.');
  const organisationId = typeof token.claims.organisationId === 'string' ? token.claims.organisationId : undefined;
  if (role === 'pharmacy_staff' && !organisationId) throw new Error('This pharmacy staff account is not assigned to an organisation.');
  return {
    uid: user.uid,
    email: user.email || '',
    name: user.displayName || user.email?.split('@')[0] || 'Staff user',
    role: role as StaffRole,
    organisationId,
    emailVerified: user.emailVerified,
    mfaEnrolled: hasTotp(user),
  };
}

function staffFromSession(session: AuthenticatedSession): AuthenticatedStaff {
  return {
    uid: session.uid,
    email: session.email,
    name: session.displayName,
    role: session.role,
    organisationId: session.organisationId ?? undefined,
    emailVerified: true,
    mfaEnrolled: true,
    surface: session.surface,
    idleExpiresAt: session.idleExpiresAt,
    absoluteExpiresAt: session.absoluteExpiresAt,
  };
}

function redirectToLogin(includeReturnTarget: boolean) {
  if (isCurrentSurfacePath('/login')) return;
  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const loginPath = appPathPrefix ? '/login' : surfacePath('/login');
  window.location.assign(includeReturnTarget ? `${loginPath}?returnTo=${encodeURIComponent(returnTo)}` : loginPath);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => isLocalPortalPreview
    ? { phase: 'authenticated', staff: localPreviewStaff, error: null, notice: null }
    : firebaseConfiguration.configured
      ? { phase: 'loading', staff: null, error: null, notice: null }
      : { phase: 'unconfigured', staff: null, error: null, notice: null });
  const mfaResolver = useRef<MultiFactorResolver | null>(null);
  const totpSecret = useRef<TotpSecret | null>(null);
  const sessionNotice = useRef<string | null>(null);
  const lastActivity = useRef(Date.now());
  const absoluteExpiry = useRef<number | null>(null);
  const authChannel = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (isLocalPortalPreview) {
      setApiSecurityTokenProvider(null);
      return;
    }
    setApiSecurityTokenProvider(async () => {
      if (!firebaseConfiguration.configured) return {};
      const appCheckToken = await readAppCheckToken();
      const headers: Record<string, string> = {
        ...(appCheckToken ? { 'X-Firebase-AppCheck': appCheckToken } : {}),
        ...(import.meta.env.DEV && appSurface ? { 'X-HHH-Surface': appSurface } : {}),
      };
      if (!serverSessionAuth) {
        const user = requireFirebaseAuth().currentUser;
        if (user) headers.Authorization = `Bearer ${await user.getIdToken()}`;
      }
      return headers;
    });
    return () => setApiSecurityTokenProvider(null);
  }, []);

  const setAuthenticatedSession = useCallback((session: AuthenticatedSession) => {
    if (isCurrentSurfacePath('/login')) {
      const candidate = new URLSearchParams(window.location.search).get('returnTo') ?? '/';
      let decoded = '';
      try { decoded = decodeURIComponent(decodeURIComponent(candidate)); } catch { decoded = '//'; }
      const hasControlCharacter = [...decoded].some(character => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
      const safe = candidate.startsWith('/') && !decoded.startsWith('//') && !decoded.includes('\\') && !hasControlCharacter ? candidate : '/';
      if (window.location.pathname === '/login') {
        const workspace = `/${session.surface}`;
        const destination = safe === workspace || safe.startsWith(`${workspace}/`) ? safe : workspace;
        window.location.replace(destination);
        return;
      }
      window.location.replace(safe);
      return;
    }
    setApiCsrfToken(session.csrfToken);
    setState({ phase: 'authenticated', staff: staffFromSession(session), error: null, notice: null, sessionWarning: false });
  }, []);

  const establishServerSession = useCallback(async (user: User) => {
    const idToken = await user.getIdToken(true);
    const session = await createAuthenticatedSession(idToken);
    await signOut(requireFirebaseAuth());
    setAuthenticatedSession(session);
  }, [setAuthenticatedSession]);

  const finishFirebaseSignIn = useCallback(async (user: User) => {
    const staff = await staffFromUser(user);
    if (!user.emailVerified) {
      setState({ phase: 'email-unverified', staff, error: null, notice: null });
      return;
    }
    if (mfaRequired && !staff.mfaEnrolled) {
      setState({ phase: 'mfa-enrollment', staff, error: null, notice: null });
      return;
    }
    if (serverSessionAuth) {
      await establishServerSession(user);
      return;
    }
    const token = await user.getIdTokenResult();
    absoluteExpiry.current = Number(token.claims.auth_time || Math.floor(Date.now() / 1000)) * 1000 + ABSOLUTE_LIMIT_MS;
    lastActivity.current = Date.now();
    setState({ phase: 'authenticated', staff, error: null, notice: null });
  }, [establishServerSession]);

  const signOutStaff = useCallback(async (reason?: string) => {
    if (isLocalPortalPreview) {
      window.location.assign(window.location.pathname + window.location.search);
      return;
    }
    if (!firebaseConfiguration.configured) return;
    sessionNotice.current = reason || 'You have signed out.';
    mfaResolver.current = null;
    totpSecret.current = null;
    if (serverSessionAuth) {
      try { await deleteAuthenticatedSession(); }
      catch { /* local state still fails closed */ }
      setApiCsrfToken(null);
      authChannel.current?.postMessage({ type: 'signed-out', reason: sessionNotice.current });
    }
    await signOut(requireFirebaseAuth()).catch(() => undefined);
    setState({ phase: 'anonymous', staff: null, error: null, notice: sessionNotice.current });
    sessionNotice.current = null;
    if (serverSessionAuth) redirectToLogin(false);
  }, []);

  useEffect(() => {
    if (isLocalPortalPreview || !firebaseConfiguration.configured) return;
    const auth = requireFirebaseAuth();
    void setPersistence(auth, serverSessionAuth ? inMemoryPersistence : browserSessionPersistence);
    if (serverSessionAuth) {
      void getAuthenticatedSession()
        .then(setAuthenticatedSession)
        .catch(() => setState({ phase: 'anonymous', staff: null, error: null, notice: null }));
      return;
    }
    return onIdTokenChanged(auth, async user => {
      if (!user) {
        absoluteExpiry.current = null;
        setState({ phase: 'anonymous', staff: null, error: null, notice: sessionNotice.current });
        sessionNotice.current = null;
        return;
      }
      try { await finishFirebaseSignIn(user); }
      catch (error) { setState({ phase: 'error', staff: null, error: friendlyAuthError(error), notice: null }); }
    });
  }, [finishFirebaseSignIn, setAuthenticatedSession]);

  useEffect(() => {
    if (!serverSessionAuth || isLocalPortalPreview || typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel('hhh-auth');
    authChannel.current = channel;
    channel.onmessage = event => {
      if (event.data?.type === 'signed-out') {
        setApiCsrfToken(null);
        setState({ phase: 'anonymous', staff: null, error: null, notice: event.data.reason || 'Your session ended in another tab.' });
        redirectToLogin(false);
      }
    };
    const sessionEnded = (event: Event) => {
      const code = (event as CustomEvent<{ code?: string }>).detail?.code;
      if (code === 'APP_CHECK_REQUIRED') return;
      const notice = code === 'SESSION_IDLE_EXPIRED' ? 'Your session was locked after 15 minutes of inactivity.' : 'Your secure session ended. Sign in again to continue.';
      setApiCsrfToken(null);
      setState({ phase: 'anonymous', staff: null, error: null, notice });
      channel.postMessage({ type: 'signed-out', reason: notice });
      redirectToLogin(true);
    };
    window.addEventListener('hhh:session-ended', sessionEnded);
    return () => {
      window.removeEventListener('hhh:session-ended', sessionEnded);
      channel.close();
      authChannel.current = null;
    };
  }, []);

  useEffect(() => {
    let active = true;
    let preferenceSaveTimer: number | null = null;
    let pendingPreferences: Parameters<typeof updateStaffAccessibilityPreferences>[0] | null = null;
    let lastPersistedPreferences = '';
    let saveQueue = Promise.resolve();
    configureAccessibilitySync(null);
    if (isLocalPortalPreview || state.phase !== 'authenticated') return () => { active = false; };
    const flushPreferenceSave = () => {
      if (!active || !pendingPreferences) return;
      const preferences = pendingPreferences;
      const serialised = JSON.stringify(preferences);
      pendingPreferences = null;
      preferenceSaveTimer = null;
      if (serialised === lastPersistedPreferences) return;
      saveQueue = saveQueue.then(() => updateStaffAccessibilityPreferences(preferences)).then(() => { lastPersistedPreferences = serialised; }).catch(error => console.warn('Accessibility preferences could not be synchronised:', error));
    };
    const enableSync = () => {
      if (!active) return;
      configureAccessibilitySync(preferences => {
        pendingPreferences = mergeStaffPreferences(preferences);
        if (preferenceSaveTimer !== null) window.clearTimeout(preferenceSaveTimer);
        preferenceSaveTimer = window.setTimeout(flushPreferenceSave, 900);
      });
    };
    void getStaffAccessibilityPreferences().then(preferences => {
      if (!active) return;
      rememberStaffPreferenceExtras(preferences);
      hydrateWorkspaceTourFromPreferences(preferences.workspaceTourCompleted, false);
      lastPersistedPreferences = JSON.stringify(mergeStaffPreferences(preferences));
      saveAccessibilityPreferences(preferences);
      enableSync();
    }).catch(enableSync);
    return () => {
      active = false;
      if (preferenceSaveTimer !== null) window.clearTimeout(preferenceSaveTimer);
      configureAccessibilitySync(null);
    };
  }, [state.phase]);

  useEffect(() => {
    if (isLocalPortalPreview || state.phase !== 'authenticated') return;
    if (serverSessionAuth) {
      let activitySyncAt = 0;
      let activitySyncPending = false;
      const recordAttendedActivity = () => {
        const now = Date.now();
        if (activitySyncPending || now - activitySyncAt < 60_000) return;
        activitySyncPending = true;
        void continueAuthenticatedSession()
          .then(session => { activitySyncAt = Date.now(); setAuthenticatedSession(session); })
          .catch(() => undefined)
          .finally(() => { activitySyncPending = false; });
      };
      const attendedEvents: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart'];
      attendedEvents.forEach(event => window.addEventListener(event, recordAttendedActivity, { passive: true }));
      const timer = window.setInterval(() => {
        const idleAt = Date.parse(state.staff?.idleExpiresAt ?? '');
        const absoluteAt = Date.parse(state.staff?.absoluteExpiresAt ?? '');
        const now = Date.now();
        if (Number.isFinite(absoluteAt) && now >= absoluteAt) void signOutStaff('Your eight-hour session ended. Sign in again to continue.');
        else if (Number.isFinite(idleAt) && now >= idleAt) void signOutStaff('Your session was locked after 15 minutes of inactivity.');
        else if (Number.isFinite(idleAt)) setState(current => current.phase === 'authenticated' ? { ...current, sessionWarning: idleAt - now <= WARNING_WINDOW_MS } : current);
      }, 10_000);
      return () => {
        attendedEvents.forEach(event => window.removeEventListener(event, recordAttendedActivity));
        window.clearInterval(timer);
      };
    }
    const recordActivity = () => { lastActivity.current = Date.now(); };
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart', 'focus'];
    events.forEach(event => window.addEventListener(event, recordActivity, { passive: true }));
    const timer = window.setInterval(() => {
      const now = Date.now();
      if (absoluteExpiry.current && now >= absoluteExpiry.current) void signOutStaff('Your eight-hour session ended. Sign in again to continue.');
      else if (now - lastActivity.current >= IDLE_LIMIT_MS) void signOutStaff('Your session was locked after 15 minutes of inactivity.');
    }, 30_000);
    return () => {
      events.forEach(event => window.removeEventListener(event, recordActivity));
      window.clearInterval(timer);
    };
  }, [setAuthenticatedSession, signOutStaff, state.phase, state.staff?.absoluteExpiresAt, state.staff?.idleExpiresAt]);

  const continueSession = useCallback(async () => {
    if (!serverSessionAuth) { lastActivity.current = Date.now(); return; }
    setAuthenticatedSession(await continueAuthenticatedSession());
  }, [setAuthenticatedSession]);

  const signInStaff = useCallback(async (email: string, password: string) => {
    setState(current => ({ ...current, phase: 'loading', error: null, notice: null }));
    try {
      const credential = await signInWithEmailAndPassword(requireFirebaseAuth(), email.trim(), password);
      if (serverSessionAuth) await finishFirebaseSignIn(credential.user);
    } catch (error) {
      if (error instanceof FirebaseError && error.code === 'auth/multi-factor-auth-required') {
        mfaResolver.current = getMultiFactorResolver(requireFirebaseAuth(), error as MultiFactorError);
        setState({ phase: 'mfa-challenge', staff: null, error: null, notice: null });
        return;
      }
      setState({ phase: 'anonymous', staff: null, error: friendlyAuthError(error), notice: null });
    }
  }, [finishFirebaseSignIn]);

  const completeMfaChallenge = useCallback(async (code: string) => {
    const resolver = mfaResolver.current;
    const hint = resolver?.hints.find(candidate => candidate.factorId === TotpMultiFactorGenerator.FACTOR_ID);
    if (!resolver || !hint) throw new Error('No TOTP sign-in challenge is active.');
    setState(current => ({ ...current, error: null }));
    try {
      const assertion = TotpMultiFactorGenerator.assertionForSignIn(hint.uid, code.trim());
      const credential = await resolver.resolveSignIn(assertion);
      mfaResolver.current = null;
      if (serverSessionAuth) await finishFirebaseSignIn(credential.user);
    } catch (error) {
      setState(current => ({ ...current, error: friendlyAuthError(error) }));
      throw error;
    }
  }, [finishFirebaseSignIn]);

  const beginTotpEnrollment = useCallback(async () => {
    const user = requireFirebaseAuth().currentUser;
    if (!user) throw new Error('Sign in before enrolling an authenticator.');
    const session = await multiFactor(user).getSession();
    const secret = await TotpMultiFactorGenerator.generateSecret(session);
    totpSecret.current = secret;
    return { secretKey: secret.secretKey, qrCodeUrl: secret.generateQrCodeUrl(user.email || user.uid, 'Holistic Health Hub') };
  }, []);

  const completeTotpEnrollment = useCallback(async (code: string) => {
    const user = requireFirebaseAuth().currentUser;
    if (!user || !totpSecret.current) throw new Error('Start authenticator enrolment first.');
    const assertion = TotpMultiFactorGenerator.assertionForEnrollment(totpSecret.current, code.trim());
    await multiFactor(user).enroll(assertion, 'HHH staff authenticator');
    totpSecret.current = null;
    try {
      const idToken = await user.getIdToken(true);
      await notifyStaffMfaEnrolled(idToken);
    } catch {
      /* Enrolment succeeded even if the confirmation email could not be queued. */
    }
    await signOut(requireFirebaseAuth());
    setState({ phase: 'anonymous', staff: null, error: null, notice: 'Authenticator enrolled. Sign in again with your password and six-digit code.' });
  }, []);

  const resendVerification = useCallback(async () => {
    const user = requireFirebaseAuth().currentUser;
    if (!user) throw new Error('Sign in before requesting verification.');
    await sendEmailVerification(user);
  }, []);

  const refreshVerification = useCallback(async () => {
    const user = requireFirebaseAuth().currentUser;
    if (!user) throw new Error('Sign in before checking verification.');
    await reload(user);
    await user.getIdToken(true);
    await finishFirebaseSignIn(user);
  }, [finishFirebaseSignIn]);

  const sendPasswordReset = useCallback(async (email: string) => {
    if (isLocalPortalPreview) return;
    await requestStaffPasswordReset(email);
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    state, signIn: signInStaff, signOutStaff, continueSession, sendPasswordReset, resendVerification,
    refreshVerification, beginTotpEnrollment, completeTotpEnrollment, completeMfaChallenge,
  }), [beginTotpEnrollment, completeMfaChallenge, completeTotpEnrollment, continueSession, refreshVerification, resendVerification, sendPasswordReset, signInStaff, signOutStaff, state]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
