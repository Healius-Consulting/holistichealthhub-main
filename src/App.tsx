import { useEffect, useRef } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle, Info, X } from 'lucide-react';
import { ORGANISATIONS, AppProvider, useApp, type PharmacyTenant, type Screen, type StaffSession } from './context/AppContext';
import Header from './components/Header';
import Navigation from './components/Navigation';
import PharmacyOverview from './pages/PharmacyOverview';
import CreateOrder from './pages/CreateOrder';
import Orders from './pages/Orders';
import FormularyPricing from './pages/FormularyPricing';
import Patients from './pages/Patients';
import AdminPortal from './pages/AdminPortal';
import PharmacySettings from './pages/PharmacySettings';
import PharmacyFinance from './pages/PharmacyFinance';

import { tenantThemeVariables } from './utils/tenantTheme';
import { AuthProvider } from './auth/AuthProvider';
import { useAuth } from './auth/useAuth';
import {
  AuthLoading,
  ConfigurationRequired,
  EmailVerificationGate,
  MfaChallenge,
  MfaEnrollmentGate,
  PasswordResetScreen,
  StaffLogin,
} from './auth/AuthScreens';
import { getAdminOrganisations, getPortalSession } from './shared/api';
import { type PortalOrganisation } from './shared/contracts';
import { isLocalPortalPreview, withLocationSearch } from './dev/localPortalPreview';
import { resolvePharmacyWorkspaceMode } from './training/workspace';
import LocalPortalSwitcher from './dev/LocalPortalSwitcher';
import CommandPalette from './components/CommandPalette';
import WorkspaceTour from './components/WorkspaceTour';
import { appPathPrefix, isCurrentSurfacePath } from './auth/surface-path';
import { surfaceRelativePath, surfaceRoutePath } from './routing/surfaceRoute';

function toPharmacyTenant(record: PortalOrganisation): PharmacyTenant {
  return {
    id: record.id,
    slug: record.tradingName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    referralToken: record.referralToken ?? '',
    name: record.name,
    tradingName: record.tradingName,
    logoText: record.logoText,
    emailLogoUrl: record.emailLogoUrl ?? null,
    emailLogoStoragePath: record.emailLogoStoragePath ?? null,
    emailLogoWidth: record.emailLogoWidth ?? null,
    emailLogoHeight: record.emailLogoHeight ?? null,
    emailLogoUpdatedAt: record.emailLogoUpdatedAt ?? null,
    gphcNumber: record.gphcNumber,
    superintendent: record.superintendent,
    companyNumber: record.companyNumber,
    mainContactName: record.mainContactName,
    mainContactPhone: record.mainContactPhone,
    mainContactEmail: record.mainContactEmail,
    curaleafPharmacyCode: record.curaleafPharmacyCode,
    address: record.address,
    addressLine1: record.addressLine1,
    addressLine2: record.addressLine2,
    locality: record.locality,
    county: record.county,
    postcode: record.postcode,
    websiteDomains: record.websiteDomains ?? [],
    status: record.status,
    testAccount: record.testAccount,
    gdprExempt: record.gdprExempt,
    workspaceClassification: record.workspaceClassification,
    intakeEnabled: record.intakeEnabled,
    staffCount: 0,
    defaultPaymentRoute: record.defaultPaymentRoute ?? 'manual',
    pharmacyDeliveryEnabled: Boolean(record.pharmacyDeliveryEnabled),
    brand: { primary: record.primaryColour, portalName: record.portalName ?? record.name },
    worldpay: {
      enabled: record.defaultPaymentRoute === 'worldpay' || Boolean(record.worldpayEnabled),
      status: 'not-connected',
      environment: 'sandbox',
      merchantId: null,
      merchantName: null,
      lastSyncedAt: null,
    },
  };
}

const pharmacyScreens = new Set<Screen>(['home', 'create', 'orders', 'patients', 'formulary', 'finance', 'settings']);

function pharmacyScreenFromPath(): Screen {
  const segment = surfaceRelativePath(window.location.pathname, appPathPrefix)?.split('/').filter(Boolean)[0];
  return segment && pharmacyScreens.has(segment as Screen) ? segment as Screen : 'home';
}

function pharmacyPathForScreen(screen: Screen) {
  return surfaceRoutePath(screen === 'home' ? '/' : `/${screen}`, appPathPrefix);
}

function ToastItem({ toast }: { toast: { id: string; message: string; type: 'success' | 'info' | 'warning' | 'error' } }) {
  const { dispatch } = useApp();

  useEffect(() => {
    const timer = setTimeout(() => dispatch({ type: 'REMOVE_TOAST', id: toast.id }), 4000);
    return () => clearTimeout(timer);
  }, [toast.id, dispatch]);

  let Icon = Info;
  if (toast.type === 'success') Icon = CheckCircle;
  if (toast.type === 'warning') Icon = AlertTriangle;
  if (toast.type === 'error') Icon = AlertCircle;
  const colorClass = toast.type === 'success' ? 'text-green' : toast.type === 'warning' ? 'text-amber' : toast.type === 'error' ? 'text-red' : '';

  return (
    <div className={`toast toast-${toast.type}`} role="status">
      <div className={colorClass} style={{ display: 'flex', marginTop: 2 }}><Icon size={16} /></div>
      <div className="toast-content">{toast.message}</div>
      <button className="toast-close" aria-label="Dismiss notification" onClick={() => dispatch({ type: 'REMOVE_TOAST', id: toast.id })}><X size={14} /></button>
    </div>
  );
}

function ToastContainer() {
  const { state } = useApp();
  return <div className="toast-container" aria-live="polite">{state.toasts.map(toast => <ToastItem key={toast.id} toast={toast} />)}</div>;
}

function SessionExpiryNotice() {
  const { state, continueSession, signOutStaff } = useAuth();
  const stayButton = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { if (state.phase === 'authenticated' && state.sessionWarning) stayButton.current?.focus(); }, [state.phase, state.sessionWarning]);
  if (state.phase !== 'authenticated' || !state.sessionWarning) return null;
  return (
    <section className="session-expiry-notice" role="alertdialog" aria-labelledby="session-expiry-title" aria-describedby="session-expiry-description">
      <div>
        <strong id="session-expiry-title">Your secure session is about to lock</strong>
        <span id="session-expiry-description">Continue only if you are still actively using this pharmacy workspace.</span>
      </div>
      <button ref={stayButton} type="button" className="btn btn-primary btn-sm" onClick={() => void continueSession()}>Stay signed in</button>
      <button type="button" className="btn btn-sm" onClick={() => void signOutStaff()}>Sign out</button>
    </section>
  );
}

/** Keeps the legacy prototype store aligned with the authoritative Firebase session. */
function AuthSessionBridge() {
  const { state: authState, signOutStaff } = useAuth();
  const { state, dispatch } = useApp();
  const linkedSession = useRef(false);

  useEffect(() => {
    if (authState.phase === 'authenticated' && authState.staff) {
      const session: StaffSession = {
        email: authState.staff.email,
        name: authState.staff.name,
        role: authState.staff.role === 'hhh_admin' ? 'admin' : 'pharmacy',
        organisationId: authState.staff.organisationId,
      };
      if (!state.staffSession) {
        if (linkedSession.current && !isLocalPortalPreview) {
          void signOutStaff();
          return;
        }
        linkedSession.current = true;
        if (isLocalPortalPreview) dispatch({ type: 'SET_ORGANISATIONS', organisations: ORGANISATIONS });
        dispatch({ type: 'SIGN_IN_STAFF', session });
        return;
      }
      linkedSession.current = true;
      const hasChanged = state.staffSession.email !== session.email
        || state.staffSession.role !== session.role
        || state.staffSession.organisationId !== session.organisationId;
      if (hasChanged) dispatch({ type: 'SIGN_IN_STAFF', session });
      return;
    }

    if (authState.phase !== 'loading' && state.staffSession) dispatch({ type: 'SIGN_OUT_STAFF' });
    if (authState.phase === 'anonymous' || authState.phase === 'unconfigured') linkedSession.current = false;
  }, [authState.phase, authState.staff, dispatch, signOutStaff, state.staffSession]);

  useEffect(() => {
    if (authState.phase !== 'authenticated' || !authState.staff) return;
    if (isLocalPortalPreview) return;
    let cancelled = false;
    const loadOrganisations = authState.staff.role === 'hhh_admin'
      ? getAdminOrganisations().then(records => {
          if (!cancelled) dispatch({ type: 'SET_ORGANISATIONS', organisations: records.map(toPharmacyTenant) });
        })
      : getPortalSession().then(session => {
          if (!cancelled && session.organisation) {
            dispatch({ type: 'SET_ORGANISATIONS', organisations: [toPharmacyTenant(session.organisation)] });
          }
        });
    void loadOrganisations.catch(error => {
      if (!cancelled) dispatch({ type: 'ADD_TOAST', message: error instanceof Error ? error.message : 'Pharmacy profile could not be loaded.', toastType: 'error' });
    });
    return () => { cancelled = true; };
  }, [authState.phase, authState.staff?.email, authState.staff?.organisationId, authState.staff?.role, dispatch]);

  return null;
}

function StaffWorkspace() {
  const { state: authState } = useAuth();
  const { state, dispatch } = useApp();
  const organisation = state.portalMode === 'admin'
    ? undefined
    : state.organisations.find(org => org.id === state.currentOrganisationId);
  const tenantStyle = tenantThemeVariables(organisation?.brand.primary ?? '#0f766e') as React.CSSProperties;
  const workspaceMode = resolvePharmacyWorkspaceMode(organisation, {
    curaleafEstate: state.catalogueEnvironment,
    localPreview: isLocalPortalPreview,
  });
  const paused = organisation?.status === 'paused';
  const initialPathHandled = useRef(false);

  useEffect(() => {
    if (authState.staff?.role !== 'pharmacy_staff') return;
    const onPopState = () => dispatch({ type: 'SET_SCREEN', screen: pharmacyScreenFromPath() });
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [authState.staff?.role, dispatch]);

  useEffect(() => {
    if (authState.staff?.role !== 'pharmacy_staff') return;
    if (!initialPathHandled.current) {
      initialPathHandled.current = true;
      const requestedScreen = pharmacyScreenFromPath();
      if (requestedScreen !== state.screen) {
        dispatch({ type: 'SET_SCREEN', screen: requestedScreen });
        return;
      }
    }
    const path = pharmacyPathForScreen(state.screen);
    if (window.location.pathname !== path) window.history.pushState(null, '', withLocationSearch(path));
  }, [authState.staff?.role, dispatch, state.screen]);

  useEffect(() => {
    if (state.screen === 'patients') return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has('patient')) return;
    url.searchParams.delete('patient');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [state.screen]);

  useEffect(() => {
    if (authState.staff?.role !== 'pharmacy_staff' || !authState.staff.organisationId) return;
    dispatch({ type: 'SET_WORKSPACE_MODE', mode: workspaceMode, organisationId: authState.staff.organisationId });
  }, [authState.staff, dispatch, workspaceMode]);

  useEffect(() => {
    document.getElementById('pharmacy-main-content')?.scrollTo({ top: 0 });
  }, [state.screen]);

  if (!state.staffSession || !authState.staff) return <AuthLoading />;

  if (state.portalMode === 'admin') {
    if (authState.staff.role !== 'hhh_admin') return <StaffLogin />;
    return <><AdminPortal />{isLocalPortalPreview && <LocalPortalSwitcher />}<ToastContainer /></>;
  }

  if (!organisation) return <AuthLoading />;

  const renderScreen = () => {
    switch (state.screen) {
      case 'home': return <PharmacyOverview />;
      case 'formulary': return <FormularyPricing />;
      case 'create': return <CreateOrder />;
      case 'orders':
      case 'patients':
        // Keep both CRM boards mounted so "Open patient" / "Open order" can open the
        // other record via a portaled dialog without switching tabs or bouncing back.
        return (
          <>
            <div
              className={state.screen === 'orders' ? undefined : 'crm-screen-parked'}
              hidden={state.screen !== 'orders'}
              aria-hidden={state.screen !== 'orders'}
            >
              <Orders />
            </div>
            <div
              className={state.screen === 'patients' ? undefined : 'crm-screen-parked'}
              hidden={state.screen !== 'patients'}
              aria-hidden={state.screen !== 'patients'}
            >
              <Patients />
            </div>
          </>
        );
      case 'finance': return <PharmacyFinance />;
      case 'settings': return <PharmacySettings />;
      default: return <PharmacyOverview />;
    }
  };


  return (
    <div className="app-shell" style={tenantStyle}>
      <a className="skip-link" href="#pharmacy-main-content">Skip to main content</a>
      <Navigation />
      <div className="app-main">
        <Header />
        {state.workspaceMode === 'training' && (
          <div className="training-mode-banner" role="status">
            <strong>Training</strong>
            <span>
              {isLocalPortalPreview
                ? 'This workspace shows training examples only. Enquiries already go to HHH. Real referred patients appear after HHH opens Test or Live. Supplier writes and payments are not sent from training.'
                : 'Orders, supplier writes and payments stay locked until HHH opens this pharmacy as Test or Live. Enquiries and referred patients assigned to you are already visible.'}
            </span>
          </div>
        )}
        {state.workspaceMode === 'test' && !paused && (
          <div className="test-mode-banner" role="status">
            <strong>Test</strong>
            <span>This pharmacy is using Curaleaf and Worldpay sandbox keys. Patients, orders and payments are real for this workspace, against those sandboxes only. Live credentials under Manage → Curaleaf move it to Live.</span>
          </div>
        )}
        {paused && (
          <div className="paused-mode-banner" role="status">
            <strong>Paused</strong>
            <span>Intake is off and this pharmacy cannot run live orders until HHH unpauses it.</span>
          </div>
        )}
        <div id="pharmacy-main-content" className="page-container" tabIndex={-1}>{renderScreen()}</div>
      </div>
      <WorkspaceTour />
      {isLocalPortalPreview && <LocalPortalSwitcher />}
      <CommandPalette />
      <ToastContainer />
    </div>
  );
}

function AppContent() {
  const { state: authState } = useAuth();
  if (isCurrentSurfacePath('/reset-password')) return <PasswordResetScreen />;

  return (
    <>
      <AuthSessionBridge />
      <SessionExpiryNotice />
      {authState.phase === 'unconfigured' && <ConfigurationRequired />}
      {authState.phase === 'loading' && <AuthLoading />}
      {authState.phase === 'anonymous' && <StaffLogin />}
      {authState.phase === 'email-unverified' && <EmailVerificationGate />}
      {authState.phase === 'mfa-challenge' && <MfaChallenge />}
      {authState.phase === 'mfa-enrollment' && <MfaEnrollmentGate />}
      {authState.phase === 'error' && <StaffLogin />}
      {authState.phase === 'authenticated' && <StaffWorkspace />}
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppProvider>
        <AppContent />
      </AppProvider>
    </AuthProvider>
  );
}
