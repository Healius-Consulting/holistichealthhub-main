import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  ClipboardCheck,
  
  Download,
  ExternalLink,
  
  
  LayoutDashboard,
  
  
  LockKeyhole,
  Package,
  MailPlus,
  LogOut,
  
  Pencil,
  Plus,
  PhoneCall,
  PoundSterling,
  RefreshCw,
  Search,
  
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  Ghost,
  TrendingUp,
  
  UserPlus,
  UserCheck,
  UserX,
  Users,
  X,
} from 'lucide-react';
import {
  useApp,
  type PharmacyTenant,
} from '../context/AppContext';
import { DEFAULT_RETENTION_WINDOWS, inferRetention, type RetentionWindowSettings } from '../utils/commercial';
import { eligibilityUrl } from '../utils/pharmacyResources';
import { brandSwatchStyle, deriveTenantTheme } from '../utils/tenantTheme';
import { pharmacyLogoText } from '../utils/pharmacyFormErrors';
import { onboardingStatusLabel, onboardingStatusPillClass } from '../utils/onboardingStatus';
import { attributedCareLabel, attributedClosedNote, attributedCountForOrganisation, attributedInCare, attributedPatientCounts, attributedStagesForOrganisation, portfolioAttributedCount, splitAttributedRecords } from '../utils/attributedPatients';
import { formatUkDayDate } from '../utils/ukDates';
import { useAuth } from '../auth/useAuth';
import { type ActivatedPharmacyOnboarding, completeReferralRecordsCheck, createOrganisation, createPharmacyStaffInvitation, describeApiError, createPlatformAdminInvitation, getAdminGeneralIntake, getAdminPatientRegister, getAdminPharmacyReferralIntake, updateAdminPatientDetails, getAdminReferralFinance, getPharmacyStaff, getPlatformAdmins, getReferralLink, queueReferralPatientEmail, recordPatientRegisterExport, recordReferralDecision, assignPharmacyOwner, removePharmacyStaff, removePlatformAdmin, resendPharmacyStaffInvitation, resendPlatformAdminInvitation, resetPharmacyStaffMfa, updateAdminPatientConditions, updateEligibilityPharmacyReason } from '../shared/api';
import { isPlatformTestPharmacy, isTrainingDirectoryPharmacy, type AdminReferralFinanceReport, type DuplicateRecordMatch, type PatientRegisterExportResult, type PatientRegisterExportRow, type PharmacyStaffAccount, type PharmacyStaffInvitation, type PlatformAdminAccount, type PlatformAdminInvitation } from '../shared/contracts';
import { PharmacyRequestRecord, PharmacyRequestRow, usePharmacyRequests } from './admin/PharmacyRequests';
import { formatRequestDate } from './admin/requestFormat';
import { ActivationChecklist, DeclinePharmacyPanel, NotAvailablePanel, SuspendPharmacyPanel } from './admin/PharmacyActivation';
import { PharmacySummary } from './admin/PharmacySummary';
import { GoLiveChecklistCard } from './admin/GoLiveChecklistCard';
import { performancePeriodStart, type PerformancePeriod } from '../utils/performancePeriod';
import { PharmacyDetails } from './admin/PharmacyDetails';
import { LOCAL_PREVIEW_NEW_PHARMACIES } from '../dev/localPharmacyRequests';
import { ledgerDemoEvents } from '../dev/localAdminLedger';
import { isLocalPortalPreview, withLocationSearch } from '../dev/localPortalPreview';
import { useModalFocus } from '../accessibility/useModalFocus';
import WorkspaceNavigation, { type WorkspaceNavGroup } from '../components/WorkspaceNavigation';
import HhhBrandMark from '../components/HhhBrandMark';
import WorkspacePageHeader from '../components/WorkspacePageHeader';
import CommandPalette, { type CommandDefinition } from '../components/CommandPalette';
import CompactPatientCell from '../components/CompactPatientCell';
import { formatPatientDob } from '../utils/patientDob';
import { compactPatientName } from '../utils/patientName';
import ConditionList from '../components/ConditionList';
import ConditionEditor from '../components/ConditionEditor';
import { LEGACY_PHARMACY_DECISION_REASON, PHARMACY_REVIEWER_DISPLAY, isNegativeEligibilityStatus, pharmacyDecisionReason } from '../utils/eligibilityPresentation';
import { appPathPrefix } from '../auth/surface-path';
import { surfaceRelativePath, surfaceRoutePath } from '../routing/surfaceRoute';
import { ADMIN_REQUESTS_PATH, ADMIN_VIEW_PATHS, parseAdminRelativePath, type AdminView } from '@hhh/domain/portal-route';
import AdminIntakeV2 from '../components/AdminIntakeV2';
import { PatientDetailsForm } from './admin/PatientDetailsForm';
import { FeeChart } from './admin/FeeChart';
import { CopyFact, Fact, RecordCard, RecordSectionNav, useRecordSections, type RecordSection } from '../components/admin/RecordParts';
import CuraleafConnectionPanel from '../components/CuraleafConnectionPanel';

type OverviewManagePanel = 'summary' | 'identity' | 'staff' | 'curaleaf';
type AdminDialogFocus = 'list' | 'invite';

/** The patient record is one page; these are its sections, in order. */
const PATIENT_SECTIONS: RecordSection<'overview' | 'patient' | 'conditions' | 'fees' | 'orders'>[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'patient', label: 'Patient' },
  { id: 'conditions', label: 'Conditions' },
  { id: 'fees', label: 'Fees' },
  { id: 'orders', label: 'Orders' },
];

/** The pharmacy record is one page; these are its sections, in order. */
const PHARMACY_SECTIONS: { id: OverviewManagePanel; label: string }[] = [
  { id: 'summary', label: 'Overview' },
  { id: 'identity', label: 'Details' },
  { id: 'curaleaf', label: 'Curaleaf' },
  { id: 'staff', label: 'Staff' },
];

/**
 * Scroll the admin page so a pharmacy section starts just below the pinned
 * section bar. scrollIntoView ignores the bar, which left headings hidden under it.
 */
/** Fee totals for one pharmacy's events: first dispenses, anniversaries and earning patients. */
function summariseFeeEvents(events: AdminFeeEvent[]) {
  const position = { total: 0, firstAmount: 0, annualAmount: 0, firstCount: 0, annualCount: 0, patients: 0 };
  const patients = new Set<string>();
  for (const event of events) {
    position.total += event.amount;
    if (event.kind === 'new-referral') {
      position.firstAmount += event.amount;
      position.firstCount += 1;
    } else {
      position.annualAmount += event.amount;
      position.annualCount += 1;
    }
    patients.add(event.patientKey);
  }
  position.patients = patients.size;
  return position;
}

function scrollToPharmacySection(section: OverviewManagePanel, smooth: boolean) {
  const container = document.getElementById('admin-main-content');
  const target = document.getElementById(`pharmacy-section-${section}`);
  if (!container || !target) return;
  const barHeight = document.querySelector<HTMLElement>('.pharmacy-dashboard__nav')?.offsetHeight ?? 0;
  const offset = target.getBoundingClientRect().top - container.getBoundingClientRect().top - barHeight - 16;
  container.scrollTo({ top: container.scrollTop + offset, behavior: smooth ? 'smooth' : 'auto' });
}

const MFA_RESET_REASON = 'Administrator reset authenticator after confirming the staff member identity.';

function platformAdminStatusCopy(status: PlatformAdminAccount['status']) {
  if (status === 'active') return { label: 'Active', pill: 'pill-green' };
  if (status === 'invited') return { label: 'Invited', pill: 'pill-amber' };
  return { label: 'Disabled', pill: 'pill-red' };
}

function adminViewFromPath(): AdminView {
  const relativePath = surfaceRelativePath(window.location.pathname, appPathPrefix);
  const route = relativePath ? parseAdminRelativePath(relativePath) : null;
  return route?.kind === 'view' ? route.view : 'overview';
}

/** The old requests page path now opens the pharmacies overview on its Requests tab. */
function overviewFilterFromPath(): OverviewFilter {
  const relativePath = surfaceRelativePath(window.location.pathname, appPathPrefix);
  const route = relativePath ? parseAdminRelativePath(relativePath) : null;
  return route?.kind === 'view' && route.filter === 'requests' ? 'requests' : 'all';
}

type OverviewFilter = 'all' | 'registered' | 'training' | 'requests' | 'on_hold';

function adminPathForView(view: AdminView) {
  return surfaceRoutePath(ADMIN_VIEW_PATHS[view], appPathPrefix);
}

function organisationIdFromPath() {
  const relativePath = surfaceRelativePath(window.location.pathname, appPathPrefix);
  const route = relativePath ? parseAdminRelativePath(relativePath) : null;
  return route?.kind === 'organisation' ? route.organisationId : null;
}

function adminPathForOrganisation(organisationId: string) {
  return surfaceRoutePath(`/pharmacy/${encodeURIComponent(organisationId)}`, appPathPrefix);
}

type AdminFeeEvent = {
  id: string;
  kind: 'new-referral' | 'annual-patient';
  amount: number;
  occurredAt: Date;
  organisationId: string;
  pharmacyName: string;
  patientKey: string;
  patientName: string;
  patientEmail: string;
  anniversary: number | null;
};

const referralFeeFormatter = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
});

function toValidDate(value: Date | string | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function referralAnniversary(referralDate: Date, yearNumber: number) {
  const anniversary = new Date(referralDate);
  anniversary.setFullYear(referralDate.getFullYear() + yearNumber);
  return anniversary;
}

function referralFinanceDateRange(period: 'all' | 'month' | 'year', month: string, year: string) {
  if (period === 'month' && /^\d{4}-\d{2}$/.test(month)) {
    const [yearNumber, monthNumber] = month.split('-').map(Number);
    const finalDay = new Date(Date.UTC(yearNumber, monthNumber, 0)).getUTCDate();
    return { from: `${month}-01`, to: `${month}-${String(finalDay).padStart(2, '0')}` };
  }
  if (period === 'year' && /^\d{4}$/.test(year)) {
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  }
  return {};
}

function londonDateKey(value: Date | string | null) {
  const date = toValidDate(value);
  if (!date) return '';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function registerPatientKey(patient: { organisationId: string; email: string }) {
  return `${patient.organisationId}:${patient.email.trim().toLowerCase()}`;
}

/** One person can hold several rows — a patient record plus a withdrawn duplicate form — so rows are told apart by id, not email. */
function registerRowKey(row: { organisationId: string; id: string }) {
  return `${row.organisationId}:${row.id}`;
}

function worldpayStateLabel(state: PharmacyTenant['worldpayState']) {
  if (state === 'live') return 'Live';
  if (state === 'test') return 'Test';
  return 'Unconnected';
}

function worldpayStateTone(state: PharmacyTenant['worldpayState']) {
  if (state === 'live') return 'order-tone--paid';
  if (state === 'test') return 'order-tone--warning';
  return 'order-tone--neutral';
}

function stageTone(status: string) {
  if (status === 'Approved' || status === 'HHH approved') return 'paid';
  if (status === 'Declined' || status === 'Rejected' || status === 'Suspended') return 'danger';
  if (status === 'Under HHH review') return 'warning';
  if (status === 'Withdrawn') return 'neutral';
  return 'info';
}

/**
 * The register's stages, in the order the filter shows them. A fixed list: the
 * buttons used to be built from the rows on screen, so picking one stage made
 * every other stage's button vanish until "All" was pressed again.
 */
const REGISTER_STAGES = ['HHH approved', 'Referred', 'Suspended', 'Declined', 'Withdrawn'] as const;

function patientInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'P';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts.at(-1)![0]}`.toUpperCase();
}

function londonDayLabel(value: Date) {
  return value.toLocaleDateString('en-GB', { timeZone: 'Europe/London' });
}

function clinicRetention(
  orders: { organisationId: string; patientId: string | null; date: Date | string; payment: { status: string } }[],
  organisationId: string,
  patientId: string | null | undefined,
  settings: RetentionWindowSettings,
) {
  if (!patientId) return null;
  const dates = orders
    .filter(order => order.organisationId === organisationId && order.patientId === patientId && order.payment.status !== 'none' && order.payment.status !== 'cancelled')
    .map(order => (order.date instanceof Date ? order.date : new Date(order.date)).toISOString())
    .filter(value => Number.isFinite(Date.parse(value)))
    .sort();
  if (!dates[0]) return null;
  return inferRetention({ periodStart: dates[0], prescriptionDates: dates, asOf: new Date().toISOString(), settings });
}

function patientOrderActivity(
  orders: { organisationId: string; patientId: string | null; date: Date | string; payment: { status: string } }[],
  organisationId: string,
  patientId: string | null | undefined,
) {
  if (!patientId) return { count: 0, dates: [] as Date[] };
  const placed = orders.filter(order => (
    order.organisationId === organisationId
    && order.patientId === patientId
    && order.payment.status !== 'none'
    && order.payment.status !== 'cancelled'
  ));
  const dates = placed
    .map(order => (order.date instanceof Date ? order.date : new Date(order.date)))
    .filter(date => !Number.isNaN(date.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());
  const uniqueDays = [...new Set(dates.map(londonDayLabel))];
  return { count: placed.length, dates, uniqueDays };
}

function csvCell(value: unknown) {
  const raw = String(value ?? '');
  const text = /^[\t\r ]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
}

/** A request the server just activated, as the onboarding pharmacy the overview lists. */
function tenantFromActivation(organisation: ActivatedPharmacyOnboarding): PharmacyTenant {
  return {
    id: organisation.id,
    slug: slugify(organisation.name),
    referralToken: organisation.referralToken,
    name: organisation.name,
    tradingName: organisation.tradingName,
    logoText: organisation.logoText,
    gphcNumber: organisation.gphcNumber,
    superintendent: organisation.superintendent,
    mainContactName: organisation.mainContactName,
    mainContactPhone: organisation.mainContactPhone,
    mainContactEmail: organisation.mainContactEmail,
    pharmacyPhone: organisation.pharmacyPhone,
    pharmacyEmail: organisation.pharmacyEmail,
    address: organisation.address,
    websiteDomains: [],
    status: 'onboarding',
    staffCount: 0,
    defaultPaymentRoute: 'manual',
    pharmacyDeliveryEnabled: false,
    brand: { primary: organisation.primaryColour, portalName: organisation.name },
    worldpay: { enabled: false, status: 'not-connected', environment: 'sandbox', merchantId: null, merchantName: null, lastSyncedAt: null },
  };
}


function AdminHeader({ view, setView, pending = 0, freshIntake = 0, pharmacyRequests = 0, onViewAdmins }: { view: AdminView; setView: (view: AdminView) => void; pending?: number; freshIntake?: number; pharmacyRequests?: number; onViewAdmins: () => void }) {
  const { signOutStaff } = useAuth();
  const { state } = useApp();
  const staffName = state.staffSession?.name || 'HHH Administrator';
  const groups: WorkspaceNavGroup<AdminView>[] = [
    { label: 'Administration', items: [
      { key: 'overview', label: 'Overview', icon: <LayoutDashboard size={17} />, count: pharmacyRequests },
      { key: 'referrals', label: 'Patient intake', icon: <UserCheck size={17} />, count: pending, fresh: freshIntake },
      { key: 'patients', label: 'Patients', icon: <Users size={17} /> },
      { key: 'finance', label: 'Finance', icon: <PoundSterling size={17} /> },
    ] },
  ];
  return <WorkspaceNavigation
    ariaLabel="HHH administration"
    activeKey={view}
    groups={groups}
    mobilePrimaryKeys={['overview', 'referrals', 'patients', 'finance']}
    onNavigate={setView}
    brand={{ title: 'Holistic Health Hub', subtitle: 'Operations console', logo: <HhhBrandMark /> }}
    user={{ initials: staffName.split(' ').map(part => part[0]).join('').slice(0, 2).toUpperCase(), name: staffName, role: 'HHH administrator' }}
    footerAction={{ label: 'View admins', icon: <Users size={14} />, onClick: onViewAdmins }}
    exitAction={{ label: 'Sign out', icon: <LogOut size={14} />, onClick: () => void signOutStaff() }}
    moreTitle="More administration tools"
  />;
}

function OnboardPharmacy({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { dispatch } = useApp();
  const [name, setName] = useState('');
  const [tradingName, setTradingName] = useState('');
  const [gphcNumber, setGphcNumber] = useState('');
  const [superintendent, setSuperintendent] = useState('');
  const [companyNumber, setCompanyNumber] = useState('');
  const [mainContactName, setMainContactName] = useState('');
  const [mainContactPhone, setMainContactPhone] = useState('');
  const [mainContactEmail, setMainContactEmail] = useState('');
  const [pharmacyPhone, setPharmacyPhone] = useState('');
  const [pharmacyEmail, setPharmacyEmail] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [addressLine2, setAddressLine2] = useState('');
  const [addressLocality, setAddressLocality] = useState('');
  const [addressPostcode, setAddressPostcode] = useState('');
  const [domain, setDomain] = useState('');
  const [primary, setPrimary] = useState('#0f766e');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onboardingTheme = deriveTenantTheme(primary);
  const onboardingDialogRef = useModalFocus<HTMLElement>(true, onClose);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const slug = slugify(name);
    const logoText = pharmacyLogoText(name);
    const websiteDomains = domain ? [domain.replace(/^https?:\/\//, '').replace(/\/$/, '')] : [];
    const address = [addressLine1, addressLine2, addressLocality, addressPostcode.toUpperCase()].map(value => value.trim()).filter(Boolean).join(', ');
    try {
      const created = await createOrganisation({ name, tradingName, gphcNumber, superintendent, companyNumber, mainContactName, mainContactPhone, mainContactEmail, pharmacyPhone, pharmacyEmail, address, websiteDomains, primaryColour: primary, logoText, status: 'onboarding' });
      const organisation: PharmacyTenant = {
        id: created.id, slug, referralToken: created.referralToken, name, tradingName, logoText, gphcNumber, superintendent, companyNumber, mainContactName, mainContactPhone, mainContactEmail, pharmacyPhone, pharmacyEmail, address, websiteDomains,
        status: 'onboarding', staffCount: 0, defaultPaymentRoute: 'manual', pharmacyDeliveryEnabled: false,
        brand: { primary, portalName: name },
        worldpay: { enabled: false, status: 'not-connected', environment: 'sandbox', merchantId: null, merchantName: null, lastSyncedAt: null },
      };
      dispatch({ type: 'ADD_ORGANISATION', organisation });
      dispatch({ type: 'ADD_TOAST', message: `${name} onboarding record created in Firebase.`, toastType: 'success' });
      onCreated(created.id);
    } catch (cause) {
      setError(describeApiError(cause, 'The onboarding record could not be created.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drawer-backdrop admin-onboarding-backdrop" role="presentation">
      <aside ref={onboardingDialogRef} className="drawer admin-onboarding-drawer" role="dialog" aria-modal="true" aria-labelledby="onboard-title" tabIndex={-1}>
        <div className="drawer-header">
          <div>
            <p className="section-label">HHH operations</p>
            <h2 id="onboard-title">Onboard a pharmacy</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <form className="admin-onboard-form" onSubmit={submit}>
          <div className="drawer-body onboarding-form">
            <section className="admin-onboard-section">
              <div className="form-section-heading"><span>01</span><div><strong>Registered organisation</strong><small>Legal and GPhC identity used for compliance evidence.</small></div></div>
              <label>Registered pharmacy name<input className="input" value={name} onChange={event => setName(event.target.value)} required /></label>
              <label>Company name<input className="input" value={tradingName} onChange={event => setTradingName(event.target.value)} required /></label>
              <div className="form-grid-two"><label>GPhC number<input className="input" value={gphcNumber} onChange={event => setGphcNumber(event.target.value)} required /></label><label>Superintendent pharmacist<input className="input" value={superintendent} onChange={event => setSuperintendent(event.target.value)} required /></label></div>
              <label>Company registration number<input className="input" value={companyNumber} onChange={event => setCompanyNumber(event.target.value)} /><small>Optional. This sits on the linked company record, not the pharmacy premises row.</small></label>
            </section>

            <section className="admin-onboard-section">
              <div className="form-section-heading onboarding-address-heading"><span>02</span><div><strong>Registered address</strong><small>Stored in a consistent, matchable format for the public eligibility journey.</small></div></div>
              <div className="onboarding-address-grid">
                <label>Address line 1<input className="input" value={addressLine1} onChange={event => setAddressLine1(event.target.value)} autoComplete="address-line1" required /></label>
                <label>Address line 2<input className="input" value={addressLine2} onChange={event => setAddressLine2(event.target.value)} autoComplete="address-line2" /></label>
                <label>Town or city<input className="input" value={addressLocality} onChange={event => setAddressLocality(event.target.value)} autoComplete="address-level2" required /></label>
                <label>Postcode<input className="input" value={addressPostcode} onChange={event => setAddressPostcode(event.target.value.toUpperCase())} autoComplete="postal-code" required /></label>
              </div>
              <div className="form-grid-two"><label>Pharmacy landline<input className="input" type="tel" value={pharmacyPhone} onChange={event => setPharmacyPhone(event.target.value)} /></label><label>Pharmacy email<input className="input" type="email" value={pharmacyEmail} onChange={event => setPharmacyEmail(event.target.value)} /></label></div>
              <small>Shown to patients in emails and the pharmacy finder.</small>
              <div className="form-grid-two"><label>Superintendent contact name<input className="input" value={mainContactName} onChange={event => setMainContactName(event.target.value)} required /></label><label>Superintendent contact number<input className="input" type="tel" value={mainContactPhone} onChange={event => setMainContactPhone(event.target.value)} required /></label></div>
              <label>Superintendent contact email<input className="input" type="email" value={mainContactEmail} onChange={event => setMainContactEmail(event.target.value)} required /></label>
              <small>For HHH admin to reach the pharmacy. Never shown to patients.</small>
              <label>Approved website domain<input className="input" type="text" value={domain} onChange={event => setDomain(event.target.value)} placeholder="pharmacy.co.uk" /></label>
            </section>

            <section className="admin-onboard-section">
              <div className="form-section-heading"><span>03</span><div><strong>Pharmacy workspace colour</strong><small>Used only in that pharmacy’s staff portal. HHH admin keeps the Holistic Health Hub palette.</small></div></div>
              <div className="admin-workspace-preview">
                <div className="brand-colour-field">
                  <input type="color" value={primary} onChange={event => setPrimary(event.target.value)} aria-label="Pharmacy workspace primary colour" />
                  <div>
                    <strong>Primary brand colour</strong>
                    <small>{primary.toUpperCase()} · secondary generated for their workspace</small>
                  </div>
                  <div className="onboarding-palette" aria-hidden="true">
                    <i style={{ background: onboardingTheme.primary }} />
                    <i style={{ background: onboardingTheme.secondary }} />
                    <i style={{ background: onboardingTheme.primarySoft }} />
                  </div>
                </div>
                <div className="tenant-brand-preview" aria-hidden="true" style={{ borderTopColor: onboardingTheme.primary, background: onboardingTheme.surfaceTint }}>
                  <div className="tenant-mark" style={brandSwatchStyle(primary)}>{name.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase() || 'PH'}</div>
                  <span>
                    <strong>{name || 'Pharmacy workspace'}</strong>
                    <small>Staff portal and eligibility form</small>
                  </span>
                  <span className="brand-preview-button" style={{ background: onboardingTheme.primary, color: onboardingTheme.onPrimary }}>Primary action</span>
                  <span className="preview-secondary" style={{ background: onboardingTheme.secondary, color: onboardingTheme.onSecondary }}>Secondary</span>
                </div>
              </div>
            </section>

            <div className="onboarding-callout"><ShieldCheck size={17} /><span>The eligibility link is on from day one. The pharmacy workspace stays in training until HHH flips it live.</span></div>
            {error && <div className="banner banner-red" role="alert"><AlertCircle size={16} /> {error}</div>}
          </div>
          <div className="drawer-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}><Plus size={14} /> {busy ? 'Creating securely…' : 'Create onboarding record'}</button>
          </div>
        </form>
      </aside>
    </div>
  );
}

function PlatformAdminDialog({ onClose, focusInvite = false }: { onClose: () => void; focusInvite?: boolean }) {
  const { dispatch } = useApp();
  const { state: authState } = useAuth();
  const currentUid = authState.staff?.uid ?? null;
  const [admins, setAdmins] = useState<PlatformAdminAccount[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [invitation, setInvitation] = useState<PlatformAdminInvitation | null>(null);
  const [emailDelivery, setEmailDelivery] = useState<'sent' | 'failed' | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deletingUid, setDeletingUid] = useState<string | null>(null);
  const [resettingUid, setResettingUid] = useState<string | null>(null);
  const [resendingUid, setResendingUid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useModalFocus<HTMLElement>(true, onClose);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!focusInvite) return;
    const timer = window.setTimeout(() => nameInputRef.current?.focus(), 40);
    return () => window.clearTimeout(timer);
  }, [focusInvite]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    if (isLocalPortalPreview) {
      const records: PlatformAdminAccount[] = [
        { uid: 'preview-admin', email: 'admin@hhh.example', displayName: 'Jordan Lee', role: 'hhh_admin', status: 'active', createdAt: new Date().toISOString() },
        { uid: 'preview-admin-invited', email: 'alex.patel@hhh.example', displayName: 'Alex Patel', role: 'hhh_admin', status: 'invited', createdAt: new Date().toISOString() },
      ];
      setAdmins(records);
      setLoading(false);
      return;
    }
    void getPlatformAdmins()
      .then(records => { if (!cancelled) setAdmins(records); })
      .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Admin accounts could not be loaded.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setInvitation(null);
    setEmailDelivery(null);
    try {
      const created = isLocalPortalPreview
        ? { uid: `preview-admin-${Date.now()}`, displayName, email, role: 'hhh_admin' as const, status: 'invited' as const, createdAt: new Date().toISOString(), invitationQueued: true }
        : await createPlatformAdminInvitation({ displayName, email });

      const updated = [...admins, created];
      setAdmins(updated);
      setInvitation(created);
      setDisplayName('');
      setEmail('');
      try {
        if (isLocalPortalPreview) {
          setEmailDelivery('sent');
          dispatch({ type: 'ADD_TOAST', message: 'Local preview account created. No email was sent.', toastType: 'success' });
          return;
        }
        if (created.invitationQueued) {
          setEmailDelivery('sent');
          dispatch({ type: 'ADD_TOAST', message: 'Setup email queued.', toastType: 'success' });
        } else {
          setEmailDelivery('failed');
          dispatch({ type: 'ADD_TOAST', message: 'Account created. Retry the invitation email from this window.', toastType: 'warning' });
        }
      } catch {
        setEmailDelivery('failed');
        dispatch({ type: 'ADD_TOAST', message: 'Account created. Retry the invitation email from this window.', toastType: 'warning' });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The admin account could not be created.');
    } finally {
      setBusy(false);
    }
  };

  const resendAdminInvite = async (account: PlatformAdminAccount) => {
    setResendingUid(account.uid);
    setError(null);
    try {
      if (isLocalPortalPreview) {
        dispatch({ type: 'ADD_TOAST', message: `Setup email queued for ${account.email}.`, toastType: 'success' });
      } else {
        const result = await resendPlatformAdminInvitation(account.uid);
        dispatch(result.invitationQueued
          ? { type: 'ADD_TOAST', message: `Setup email queued for ${account.email}.`, toastType: 'success' }
          : { type: 'ADD_TOAST', message: 'That setup email is already waiting to send. Nothing new was queued.', toastType: 'warning' });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The setup email could not be queued.');
    } finally {
      setResendingUid(null);
    }
  };

  const removeAdmin = async (account: PlatformAdminAccount) => {
    if (account.uid === currentUid || !window.confirm(`Remove ${account.displayName}'s admin access? Their account history will be retained in the audit trail.`)) return;
    setDeletingUid(account.uid);
    setError(null);
    try {
      if (!isLocalPortalPreview) await removePlatformAdmin(account.uid);
      setAdmins(admins.filter(item => item.uid !== account.uid));
      dispatch({ type: 'ADD_TOAST', message: `${account.displayName}'s admin access was removed. Audit history was retained.`, toastType: 'success' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The admin account could not be removed.');
    } finally {
      setDeletingUid(null);
    }
  };

  const resetMfa = async (account: PlatformAdminAccount) => {
    if (account.status !== 'active' || !window.confirm(`Remove ${account.displayName}'s authenticator app? They will set it up again the next time they sign in.`)) return;
    setResettingUid(account.uid);
    setError(null);
    try {
      if (!isLocalPortalPreview) {
        await resetPharmacyStaffMfa(account.uid, { verifiedIdentity: true, reason: MFA_RESET_REASON });
      }
      dispatch({ type: 'ADD_TOAST', message: 'Authenticator removed. They will set it up again at next sign-in.', toastType: 'success' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The authenticator could not be removed.');
    } finally {
      setResettingUid(null);
    }
  };

  const activeAdmins = admins.filter(account => account.status === 'active');
  const invitedAdmins = admins.filter(account => account.status === 'invited');
  const disabledAdmins = admins.filter(account => account.status === 'disabled');

  const renderAdminRow = (account: PlatformAdminAccount) => {
    const isSelf = account.uid === currentUid;
    const isLastAdmin = admins.length <= 1;
    const statusCopy = platformAdminStatusCopy(account.status);
    return (
      <div className="admin-staff-row" key={account.uid}>
        <div className="staff-avatar">{account.displayName.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase()}</div>
        <div><strong>{account.displayName}{isSelf ? ' (you)' : ''}</strong><span>{account.email}</span></div>
        <span className={`pill ${statusCopy.pill}`}>{statusCopy.label}</span>
        <div className="admin-staff-row-actions">
          <button className="icon-btn" type="button" disabled={account.status !== 'invited' || resendingUid === account.uid} title={account.status === 'invited' ? 'Resend setup email' : 'Only pending invitations can be resent'} aria-label={`Resend setup email to ${account.displayName}`} onClick={() => void resendAdminInvite(account)}><MailPlus size={16} /></button>
          <button className="icon-btn" type="button" disabled={account.status !== 'active' || resettingUid === account.uid} title="Remove authenticator app" aria-label={`Remove authenticator for ${account.displayName}`} onClick={() => void resetMfa(account)}><ShieldOff size={16} /></button>
          <button className="icon-btn" type="button" disabled={isSelf || isLastAdmin || deletingUid === account.uid} title={isSelf ? 'You cannot remove your own access' : isLastAdmin ? 'At least one admin must remain' : 'Remove admin access'} aria-label={isSelf ? `${account.displayName} is your account` : `Remove ${account.displayName}`} onClick={() => void removeAdmin(account)}><UserX size={16} /></button>
        </div>
      </div>
    );
  };

  return (
    <div className="drawer-backdrop admin-onboarding-backdrop" role="presentation">
      <aside ref={dialogRef} className="drawer admin-onboarding-drawer admin-admins-drawer" role="dialog" aria-modal="true" aria-labelledby="admins-dialog-title" tabIndex={-1}>
        <div className="drawer-header">
          <div>
            <p className="section-label">Platform access</p>
            <h2 id="admins-dialog-title">HHH administrators</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close administrators"><X size={18} /></button>
        </div>
        <div className="drawer-body onboarding-form admin-admins-drawer__body">
          <p>Invite colleagues who need full admin portal access. Admin accounts are separate from pharmacy staff and are not tied to a pharmacy organisation.</p>
          <form className="admin-staff-invite-form" onSubmit={invite}>
            <label htmlFor="admin-invite-name">Admin name<input id="admin-invite-name" ref={nameInputRef} className="input" value={displayName} onChange={event => setDisplayName(event.target.value)} autoComplete="off" required /></label>
            <label htmlFor="admin-invite-email">Work email address<input id="admin-invite-email" className="input" type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="off" required /></label>
            <button className="btn btn-primary" type="submit" disabled={busy}><UserPlus size={14} /> {busy ? 'Creating account…' : 'Invite admin'}</button>
          </form>
          {error && <div className="banner banner-red" role="alert"><AlertCircle size={16} /> {error}</div>}
          {invitation && <div className="staff-invitation-result"><ShieldCheck size={17} /><div><strong>Admin account created · {emailDelivery === 'sent' ? 'Setup email queued' : emailDelivery === 'failed' ? 'Email not queued' : 'Preparing email'}</strong><span>{emailDelivery === 'sent' ? 'A password setup email has been queued. They will choose a password and set up two-factor authentication before entering the admin portal.' : 'A setup email could not be queued. Retry the invitation from this window. The setup link is not shown in the browser.'}</span></div></div>}
          <div className="admin-admins-groups">
            {loading ? (
              <div className="empty-state">Loading admin accounts…</div>
            ) : (
              <>
                <section className="admin-admins-group" aria-labelledby="admins-active-heading">
                  <header>
                    <h3 id="admins-active-heading">Active</h3>
                    <span className="pill pill-green">{activeAdmins.length}</span>
                  </header>
                  {activeAdmins.length === 0 ? <p className="admin-admins-group__empty">No active administrators.</p> : activeAdmins.map(renderAdminRow)}
                </section>
                <section className="admin-admins-group" aria-labelledby="admins-invited-heading">
                  <header>
                    <h3 id="admins-invited-heading">Invited</h3>
                    <span className="pill pill-amber">{invitedAdmins.length}</span>
                  </header>
                  {invitedAdmins.length === 0 ? <p className="admin-admins-group__empty">No outstanding invitations.</p> : invitedAdmins.map(renderAdminRow)}
                </section>
                {disabledAdmins.length > 0 ? (
                  <section className="admin-admins-group" aria-labelledby="admins-disabled-heading">
                    <header>
                      <h3 id="admins-disabled-heading">Disabled</h3>
                      <span className="pill pill-red">{disabledAdmins.length}</span>
                    </header>
                    {disabledAdmins.map(renderAdminRow)}
                  </section>
                ) : null}
              </>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

function PharmacyStaffManager({ organisation, onCountChange }: { organisation: PharmacyTenant; onCountChange: (count: number) => void }) {
  const { dispatch } = useApp();
  const [staff, setStaff] = useState<PharmacyStaffAccount[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [invitation, setInvitation] = useState<PharmacyStaffInvitation | null>(null);
  const [emailDelivery, setEmailDelivery] = useState<'sent' | 'failed' | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deletingUid, setDeletingUid] = useState<string | null>(null);
  const [resettingUid, setResettingUid] = useState<string | null>(null);
  const [resendingUid, setResendingUid] = useState<string | null>(null);
  const [assigningUid, setAssigningUid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    if (isLocalPortalPreview) {
      const records: PharmacyStaffAccount[] = [
        { uid: `${organisation.id}-owner`, email: 'owner@pharmacy.example', displayName: 'Alex Morgan', role: 'pharmacy_staff', pharmacyId: organisation.id, organisationId: organisation.id, contactRole: 'owner', status: 'active', createdAt: new Date().toISOString() },
        { uid: `${organisation.id}-staff`, email: 'staff@pharmacy.example', displayName: 'Sam Reed', role: 'pharmacy_staff', pharmacyId: organisation.id, organisationId: organisation.id, contactRole: 'staff', status: 'active', createdAt: new Date().toISOString() },
      ];
      setStaff(records);
      onCountChange(records.length);
      setLoading(false);
      return;
    }
    void getPharmacyStaff(organisation.id)
      .then(records => {
        if (cancelled) return;
        setStaff(records);
        onCountChange(records.length);
      })
      .catch(cause => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Staff accounts could not be loaded.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [organisation.id, onCountChange]);

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setInvitation(null);
    setEmailDelivery(null);
    try {
      const created = isLocalPortalPreview
        ? { uid: `preview-${Date.now()}`, pharmacyId: organisation.id, organisationId: organisation.id, displayName, email, role: 'pharmacy_staff' as const, contactRole: staff.length ? 'staff' as const : 'owner' as const, status: 'invited' as const, createdAt: new Date().toISOString(), invitationQueued: true }
        : await createPharmacyStaffInvitation({ pharmacyId: organisation.id, organisationId: organisation.id, displayName, email });

      const updated = [...staff, created];
      setStaff(updated);
      setInvitation(created);
      setDisplayName('');
      setEmail('');
      onCountChange(updated.length);
      try {
        if (isLocalPortalPreview) {
          setEmailDelivery('sent');
          dispatch({ type: 'ADD_TOAST', message: 'Local preview account created. No email was sent.', toastType: 'success' });
          return;
        }
        if (created.invitationQueued) {
          setEmailDelivery('sent');
          dispatch({ type: 'ADD_TOAST', message: 'Setup email queued.', toastType: 'success' });
        } else {
          setEmailDelivery('failed');
          dispatch({ type: 'ADD_TOAST', message: 'Account created. Retry the invitation email from this screen.', toastType: 'warning' });
        }
      } catch {
        setEmailDelivery('failed');
        dispatch({ type: 'ADD_TOAST', message: 'Account created. Retry the invitation email from this screen.', toastType: 'warning' });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The staff account could not be created.');
    } finally {
      setBusy(false);
    }
  };

  const resendStaffInvite = async (account: PharmacyStaffAccount) => {
    setResendingUid(account.uid);
    setError(null);
    try {
      if (isLocalPortalPreview) {
        dispatch({ type: 'ADD_TOAST', message: `Setup email queued for ${account.email}.`, toastType: 'success' });
      } else {
        const result = await resendPharmacyStaffInvitation(account.uid);
        dispatch(result.invitationQueued
          ? { type: 'ADD_TOAST', message: `Setup email queued for ${account.email}.`, toastType: 'success' }
          : { type: 'ADD_TOAST', message: 'That setup email is already waiting to send. Nothing new was queued.', toastType: 'warning' });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The setup email could not be queued.');
    } finally {
      setResendingUid(null);
    }
  };

  const removeStaff = async (account: PharmacyStaffAccount) => {
    if (account.contactRole === 'owner' || !window.confirm(`Remove ${account.displayName}'s access? Their account history will be retained in the audit trail.`)) return;
    setDeletingUid(account.uid);
    setError(null);
    try {
      if (!isLocalPortalPreview) await removePharmacyStaff(account.uid);
      const updated = staff.filter(item => item.uid !== account.uid);
      setStaff(updated);
      onCountChange(updated.length);
      dispatch({ type: 'ADD_TOAST', message: `${account.displayName}'s access was removed. Audit history was retained.`, toastType: 'success' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The staff account could not be removed.');
    } finally {
      setDeletingUid(null);
    }
  };

  const assignOwner = async (account: PharmacyStaffAccount) => {
    if (account.contactRole === 'owner' || account.status === 'disabled') return;
    if (!window.confirm(`Make ${account.displayName} the owner contact for this pharmacy? The previous owner stays as staff and can then be removed.`)) return;
    setAssigningUid(account.uid);
    setError(null);
    try {
      const updated = isLocalPortalPreview
        ? staff.map(item => ({ ...item, contactRole: item.uid === account.uid ? 'owner' as const : 'staff' as const }))
        : await assignPharmacyOwner(account.uid);
      setStaff(updated);
      dispatch({ type: 'ADD_TOAST', message: `${account.displayName} is now the owner contact.`, toastType: 'success' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The owner contact could not be changed.');
    } finally {
      setAssigningUid(null);
    }
  };

  const resetMfa = async (account: PharmacyStaffAccount) => {
    if (account.status === 'disabled' || !window.confirm(`Remove ${account.displayName}'s authenticator app? They will set it up again the next time they sign in.`)) return;
    setResettingUid(account.uid);
    setError(null);
    try {
      if (!isLocalPortalPreview) {
        await resetPharmacyStaffMfa(account.uid, { verifiedIdentity: true, reason: MFA_RESET_REASON });
      }
      dispatch({ type: 'ADD_TOAST', message: 'Authenticator removed. They will set it up again at next sign-in.', toastType: 'success' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The authenticator could not be removed.');
    } finally {
      setResettingUid(null);
    }
  };

  return (
    <section className="pharmacy-details__card admin-staff-card" aria-labelledby="pharmacy-staff-title">
      <header>
        <span className="pharmacy-details__icon" aria-hidden="true"><Users size={16} /></span>
        <h4 id="pharmacy-staff-title">Staff accounts</h4>
        <span className="pharmacy-details__tag">{staff.length} account{staff.length === 1 ? '' : 's'}</span>
      </header>
      <p className="pharmacy-details__note">Add the people who sign in to this pharmacy's workspace. Owner marks the main contact only; it adds no extra permissions.</p>
      <form className="admin-staff-invite-form" onSubmit={invite}>
        <label>Staff member name<input className="input" value={displayName} onChange={event => setDisplayName(event.target.value)} autoComplete="off" required /></label>
        <label>Work email address<input className="input" type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="off" required /></label>
        <button className="btn btn-primary" type="submit" disabled={busy}><UserPlus size={14} /> {busy ? 'Creating account…' : 'Add staff account'}</button>
      </form>
      {error && <div className="banner banner-red" role="alert"><AlertCircle size={16} /> {error}</div>}
      {invitation && <div className="staff-invitation-result"><ShieldCheck size={17} /><div><strong>{invitation.contactRole === 'owner' ? 'Owner account created' : 'Staff account created'} · {emailDelivery === 'sent' ? 'Setup email queued' : emailDelivery === 'failed' ? 'Email not queued' : 'Preparing email'}</strong><span>{emailDelivery === 'sent' ? 'A password setup email has been queued. They will choose a password and set up two-factor authentication before entering the pharmacy workspace.' : 'A setup email could not be queued. Retry the invitation from this screen. The setup link is not shown in the browser.'}</span></div></div>}
      <div className="admin-staff-list">
        {loading && <div className="empty-state">Loading staff accounts…</div>}
        {!loading && staff.length === 0 && <div className="empty-state">No pharmacy staff accounts yet. The first person added will be tagged Owner. You can assign a different owner later.</div>}
        {staff.map(account => (
          <div className="admin-staff-row" key={account.uid}>
            <div className="staff-avatar">{account.displayName.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase()}</div>
            <div><strong>{account.displayName}</strong><span>{account.email}</span></div>
            <span className={`pill ${account.contactRole === 'owner' ? 'pill-info' : 'pill-neutral'}`}>{account.contactRole === 'owner' ? 'Owner' : 'Staff'}</span>
            <span className={`pill ${account.status === 'active' ? 'pill-green' : account.status === 'disabled' ? 'pill-red' : 'pill-amber'}`}>{account.status}</span>
            <div className="admin-staff-row-actions">
              {account.contactRole !== 'owner' ? (
                <button
                  className="btn btn-sm btn-secondary"
                  type="button"
                  disabled={account.status === 'disabled' || assigningUid === account.uid}
                  onClick={() => void assignOwner(account)}
                >
                  {assigningUid === account.uid ? 'Assigning…' : 'Assign as owner'}
                </button>
              ) : null}
              <button className="icon-btn" type="button" disabled={account.status !== 'invited' || resendingUid === account.uid} title={account.status === 'invited' ? 'Resend setup email' : 'Only pending invitations can be resent'} aria-label={`Resend setup email to ${account.displayName}`} onClick={() => void resendStaffInvite(account)}><MailPlus size={16} /></button>
              <button className="icon-btn" type="button" disabled={account.status === 'disabled' || resettingUid === account.uid} title="Remove authenticator app" aria-label={`Remove authenticator for ${account.displayName}`} onClick={() => void resetMfa(account)}><ShieldOff size={16} /></button>
              <button className="icon-btn" type="button" disabled={account.contactRole === 'owner' || deletingUid === account.uid} title={account.contactRole === 'owner' ? 'Owner account is protected' : 'Remove staff access'} aria-label={account.contactRole === 'owner' ? `${account.displayName} is the protected owner account` : `Remove ${account.displayName}`} onClick={() => void removeStaff(account)}><UserX size={16} /></button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export default function AdminPortal() {
  const { state, dispatch } = useApp();
  const [view, setView] = useState<AdminView>(adminViewFromPath);
  const [query, setQuery] = useState('');
  const [patientOrganisationId, setPatientOrganisationId] = useState('all');
  const [patientStatus, setPatientStatus] = useState('all');
  const [retentionWindows, setRetentionWindows] = useState<RetentionWindowSettings>(() => {
    try {
      const stored = localStorage.getItem('hhh.retention.windows');
      return stored ? { ...DEFAULT_RETENTION_WINDOWS, ...JSON.parse(stored) } : DEFAULT_RETENTION_WINDOWS;
    } catch {
      return DEFAULT_RETENTION_WINDOWS;
    }
  });
  const [patientFrom, setPatientFrom] = useState('');
  // Hidden by default: day to day the register is about real patients, and
  // showing the test accounts' records is the explicit choice.
  const [hideTestPatients, setHideTestPatients] = useState(true);
  const [patientTo, setPatientTo] = useState('');
  const [patientExportBusy, setPatientExportBusy] = useState(false);
  const [patientExportError, setPatientExportError] = useState<string | null>(null);
  const [serverPatientRegister, setServerPatientRegister] = useState<PatientRegisterExportResult | null>(null);
  const [patientRegisterLoading, setPatientRegisterLoading] = useState(false);
  const [overviewAttribution, setOverviewAttribution] = useState<ReturnType<typeof attributedPatientCounts> | null>(null);
  const [overviewAttributionStatus, setOverviewAttributionStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  // Performance on the pharmacy record: 1M / 3M re-ask the register for that pharmacy from the cutoff.
  const [performancePeriod, setPerformancePeriod] = useState<PerformancePeriod>('all');
  const [periodAttribution, setPeriodAttribution] = useState<{ key: string; counts: ReturnType<typeof attributedPatientCounts> | null; status: 'loading' | 'ready' | 'error' } | null>(null);
  const [openIntakeCount, setOpenIntakeCount] = useState<number | null>(null);
  const [openIntakeStatus, setOpenIntakeStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [selectedRegisterPatient, setSelectedRegisterPatient] = useState<PatientRegisterExportRow | null>(null);
  const selectedRegisterKey = selectedRegisterPatient ? registerRowKey(selectedRegisterPatient) : null;
  useEffect(() => { setEditingPatientDetails(false); }, [selectedRegisterKey]);
  const { activeSection: patientSection, goToSection: goToPatientSection } = useRecordSections(PATIENT_SECTIONS, {
    prefix: 'patient-section',
    navSelector: '.admin-patient-nav',
    enabled: view === 'patients' && Boolean(selectedRegisterPatient),
    resetKey: selectedRegisterPatient ? registerRowKey(selectedRegisterPatient) : null,
  });
  const [editingAdminConditions, setEditingAdminConditions] = useState(false);
  const [editingPatientDetails, setEditingPatientDetails] = useState(false);
  const [patientFiltersOpen, setPatientFiltersOpen] = useState(false);
  // Each admin page renders its headline figures into the page header through this slot.
  const [headerSummary, setHeaderSummary] = useState<HTMLDivElement | null>(null);
  // New enquiries no HHH admin has opened: the pulsing dot on Patient intake.
  const [freshIntakeCount, setFreshIntakeCount] = useState(isLocalPortalPreview ? 1 : 0);
  useEffect(() => {
    if (isLocalPortalPreview) return;
    let cancelled = false;
    void Promise.all([getAdminGeneralIntake(), getAdminPharmacyReferralIntake()])
      .then(([general, referrals]) => {
        if (!cancelled) setFreshIntakeCount([...general.records, ...referrals.records].filter(record => record.hhhOpened === false).length);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [view]);
  const [registerEdits, setRegisterEdits] = useState<Record<string, Partial<PatientRegisterExportRow>>>({});
  const [savingAdminConditions, setSavingAdminConditions] = useState(false);
  const [adminConditionError, setAdminConditionError] = useState<string | null>(null);

  const saveAdminConditions = async (
    patientId: string,
    organisationId: string,
    conditionCodes: string[],
    primaryConditionCode: string,
  ) => {
    setSavingAdminConditions(true);
    setAdminConditionError(null);
    try {
      const result = await updateAdminPatientConditions(patientId, { organisationId, conditionCodes, primaryConditionCode });
      dispatch({
        type: 'SET_PATIENT_CONDITIONS',
        patientId,
        conditions: result.conditions.map(item => item.conditionCode),
        primaryCondition: result.primaryConditionCode,
      });
      dispatch({ type: 'ADD_TOAST', message: 'Patient conditions updated.', toastType: 'success', dedupeKey: 'patient-conditions' });
      setEditingAdminConditions(false);
    } catch (error) {
      setAdminConditionError(error instanceof Error ? error.message : 'The conditions could not be saved.');
    } finally {
      setSavingAdminConditions(false);
    }
  };
  const [pendingRegisterKey, setPendingRegisterKey] = useState<string | null>(null);
  const [referralLink, setReferralLink] = useState('');
  const [referralLinkLoading, setReferralLinkLoading] = useState(false);
  const [referralLinkError, setReferralLinkError] = useState<string | null>(null);
  const [referralLinkRefresh, setReferralLinkRefresh] = useState(0);
  const [overviewPharmacyId, setOverviewPharmacyId] = useState<string | null>(organisationIdFromPath);
  const [overviewManagePanel, setOverviewManagePanel] = useState<OverviewManagePanel>('summary');
  const [overviewManageOpen, setOverviewManageOpen] = useState(false);
  const [overviewFilter, setOverviewFilter] = useState<OverviewFilter>(overviewFilterFromPath);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [notAvailableOpen, setNotAvailableOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<OverviewManagePanel>('summary');
  // The section a click is scrolling to: the highlight follows the scroll, then settles here.
  const pendingSectionRef = useRef<OverviewManagePanel | null>(null);
  const pharmacyRequests = usePharmacyRequests(true);
  // Local preview only: show two new pharmacies waiting on Curaleaf next to the demo ones.
  useEffect(() => {
    if (!isLocalPortalPreview || !state.organisations.length) return;
    for (const organisation of LOCAL_PREVIEW_NEW_PHARMACIES) {
      if (!state.organisations.some(existing => existing.id === organisation.id)) dispatch({ type: 'ADD_ORGANISATION', organisation });
    }
  }, [dispatch, state.organisations]);
  const overviewManageRef = useRef<HTMLDivElement>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

  const [showAdminDialog, setShowAdminDialog] = useState(false);
  const [adminDialogFocus, setAdminDialogFocus] = useState<AdminDialogFocus>('list');
  const [financeOrganisationId, setFinanceOrganisationId] = useState('all');
  const [financePatientKey, setFinancePatientKey] = useState('all');
  const [financePeriod, setFinancePeriod] = useState<'all' | 'month' | 'year'>('all');
  const [financeMonth, setFinanceMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const [financeYear, setFinanceYear] = useState(() => String(new Date().getFullYear()));
  const [adminFinanceReport, setAdminFinanceReport] = useState<AdminReferralFinanceReport | null>(null);
  const [adminFinanceLoading, setAdminFinanceLoading] = useState(false);
  const [adminFinanceError, setAdminFinanceError] = useState<string | null>(null);
  const [adminFinanceRefresh, setAdminFinanceRefresh] = useState(0);
  const [referralDialog, setReferralDialog] = useState<{ id: string | number; organisationId: string; patientName: string; action: 'records' | 'complete' | 'decline' | 'email' | 'reason' } | null>(null);
  const [referralNotes, setReferralNotes] = useState('');
  const [referralPharmacyReason, setReferralPharmacyReason] = useState('');
  const [referralBusy, setReferralBusy] = useState(false);
  const [referralError, setReferralError] = useState<string | null>(null);

  const overviewPharmacy = state.organisations.find(org => org.id === overviewPharmacyId) ?? null;

  useEffect(() => {
    let cancelled = false;
    if (!overviewPharmacy) {
      setReferralLink('');
      setReferralLinkError(null);
      setReferralLinkLoading(false);
      return;
    }
    setReferralLink('');
    setReferralLinkError(null);
    setReferralLinkLoading(true);
    const request = isLocalPortalPreview
      ? Promise.resolve({ url: eligibilityUrl(overviewPharmacy.referralToken) })
      : getReferralLink(overviewPharmacy.id);
    void request
      .then(result => { if (!cancelled) setReferralLink(result.url); })
      .catch(error => { if (!cancelled) setReferralLinkError(error instanceof Error ? error.message : 'The eligibility link could not be loaded.'); })
      .finally(() => { if (!cancelled) setReferralLinkLoading(false); });
    return () => { cancelled = true; };
  }, [overviewPharmacy?.id, overviewPharmacy?.referralToken, referralLinkRefresh]);

  const runReferralAction = async (redactPharmacyReason = false) => {
    if (!referralDialog) return;
    const submission = state.submissions.find(item => item.id === referralDialog.id);
    if (!submission) return;
    setReferralBusy(true);
    setReferralError(null);
    const now = new Date();
    const actor = state.staffSession?.name ?? 'HHH administrator';
    try {
      if (!isLocalPortalPreview) {
        if (referralDialog.action === 'records') {
          await completeReferralRecordsCheck(String(referralDialog.id), { organisationId: referralDialog.organisationId, notes: referralNotes.trim() });
        } else if (referralDialog.action === 'email') {
          await queueReferralPatientEmail(String(referralDialog.id), referralDialog.organisationId);
        } else if (referralDialog.action === 'reason') {
          await updateEligibilityPharmacyReason(String(referralDialog.id), {
            organisationId: referralDialog.organisationId,
            pharmacyDecisionReason: redactPharmacyReason ? null : referralPharmacyReason.trim(),
          });
        } else {
          await recordReferralDecision(String(referralDialog.id), referralDialog.action === 'complete'
            ? { organisationId: referralDialog.organisationId, decision: 'completed', notes: referralNotes.trim() || null }
            : { organisationId: referralDialog.organisationId, decision: 'declined', notes: referralNotes.trim() || null, pharmacyDecisionReason: referralPharmacyReason.trim() });
        }
      }

      if (referralDialog.action === 'records') {
        dispatch({ type: 'UPDATE_SUBMISSION', subId: submission.id, updates: {
          status: 'Under HHH review',
          calls: [...submission.calls, { ts: now }],
          recordsCheck: { status: 'completed', notes: referralNotes.trim(), completedAt: now, completedBy: actor },
        } });
      } else if (referralDialog.action === 'complete') {
        dispatch({ type: 'UPDATE_SUBMISSION', subId: submission.id, updates: {
          status: 'Approved',
          reviewedAt: now,
          reviewedBy: actor,
          reviewerDisplay: PHARMACY_REVIEWER_DISPLAY,
          decisionNote: referralNotes.trim() || 'Referral completed.',
          pharmacyDecisionReason: null,
          pharmacyDecisionReasonNeedsReview: false,
          referral: { status: 'completed', notes: referralNotes.trim() || null, completedAt: now, completedBy: actor },
        } });
      } else if (referralDialog.action === 'decline') {
        dispatch({ type: 'UPDATE_SUBMISSION', subId: submission.id, updates: {
          status: 'Declined',
          reviewedAt: now,
          reviewedBy: actor,
          reviewerDisplay: PHARMACY_REVIEWER_DISPLAY,
          decisionNote: referralNotes.trim() || 'Referral declined.',
          pharmacyDecisionReason: referralPharmacyReason.trim(),
          pharmacyDecisionReasonNeedsReview: false,
          referral: { status: 'declined', notes: referralNotes.trim() || null, completedAt: now, completedBy: actor },
        } });
      } else if (referralDialog.action === 'reason') {
        dispatch({ type: 'UPDATE_SUBMISSION', subId: submission.id, updates: {
          pharmacyDecisionReason: redactPharmacyReason ? null : referralPharmacyReason.trim(),
          pharmacyDecisionReasonNeedsReview: redactPharmacyReason,
        } });
      } else {
        dispatch({ type: 'UPDATE_SUBMISSION', subId: submission.id, updates: {
          emailDelivery: { status: 'queued', queuedAt: now, sentAt: null, failedAt: null },
        } });
      }
      dispatch({ type: 'ADD_TOAST', message: referralDialog.action === 'records' ? 'Call and records check saved.' : referralDialog.action === 'email' ? 'Patient email queued separately.' : referralDialog.action === 'complete' ? 'Referral completed. The £50 event starts at the patient’s first collected dispense.' : referralDialog.action === 'reason' ? redactPharmacyReason ? 'Pharmacy reason redacted to the approved fallback.' : 'Pharmacy-facing reason updated.' : 'Referral declined.', toastType: referralDialog.action === 'decline' || redactPharmacyReason ? 'warning' : 'success' });
      setReferralDialog(null);
      setReferralNotes('');
      setReferralPharmacyReason('');
    } catch (error) {
      setReferralError(error instanceof Error ? error.message : 'The referral action could not be saved.');
    } finally {
      setReferralBusy(false);
    }
  };
  const updateSelectedStaffCount = useCallback((count: number) => {
    if (overviewPharmacyId) dispatch({ type: 'UPDATE_ORGANISATION', organisationId: overviewPharmacyId, updates: { staffCount: count } });
  }, [dispatch, overviewPharmacyId]);

  const openPharmacyOnOverview = useCallback((organisationId: string, panel: OverviewManagePanel = 'summary') => {
    setView('overview');
    setOverviewPharmacyId(organisationId);
    setOverviewManagePanel(panel);
    setOverviewManageOpen(false);
    setOverviewFilter('all');
    setQuery('');
  }, []);

  useEffect(() => {
    document.getElementById('admin-main-content')?.scrollTo({ top: 0 });
  }, [view, overviewPharmacyId, overviewManagePanel]);

  useEffect(() => {
    const onPopState = () => {
      const organisationId = organisationIdFromPath();
      setView(adminViewFromPath());
      if (overviewFilterFromPath() === 'requests') setOverviewFilter('requests');
      if (organisationId) {
        setOverviewPharmacyId(organisationId);
        setOverviewManagePanel('summary');
        setOverviewManageOpen(false);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const path = view === 'overview' && overviewFilter === 'requests'
      ? surfaceRoutePath(ADMIN_REQUESTS_PATH, appPathPrefix)
      // A request on screen has no pharmacy link yet; keeping the last pharmacy's would reopen the wrong record.
      : view === 'overview' && selectedRequestId
        ? adminPathForView('overview')
        : view === 'overview' && overviewPharmacyId
          ? adminPathForOrganisation(overviewPharmacyId)
          : adminPathForView(view);
    if (window.location.pathname !== path) window.history.pushState(null, '', withLocationSearch(path));
  }, [overviewFilter, overviewPharmacyId, selectedRequestId, view]);

  useEffect(() => {
    if (!overviewManageOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!overviewManageRef.current?.contains(event.target as Node)) setOverviewManageOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOverviewManageOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [overviewManageOpen]);

  useEffect(() => {
    if (view !== 'overview') {
      setOverviewManageOpen(false);
      }
  }, [view]);

  const submissionsByOrganisation = useMemo(
    () => new Map(state.organisations.map(org => [org.id, state.submissions.filter(sub => sub.organisationId === org.id)])),
    [state.organisations, state.submissions],
  );
  const crmByOrganisation = useMemo(
    () => new Map(state.organisations.map(org => [org.id, state.crm.filter(patient => patient.organisationId === org.id)])),
    [state.organisations, state.crm],
  );

  const allPatients = useMemo(() => {
    const records = new Map<string, { id: string; name: string; email: string; mobile: string; dob: string; organisationId: string; stage: string; source: string; date: Date | string | null }>();
    state.crm.forEach(patient => records.set(`${patient.organisationId}:${patient.email.toLowerCase()}`, { id: patient.id, name: patient.name, email: patient.email, mobile: patient.mobile, dob: patient.dob ?? '', organisationId: patient.organisationId, stage: patient.status, source: 'Patient record', date: patient.interactions?.at(-1)?.ts ?? null }));
    state.submissions.forEach(submission => {
      const key = `${submission.organisationId}:${submission.email.toLowerCase()}`;
      const existing = records.get(key);
      records.set(key, { id: existing?.id ?? `sub-${submission.id}`, name: submission.name, email: submission.email, mobile: submission.mobile, dob: submission.dob || existing?.dob || '', organisationId: submission.organisationId, stage: submission.status, source: submission.source, date: submission.submittedAt });
    });
    return [...records.values()];
  }, [state.crm, state.submissions]);

  const previewReferralFeeEvents = useMemo<AdminFeeEvent[]>(() => {
    const now = new Date();
    const organisations = new Map(state.organisations.map(organisation => [organisation.id, organisation]));
    const patients = new Map(state.crm.map(patient => [
      `${patient.organisationId}:${patient.email.trim().toLowerCase()}`,
      patient,
    ]));
    const events: AdminFeeEvent[] = [];

    state.submissions
      .filter(submission => submission.status === 'Approved')
      .filter(submission => {
        const compactId = submission.organisationId.replaceAll('-', '').toLowerCase();
        const organisation = organisations.get(submission.organisationId)
          ?? [...organisations.values()].find(item => item.id.replaceAll('-', '').toLowerCase() === compactId);
        return !isTrainingDirectoryPharmacy(organisation ?? { id: submission.organisationId, tradingName: submission.pharmacyName });
      })
      .forEach(submission => {
        const patientKey = `${submission.organisationId}:${submission.email.trim().toLowerCase()}`;
        const patient = patients.get(patientKey);
        const financePatient = patient as (typeof patient & {
          referralCompletedAt?: Date | string | null;
          activatedAt?: Date | string | null;
        });
        const completedAt = toValidDate(financePatient?.referralCompletedAt)
          ?? toValidDate(submission.reviewedAt)
          ?? toValidDate(submission.submittedAt);
        if (!completedAt) return;

        const pharmacyName = organisations.get(submission.organisationId)?.name
          ?? submission.pharmacyName
          ?? 'Unknown pharmacy';
        const eventBase = {
          organisationId: submission.organisationId,
          pharmacyName,
          patientKey,
          patientName: submission.name,
          patientEmail: submission.email,
        };

        events.push({
          ...eventBase,
          id: `referral-${submission.id}`,
          kind: 'new-referral',
          amount: 50,
          occurredAt: completedAt,
          anniversary: null,
        });

        const patientStatus = String(patient?.status ?? '').toLowerCase();
        const patientIsActive = Boolean(patient)
          && patientStatus !== 'suspended'
          && patientStatus !== 'inactive'
          && patientStatus !== 'referred';
        if (!patientIsActive) return;

        for (let anniversaryNumber = 1; anniversaryNumber <= 100; anniversaryNumber += 1) {
          const anniversaryDate = referralAnniversary(completedAt, anniversaryNumber);
          if (anniversaryDate > now) break;
          events.push({
            ...eventBase,
            id: `annual-${submission.id}-${anniversaryNumber}`,
            kind: 'annual-patient',
            amount: 40,
            occurredAt: anniversaryDate,
            anniversary: anniversaryNumber,
          });
        }
      });

    // Demo fees at the live demo pharmacy, so the preview has a ledger to show.
    events.push(...ledgerDemoEvents());
    return events.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  }, [state.crm, state.organisations, state.submissions]);

  useEffect(() => {
    if (isLocalPortalPreview) {
      setAdminFinanceError(null);
      setAdminFinanceLoading(false);
      return;
    }
    if (view !== 'finance' && view !== 'overview' && view !== 'patients') {
      return;
    }
    let cancelled = false;
    setAdminFinanceLoading(true);
    setAdminFinanceError(null);
    const range = view === 'finance' ? referralFinanceDateRange(financePeriod, financeMonth, financeYear) : {};
    void getAdminReferralFinance({
      ...range,
      organisationId: view === 'overview' || view === 'patients' || financeOrganisationId === 'all' ? undefined : financeOrganisationId,
    })
      .then(report => {
        if (!cancelled) setAdminFinanceReport(report);
      })
      .catch(error => {
        if (!cancelled) {
          setAdminFinanceReport(null);
          setAdminFinanceError(error instanceof Error ? error.message : 'Referral finance could not be loaded.');
        }
      })
      .finally(() => {
        if (!cancelled) setAdminFinanceLoading(false);
      });
    return () => { cancelled = true; };
  }, [adminFinanceRefresh, financeMonth, financeOrganisationId, financePeriod, financeYear, view]);

  const referralFeeEvents = useMemo<AdminFeeEvent[]>(() => {
    if (isLocalPortalPreview) return previewReferralFeeEvents;
    return (adminFinanceReport?.rows ?? []).flatMap(row => {
      const compactId = row.organisationId.replaceAll('-', '').toLowerCase();
      const organisation = state.organisations.find(item => item.id.replaceAll('-', '').toLowerCase() === compactId)
        ?? { id: row.organisationId, tradingName: row.pharmacyName };
      if (isTrainingDirectoryPharmacy(organisation)) return [];
      const occurredAt = toValidDate(row.occurredAt) ?? toValidDate(row.dueDate);
      if (!occurredAt) return [];
      const patient = state.crm.find(record => record.id === row.patientId);
      return [{
        id: row.id,
        kind: row.kind === 'new_referral' ? 'new-referral' as const : 'annual-patient' as const,
        amount: row.amountPence / 100,
        occurredAt,
        organisationId: row.organisationId,
        pharmacyName: row.pharmacyName,
        patientKey: `${row.organisationId}:${row.patientId}`,
        patientName: row.patientName || patient?.name || `Patient ${row.patientId.slice(0, 8)}`,
        patientEmail: row.patientEmail || patient?.email || row.patientId,
        anniversary: null,
      }];
    }).sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  }, [adminFinanceReport, previewReferralFeeEvents, state.crm]);

  const filteredReferralFeeEvents = useMemo(() => referralFeeEvents.filter(event => {
    if (financeOrganisationId !== 'all' && event.organisationId !== financeOrganisationId) return false;
    if (financePeriod === 'month') {
      const eventMonth = `${event.occurredAt.getFullYear()}-${String(event.occurredAt.getMonth() + 1).padStart(2, '0')}`;
      return eventMonth === financeMonth;
    }
    if (financePeriod === 'year') return String(event.occurredAt.getFullYear()) === financeYear;
    return true;
  }), [financeMonth, financeOrganisationId, financePeriod, financeYear, referralFeeEvents]);

  const financePatients = useMemo(() => {
    const patients = new Map<string, { key: string; name: string; email: string; organisationId: string; pharmacyName: string; total: number }>();
    filteredReferralFeeEvents.forEach(event => {
      const current = patients.get(event.patientKey) ?? {
        key: event.patientKey,
        name: event.patientName,
        email: event.patientEmail,
        organisationId: event.organisationId,
        pharmacyName: event.pharmacyName,
        total: 0,
      };
      current.total += event.amount;
      patients.set(event.patientKey, current);
    });
    return [...patients.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  }, [filteredReferralFeeEvents]);

  const visibleFinancePatients = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return financePatients;
    return financePatients.filter(patient => `${patient.name} ${patient.email} ${patient.pharmacyName}`.toLowerCase().includes(term));
  }, [financePatients, query]);

  useEffect(() => {
    const from = performancePeriodStart(performancePeriod);
    const organisationId = overviewPharmacy?.id;
    if (isLocalPortalPreview || view !== 'overview' || !from || !organisationId) return;
    const key = `${organisationId}|${from}`;
    let cancelled = false;
    setPeriodAttribution({ key, counts: null, status: 'loading' });
    void getAdminPatientRegister({ query: '', organisationId, status: 'all', from, to: null })
      .then(result => { if (!cancelled) setPeriodAttribution({ key, counts: attributedPatientCounts(result.scopeCounts, result.resultCount), status: 'ready' }); })
      .catch(() => { if (!cancelled) setPeriodAttribution({ key, counts: null, status: 'error' }); });
    return () => { cancelled = true; };
  }, [overviewPharmacy?.id, performancePeriod, view]);

  const feesByOrganisation = useMemo(() => {
    const byOrganisation = new Map<string, AdminFeeEvent[]>();
    for (const event of referralFeeEvents) byOrganisation.set(event.organisationId, [...(byOrganisation.get(event.organisationId) ?? []), event]);
    return new Map([...byOrganisation].map(([organisationId, events]) => [organisationId, summariseFeeEvents(events)]));
  }, [referralFeeEvents]);

  useEffect(() => {
    if (view !== 'finance') return;
    if (financePatientKey !== 'all' && visibleFinancePatients.some(patient => patient.key === financePatientKey)) return;
    setFinancePatientKey(visibleFinancePatients[0]?.key ?? 'all');
  }, [financePatientKey, visibleFinancePatients, view]);

  useEffect(() => {
    if (isLocalPortalPreview || view !== 'patients') {
      setPatientRegisterLoading(false);
      return;
    }
    let cancelled = false;
    setPatientRegisterLoading(true);
    const timer = window.setTimeout(() => {
      void getAdminPatientRegister({ query: query.trim(), organisationId: patientOrganisationId, status: patientStatus, from: patientFrom || null, to: patientTo || null })
        .then(result => {
          if (!cancelled) {
            setServerPatientRegister(result);
            setPatientExportError(null);
          }
        })
        .catch(error => {
          if (!cancelled) {
            setServerPatientRegister(null);
            setPatientExportError(error instanceof Error ? error.message : 'The patient register could not be loaded.');
          }
        })
        .finally(() => { if (!cancelled) setPatientRegisterLoading(false); });
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [patientFrom, patientOrganisationId, patientStatus, patientTo, query, view]);

  useEffect(() => {
    if (isLocalPortalPreview || view !== 'overview') return;
    let cancelled = false;
    setOverviewAttributionStatus('loading');
    setOpenIntakeStatus('loading');
    void getAdminPatientRegister({ query: '', organisationId: 'all', status: 'all', from: null, to: null })
      .then(result => {
        if (cancelled) return;
        setOverviewAttribution(attributedPatientCounts(result.scopeCounts, result.resultCount));
        setOverviewAttributionStatus('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setOverviewAttribution(null);
        setOverviewAttributionStatus('error');
      });
    void Promise.all([getAdminGeneralIntake(), getAdminPharmacyReferralIntake()])
      .then(([general, referrals]) => {
        if (cancelled) return;
        setOpenIntakeCount(general.records.length + referrals.records.length);
        setFreshIntakeCount([...general.records, ...referrals.records].filter(record => record.hhhOpened === false).length);
        setOpenIntakeStatus('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setOpenIntakeCount(null);
        setOpenIntakeStatus('error');
      });
    return () => { cancelled = true; };
  }, [view]);

  // A test patient is one whose pharmacy is a platform test account or a
  // training workspace — the same rule the rest of the admin surface uses.
  const isTestPatientRow = useCallback((row: { organisationId: string }) => {
    const organisation = state.organisations.find(item => item.id === row.organisationId);
    return Boolean(organisation && (isPlatformTestPharmacy(organisation) || organisation.testAccount));
  }, [state.organisations]);
  // Everything the search, pharmacy and date filters admit, before the stage
  // filter narrows it: the stage buttons count from here. Preview only.
  const previewScope = useMemo(() => allPatients.filter(patient => {
    const org = state.organisations.find(item => item.id === patient.organisationId);
    const searchMatches = `${patient.name} ${patient.email} ${patient.mobile} ${patient.dob} ${formatPatientDob(patient.dob)} ${org?.name ?? ''} ${org?.tradingName ?? ''}`.toLowerCase().includes(query.trim().toLowerCase());
    if (!searchMatches) return false;
    if (hideTestPatients && isTestPatientRow(patient)) return false;
    if (patientOrganisationId !== 'all' && patient.organisationId !== patientOrganisationId) return false;
    const date = londonDateKey(patient.date);
    if (patientFrom && (!date || date < patientFrom)) return false;
    if (patientTo && (!date || date > patientTo)) return false;
    return true;
  }), [allPatients, hideTestPatients, isTestPatientRow, patientFrom, patientOrganisationId, patientTo, query, state.organisations]);
  const filteredPatients = useMemo(
    () => previewScope.filter(patient => patientStatus === 'all' || patient.stage === patientStatus),
    [patientStatus, previewScope],
  );
  // The server applies the search, pharmacy, stage and date filters; the test
  // toggle is applied here so the export's server-side scope stays untouched.
  const displayedPatients = useMemo(
    () => (isLocalPortalPreview ? filteredPatients : serverPatientRegister?.rows ?? [])
      .filter(row => !hideTestPatients || !isTestPatientRow(row)),
    [filteredPatients, hideTestPatients, isTestPatientRow, serverPatientRegister],
  );
  // How many records each stage holds in the current scope. The server reports
  // them per pharmacy so the test toggle can leave test pharmacies out here,
  // exactly as it does for the rows. A build that predates the counts falls
  // back to the rows on screen, which is right whenever no stage is selected.
  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    const source = isLocalPortalPreview
      ? previewScope.map(patient => ({ organisationId: patient.organisationId, stage: patient.stage, count: 1 }))
      : serverPatientRegister?.scopeCounts ?? displayedPatients.map(row => ({ organisationId: row.organisationId, stage: row.stage, count: 1 }));
    for (const entry of source) {
      if (hideTestPatients && isTestPatientRow(entry)) continue;
      counts[entry.stage] = (counts[entry.stage] ?? 0) + entry.count;
    }
    return counts;
  }, [displayedPatients, hideTestPatients, isTestPatientRow, previewScope, serverPatientRegister]);
  const scopeTotal = Object.values(stageCounts).reduce((total, count) => total + count, 0);

  const toRegisterRow = useCallback((patient: typeof displayedPatients[number]): PatientRegisterExportRow => {
    const organisation = state.organisations.find(item => item.id === patient.organisationId);
    const pharmacyName = 'pharmacyName' in patient ? patient.pharmacyName : organisation?.name;
    const gphcNumber = 'gphcNumber' in patient ? patient.gphcNumber : organisation?.gphcNumber;
    return {
      id: patient.id,
      name: patient.name,
      email: patient.email,
      mobile: patient.mobile,
      dob: patient.dob,
      organisationId: patient.organisationId,
      pharmacyName: pharmacyName ?? 'Unknown pharmacy',
      gphcNumber: gphcNumber ?? '',
      stage: patient.stage,
      date: patient.date ? (typeof patient.date === 'string' ? patient.date : new Date(patient.date).toISOString()) : null,
      // The server row carries the patient's eligibility answers; re-shaping the row must not drop them.
      conditions: 'conditions' in patient ? patient.conditions : undefined,
      primaryCondition: 'primaryCondition' in patient ? patient.primaryCondition : undefined,
      firstName: 'firstName' in patient ? patient.firstName : undefined,
      surname: 'surname' in patient ? patient.surname : undefined,
      postcode: 'postcode' in patient ? patient.postcode : undefined,
      editable: 'editable' in patient ? patient.editable : !patient.id.startsWith('sub-'),
      // Details HHH saved since the register loaded, so the list and record show them at once.
      ...registerEdits[registerRowKey({ organisationId: patient.organisationId, id: patient.id })],
    };
  }, [registerEdits, state.organisations]);

  useEffect(() => {
    if (view !== 'patients') return;
    if (pendingRegisterKey) {
      const pending = displayedPatients.find(patient => registerRowKey(patient) === pendingRegisterKey || registerPatientKey(patient) === pendingRegisterKey);
      if (pending) {
        setSelectedRegisterPatient(toRegisterRow(pending));
        setPendingRegisterKey(null);
        return;
      }
      if (patientRegisterLoading) return;
      setPendingRegisterKey(null);
    }
    if (selectedRegisterPatient && displayedPatients.some(patient => registerRowKey(patient) === registerRowKey(selectedRegisterPatient))) {
      return;
    }
    const first = displayedPatients[0];
    setSelectedRegisterPatient(first ? toRegisterRow(first) : null);
  }, [displayedPatients, patientRegisterLoading, pendingRegisterKey, selectedRegisterPatient, toRegisterRow, view]);

  const exportPatients = async () => {
    setPatientExportBusy(true);
    setPatientExportError(null);
    try {
      const exportRows = isLocalPortalPreview
        ? filteredPatients.map(patient => {
            const organisation = state.organisations.find(item => item.id === patient.organisationId);
            return { ...patient, pharmacyName: organisation?.name ?? 'Unknown pharmacy' };
          })
        : (await recordPatientRegisterExport({ query: query.trim(), organisationId: patientOrganisationId, status: patientStatus, from: patientFrom || null, to: patientTo || null, expectedScopeHash: serverPatientRegister?.recordScopeHash ?? '' })).rows;
      const header = ['Patient', 'Attributed pharmacy', 'Current stage', 'Last recorded'];
      const rows = exportRows.map(patient => [
          `${patient.name} | ${patient.email} | ${patient.mobile || '—'} | DOB ${formatPatientDob(patient.dob)}`,
          patient.pharmacyName,
          onboardingStatusLabel(patient.stage),
          patient.date ? new Date(patient.date).toLocaleDateString('en-GB', { timeZone: 'Europe/London' }) : '—',
        ]);
      const csv = [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
      const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `hhh-patient-register-${londonDateKey(new Date())}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      dispatch({ type: 'ADD_TOAST', message: `Exported ${exportRows.length} server-scoped patient record${exportRows.length === 1 ? '' : 's'}.`, toastType: 'success' });
    } catch (error) {
      setPatientExportError(error instanceof Error ? error.message : 'The patient register could not be exported.');
    } finally {
      setPatientExportBusy(false);
    }
  };

  const registeredCount = state.organisations.filter(org => !isTrainingDirectoryPharmacy(org)).length;
  const trainingCount = state.organisations.filter(org => isTrainingDirectoryPharmacy(org)).length;
  const pendingAdminDecisions = state.submissions.filter(submission => submission.status === 'New' || submission.status === 'Under HHH review').length;
  const adminCommands = useMemo<CommandDefinition[]>(() => [
    { label: 'Pharmacies', detail: 'Manage pharmacy organisations', group: 'Navigate', icon: <LayoutDashboard size={16} />, run: () => { setView('overview'); } },
    { label: 'Patient onboarding', detail: 'Record patient calls and decisions', group: 'Navigate', icon: <UserCheck size={16} />, run: () => { setView('referrals'); } },
    { label: 'Patient register', detail: 'Cross-pharmacy patient ownership', group: 'Navigate', icon: <Users size={16} />, run: () => { setView('patients'); } },
    { label: 'Referral finance', detail: '£50 first dispenses and £40 annual fees', group: 'Navigate', icon: <PoundSterling size={16} />, run: () => { setView('finance'); } },
    { label: 'Pharmacy requests', detail: 'New pharmacies waiting to be activated', group: 'Navigate', icon: <Building2 size={16} />, run: () => { setView('overview'); setOverviewFilter('requests'); setQuery(''); } },
    { label: 'Invite admin', detail: 'Add another HHH administrator account', group: 'Actions', icon: <UserPlus size={16} />, run: () => { setAdminDialogFocus('invite'); setShowAdminDialog(true); } },
    { label: 'View admins', detail: 'HHH administrator accounts', group: 'Navigate', icon: <Users size={16} />, run: () => { setAdminDialogFocus('list'); setShowAdminDialog(true); } },
    { label: 'Onboard pharmacy (Legacy)', detail: 'Create a pharmacy by hand. New pharmacies now join from the onboarding page.', group: 'Actions', icon: <Plus size={16} />, run: () => { setView('overview'); setShowOnboarding(true); } },
    ...state.organisations.map((organisation): CommandDefinition => ({
      label: organisation.name,
      detail: `GPhC ${organisation.gphcNumber}`,
      keywords: `${organisation.websiteDomains.join(' ')} ${organisation.pharmacyEmail ?? ''} ${organisation.mainContactEmail}`,
      group: 'Pharmacies',
      searchOnly: true,
      icon: <Building2 size={16} />,
      run: () => openPharmacyOnOverview(organisation.id),
    })),
    ...allPatients.map((patient): CommandDefinition => {
      const organisation = state.organisations.find(item => item.id === patient.organisationId);
      return {
        label: patient.name,
        detail: `${organisation?.name ?? 'Unknown pharmacy'} · ${patient.email}`,
        keywords: `${patient.mobile} ${patient.dob} ${patient.stage}`,
        group: 'Patients',
        searchOnly: true,
        icon: <Users size={16} />,
        run: () => { setView('patients'); setQuery(patient.email); },
      };
    }),
  ], [allPatients, openPharmacyOnOverview, state.organisations]);

  /**
   * Every pharmacy is created when HHH activates its request. Until HHH enters the
   * PHAR code and API key Curaleaf send, it is "awaiting Curaleaf": its eligibility
   * link is open but ordering is not. Test pharmacies are always connected to the
   * sandbox and never wait.
   */
  const awaitingCuraleaf = useCallback(
    (org: PharmacyTenant) => !isTrainingDirectoryPharmacy(org) && org.status !== 'live' && org.status !== 'paused' && org.status !== 'not_available' && org.curaleafEnvironment !== 'production',
    [],
  );
  const overviewPharmacies = state.organisations.filter(org => {
    const matchesQuery = `${org.name} ${org.tradingName} ${org.gphcNumber}`.toLowerCase().includes(query.toLowerCase());
    if (!matchesQuery) return false;
    if (overviewFilter === 'requests') return awaitingCuraleaf(org);
    if (overviewFilter === 'on_hold') return false;
    if (overviewFilter === 'registered') return !isTrainingDirectoryPharmacy(org) && !awaitingCuraleaf(org);
    if (overviewFilter === 'training') return isTrainingDirectoryPharmacy(org);
    return true;
  });
  // New requests wait for HHH to activate or hold them; held ones are listed only on
  // their own On hold tab.
  const { overviewRequests, heldRequests } = useMemo(() => {
    const needle = query.toLowerCase();
    const matches = (request: { pharmacyName: string; registeredCompanyName: string; gphcNumber: string }) => (
      `${request.pharmacyName} ${request.registeredCompanyName} ${request.gphcNumber}`.toLowerCase().includes(needle)
    );
    return {
      overviewRequests: overviewFilter === 'all' || overviewFilter === 'requests' ? pharmacyRequests.pending.filter(matches) : [],
      heldRequests: overviewFilter === 'on_hold' ? pharmacyRequests.onHold.filter(matches) : [],
    };
  }, [overviewFilter, pharmacyRequests.onHold, pharmacyRequests.pending, query]);
  const selectedRequest = pharmacyRequests.records.find(request => request.id === selectedRequestId && request.status !== 'activated') ?? null;
  const overviewResultCount = overviewPharmacies.length + overviewRequests.length + heldRequests.length;
  const awaitingPharmacies = overviewPharmacies.filter(awaitingCuraleaf);
  const closedToPharmacy = (org: PharmacyTenant) => org.status === 'paused' || org.status === 'not_available';
  const registeredPharmacies = overviewPharmacies.filter(org => !isTrainingDirectoryPharmacy(org) && !awaitingCuraleaf(org) && !closedToPharmacy(org));
  const suspendedPharmacies = overviewPharmacies.filter(org => !isTrainingDirectoryPharmacy(org) && closedToPharmacy(org));
  const trainingPharmacies = overviewPharmacies.filter(org => isTrainingDirectoryPharmacy(org));
  const awaitingCount = state.organisations.filter(awaitingCuraleaf).length + pharmacyRequests.pending.length;
  const requestForOrganisation = useCallback(
    (organisationId: string) => pharmacyRequests.records.find(request => request.organisationId === organisationId) ?? null,
    [pharmacyRequests.records],
  );

  // Keep a visible record selected: the first awaiting pharmacy on that tab, else
  // the first pharmacy in the list. A request stays selected while it is listed.
  useEffect(() => {
    if (view !== 'overview') return;
    const requestVisible = selectedRequest && [...overviewRequests, ...heldRequests].some(request => request.id === selectedRequest.id);
    if (requestVisible) return;
    if (selectedRequestId) setSelectedRequestId(null);
    if (overviewPharmacyId && overviewPharmacies.some(organisation => organisation.id === overviewPharmacyId)) return;
    if (overviewPharmacyId && overviewFilter !== 'requests' && !state.organisations.length) return;
    const firstPharmacy = awaitingPharmacies[0] ?? registeredPharmacies[0] ?? trainingPharmacies[0];
    if (firstPharmacy) {
      setOverviewPharmacyId(firstPharmacy.id);
    } else {
      const firstRequest = overviewRequests[0] ?? heldRequests[0];
      if (firstRequest) setSelectedRequestId(firstRequest.id);
      else if (overviewFilter === 'requests') setOverviewPharmacyId(null);
    }
    setOverviewManagePanel('summary');
    setOverviewManageOpen(false);
  }, [awaitingPharmacies, heldRequests, overviewFilter, overviewPharmacies, overviewPharmacyId, overviewRequests, registeredPharmacies, selectedRequest, selectedRequestId, state.organisations.length, trainingPharmacies, view]);

  const statusLabel = (status: PharmacyTenant['status']) => {
    if (status === 'live') return 'Live';
    if (status === 'paused') return 'Suspended';
    if (status === 'not_available') return 'Not available';
    return 'Awaiting Curaleaf';
  };
  const pharmacyTone = (status: PharmacyTenant['status']) => status === 'live' ? 'paid' : status === 'paused' || status === 'not_available' ? 'danger' : 'warning';
  /** A pharmacy is Test, Awaiting Curaleaf or Live; rejected ones leave the directory. */
  const pharmacyStageLabel = (organisation: PharmacyTenant) => {
    if (isTrainingDirectoryPharmacy(organisation)) return 'Test';
    return awaitingCuraleaf(organisation) ? 'Awaiting Curaleaf' : statusLabel(organisation.status);
  };
  const intakeIsLive = (organisation: PharmacyTenant) => {
    if (organisation.status === 'paused' || organisation.status === 'not_available') return false;
    if (organisation.intakeEnabled === false) return false;
    return true;
  };

  // The pharmacy section bar sticks flush to the top of the scrolling page; its
  // top padding differs by breakpoint, so publish it for the CSS to cancel out.
  useEffect(() => {
    const container = document.getElementById('admin-main-content');
    if (!container) return;
    const publish = () => container.style.setProperty('--admin-scroll-pad-top', getComputedStyle(container).paddingTop);
    publish();
    window.addEventListener('resize', publish);
    return () => window.removeEventListener('resize', publish);
  }, []);

  // Links from Patients, Finance and onboarding ask for a section; scroll to it once.
  useEffect(() => {
    if (view !== 'overview' || overviewManagePanel === 'summary') return;
    const frame = window.requestAnimationFrame(() => {
      scrollToPharmacySection(overviewManagePanel, false);
      setOverviewManagePanel('summary');
    });
    return () => window.cancelAnimationFrame(frame);
  }, [overviewManagePanel, overviewPharmacyId, view]);

  // Highlight the section under the pinned bar as the admin scrolls the record.
  useEffect(() => {
    const container = document.getElementById('admin-main-content');
    if (!container || view !== 'overview') return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const bar = document.querySelector<HTMLElement>('.pharmacy-dashboard__nav');
      if (!bar) return;
      const line = bar.getBoundingClientRect().bottom + 40;
      let current: OverviewManagePanel = 'summary';
      for (const section of PHARMACY_SECTIONS) {
        const el = document.getElementById(`pharmacy-section-${section.id}`);
        if (el && el.getBoundingClientRect().top <= line) current = section.id;
      }
      // At the very bottom the last section is the one being read, even if short.
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) current = PHARMACY_SECTIONS[PHARMACY_SECTIONS.length - 1]!.id;
      setActiveSection(current);
    };
    let settle = 0;
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
      window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        if (pendingSectionRef.current) setActiveSection(pendingSectionRef.current);
        pendingSectionRef.current = null;
      }, 120);
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    update();
    return () => { container.removeEventListener('scroll', onScroll); window.clearTimeout(settle); if (frame) window.cancelAnimationFrame(frame); };
  }, [overviewPharmacyId, selectedRequestId, view]);

  /** The record is one page; the section bar and Account actions scroll to a part of it. */
  const goToSection = useCallback((section: OverviewManagePanel) => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const container = document.getElementById('admin-main-content');
    const before = container?.scrollTop ?? 0;
    if (reduce) { pendingSectionRef.current = null; setActiveSection(section); }
    else pendingSectionRef.current = section;
    scrollToPharmacySection(section, !reduce);
    // Already in place means no scroll events to settle on, so select it once the click lands.
    window.setTimeout(() => {
      if (pendingSectionRef.current === section && (container?.scrollTop ?? 0) === before) { setActiveSection(section); pendingSectionRef.current = null; }
    }, 150);
  }, []);

  const renderOverview = () => {
    const portfolioAccrued = referralFeeEvents.reduce((total, event) => total + event.amount, 0);
    const firstDispenseCount = referralFeeEvents.filter(event => event.kind === 'new-referral').length;
    const financeReady = isLocalPortalPreview || Boolean(adminFinanceReport) || !adminFinanceLoading;
    const selectedPharmacy = overviewPharmacy;
    const periodFrom = performancePeriodStart(performancePeriod);
    const periodStart = periodFrom ? new Date(`${periodFrom}T00:00:00`) : null;
    const selectedFees = !selectedPharmacy
      ? null
      : periodStart
        ? summariseFeeEvents(referralFeeEvents.filter(event => event.organisationId === selectedPharmacy.id && event.occurredAt >= periodStart))
        : feesByOrganisation.get(selectedPharmacy.id);
    const periodKey = selectedPharmacy && periodFrom ? `${selectedPharmacy.id}|${periodFrom}` : null;
    const periodCounts = periodKey && periodAttribution?.key === periodKey ? periodAttribution : null;
    const previewAttributed = selectedPharmacy ? new Set([
      ...(crmByOrganisation.get(selectedPharmacy.id) ?? []).map(patient => patient.email),
      ...(submissionsByOrganisation.get(selectedPharmacy.id) ?? []).map(submission => submission.email),
    ]).size : 0;
    const inPeriod = (date: Date | string | null) => {
      if (!periodStart) return true;
      const when = date ? new Date(date) : null;
      return Boolean(when && !Number.isNaN(when.getTime()) && when >= periodStart);
    };
    const attributionSource = periodKey ? periodCounts?.counts ?? null : overviewAttribution;
    const selectedPatients = isLocalPortalPreview
      ? (periodStart && selectedPharmacy ? allPatients.filter(patient => patient.organisationId === selectedPharmacy.id && inPeriod(patient.date)).length : previewAttributed)
      : attributedCountForOrganisation(attributionSource, selectedPharmacy?.id ?? '');
    const selectedStages = isLocalPortalPreview
      ? (selectedPharmacy ? splitAttributedRecords(allPatients.filter(patient => patient.organisationId === selectedPharmacy.id && inPeriod(patient.date))) : null)
      : attributedStagesForOrganisation(attributionSource, selectedPharmacy?.id ?? '');
    const selectedAttributionStatus = periodKey && !isLocalPortalPreview ? periodCounts?.status ?? 'loading' : overviewAttributionStatus;
    const patientReach = isLocalPortalPreview
      ? allPatients.length
      : overviewAttribution
        ? portfolioAttributedCount(
          overviewAttribution,
          state.organisations,
          organisation => isPlatformTestPharmacy(organisation) || Boolean(organisation.testAccount),
        )
        : null;
    const intakeWaiting = isLocalPortalPreview ? pendingAdminDecisions : openIntakeCount;
    const workspaceLabel = isPlatformTestPharmacy(selectedPharmacy)
        ? 'Test'
        : selectedPharmacy?.status === 'live'
          ? 'Live'
          : selectedPharmacy?.status === 'paused'
            ? 'Suspended'
            : selectedPharmacy?.status === 'not_available'
              ? 'Not available'
              : 'Awaiting Curaleaf';
    const formUrl = referralLink;
    const selectedIntakeLive = selectedPharmacy ? intakeIsLive(selectedPharmacy) : false;

    const renderPharmacyRow = (organisation: PharmacyTenant) => {
      const tone = pharmacyTone(organisation.status);
      const fees = feesByOrganisation.get(organisation.id);
      return (
        <button
          type="button"
          key={organisation.id}
          className={`order-crm-row order-crm-row--${tone}${!selectedRequest && overviewPharmacyId === organisation.id ? ' selected' : ''}`}
          aria-pressed={!selectedRequest && overviewPharmacyId === organisation.id}
          aria-label={`${organisation.name}, ${pharmacyStageLabel(organisation)}, Worldpay ${worldpayStateLabel(organisation.worldpayState)}`}
          onClick={() => {
            if (organisation.id !== overviewPharmacyId) {
              setOverviewManagePanel('summary');
                      }
            setSelectedRequestId(null);
            setDeclineOpen(false);
            setSuspendOpen(false);
            setNotAvailableOpen(false);
            setOverviewPharmacyId(organisation.id);
            setOverviewManageOpen(false);
          }}
        >
          <span className={`order-crm-row__stage order-tone--${tone}`} aria-hidden="true">{organisation.logoText}</span>
          <span className="order-crm-row__identity">
            <strong title={organisation.name}>{organisation.name}</strong>
            <span className={`order-stage-pill order-tone--${tone}`}>{pharmacyStageLabel(organisation)}</span>
            {awaitingCuraleaf(organisation) ? (
              <span className={`order-stage-pill ${pharmacyRequests.worldpayFor(organisation.gphcNumber) ? 'order-tone--paid' : 'order-tone--neutral'}`}>
                {pharmacyRequests.worldpayFor(organisation.gphcNumber) ? 'Worldpay form sent' : 'Worldpay form not sent'}
              </span>
            ) : (
              <span className={`order-stage-pill ${worldpayStateTone(organisation.worldpayState)}`}>Worldpay {organisation.worldpayState === 'live' ? 'live' : organisation.worldpayState === 'test' ? 'test' : 'not connected'}</span>
            )}
          </span>
          <span className="order-crm-row__position">
            {awaitingCuraleaf(organisation) ? (
              <strong>{formatRequestDate(requestForOrganisation(organisation.id)?.createdAt) || 'Added by HHH'}</strong>
            ) : (
              <strong>{financeReady ? referralFeeFormatter.format(fees?.total ?? 0) : '—'}</strong>
            )}
            <small>GPhC {organisation.gphcNumber}</small>
          </span>
        </button>
      );
    };

    const renderRequestRow = (request: (typeof pharmacyRequests.records)[number]) => (
      <PharmacyRequestRow
        key={request.id}
        request={request}
        selected={selectedRequestId === request.id}
        worldpaySubmittedAt={pharmacyRequests.worldpayFor(request.gphcNumber)}
        onSelect={() => {
          setSelectedRequestId(request.id);
          setOverviewManageOpen(false);
              }}
      />
    );
    const selectedWorldpayForm = selectedPharmacy ? pharmacyRequests.worldpayFor(selectedPharmacy.gphcNumber) : null;
    const selectedApplication = selectedPharmacy ? requestForOrganisation(selectedPharmacy.id) : null;
    const selectedAwaiting = Boolean(selectedPharmacy && awaitingCuraleaf(selectedPharmacy));
    // Reject is for pharmacies still being set up, for example when Curaleaf turn the account down.
    const selectedCanDecline = Boolean(selectedPharmacy && !isTrainingDirectoryPharmacy(selectedPharmacy) && selectedPharmacy.status !== 'live' && selectedPharmacy.status !== 'paused');
    const selectedCanSuspend = Boolean(selectedPharmacy && !isTrainingDirectoryPharmacy(selectedPharmacy) && selectedPharmacy.status === 'live');
    const selectedSuspended = Boolean(selectedPharmacy && selectedPharmacy.status === 'paused');
    // Not available: an existing Curaleaf customer, found while the pharmacy awaits Curaleaf.
    const selectedNotAvailable = Boolean(selectedPharmacy && selectedPharmacy.status === 'not_available');
    const selectedCanMarkNotAvailable = Boolean(selectedPharmacy && selectedAwaiting && !isPlatformTestPharmacy(selectedPharmacy));

    return (
      <div className="page-body order-crm patient-crm admin-overview-crm">
        {headerSummary ? createPortal(
        <section className="order-crm-summary" aria-label="Pharmacy portfolio summary">
          <div className="order-crm-summary__tiles">
            <article className="order-crm-metric">
              <span className="order-crm-metric__icon"><Building2 size={16} /></span>
              <span><small>Pharmacies</small><strong>{state.organisations.length}</strong><em>{[
                awaitingCount ? `${awaitingCount} awaiting Curaleaf` : '',
                `${registeredCount - state.organisations.filter(awaitingCuraleaf).length} live`,
                `${trainingCount} testing`,
              ].filter(Boolean).join(' · ')}</em></span>
            </article>
            <article className="order-crm-metric">
              <span className="order-crm-metric__icon"><Users size={16} /></span>
              <span>
                <small>Patient reach</small>
                <strong>{patientReach == null ? (overviewAttributionStatus === 'error' ? '—' : 'Loading') : patientReach}</strong>
                <em>{overviewAttributionStatus === 'error' ? 'Register unavailable' : 'Attributed records across the portfolio'}</em>
              </span>
            </article>
            <article className="order-crm-metric">
              <span className="order-crm-metric__icon"><PoundSterling size={16} /></span>
              <span>
                <small>Accrued fees</small>
                <strong>{financeReady ? referralFeeFormatter.format(portfolioAccrued) : 'Loading'}</strong>
                <em>{adminFinanceError ? 'Ledger unavailable' : `${firstDispenseCount} first dispenses · £50 + £40 annual`}</em>
              </span>
            </article>
            <article className="order-crm-metric">
              <span className="order-crm-metric__icon"><UserCheck size={16} /></span>
              <span>
                <small>Intake queue</small>
                <strong>{intakeWaiting == null ? (openIntakeStatus === 'error' ? '—' : 'Loading') : intakeWaiting}</strong>
                <em>{
                  intakeWaiting == null
                    ? (openIntakeStatus === 'error' ? 'Queue unavailable' : 'Open website and QR submissions')
                    : intakeWaiting
                      ? 'Decisions waiting on HHH'
                      : 'No pending decisions'
                }</em>
              </span>
            </article>
          </div>
        </section>,
          headerSummary,
        ) : null}

        <section className="order-crm-controls admin-filter-bar">
          <div className="admin-filter-bar__top">
          <div className="order-crm-search">
            <Search size={15} />
            <input
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search pharmacy name or GPhC number"
              aria-label="Search pharmacies"
            />
          </div>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowOnboarding(true)}>
              <Plus size={14} /> Onboard pharmacy (Legacy)
            </button>
          </div>
          <div className="order-crm-filters" role="group" aria-label="Filter pharmacies">
            {([
              { key: 'all' as const, label: 'All', count: state.organisations.length + pharmacyRequests.pending.length },
              { key: 'requests' as const, label: 'Awaiting Curaleaf', count: awaitingCount },
              { key: 'registered' as const, label: 'Live', count: state.organisations.filter(org => !isTrainingDirectoryPharmacy(org) && !awaitingCuraleaf(org)).length },
              { key: 'training' as const, label: 'Testing', count: trainingCount },
              ...(pharmacyRequests.onHold.length ? [{ key: 'on_hold' as const, label: 'On hold', count: pharmacyRequests.onHold.length }] : []),
            ]).map(filter => (
              <button
                type="button"
                key={filter.key}
                className={`${overviewFilter === filter.key ? 'active' : ''}${filter.key === 'requests' && filter.count ? ' has-attention' : ''}`}
                aria-pressed={overviewFilter === filter.key}
                onClick={() => setOverviewFilter(filter.key)}
              >
                <span>{filter.label}</span><strong>{filter.count}</strong>
              </button>
            ))}
          </div>
        </section>

        {adminFinanceError ? (
          <div className="banner banner-amber" role="alert">
            <AlertCircle size={16} />
            <span><strong>Referral finance is temporarily unavailable</strong><small>{adminFinanceError}</small></span>
            <button className="btn btn-sm" type="button" onClick={() => setAdminFinanceRefresh(value => value + 1)}>Try again</button>
          </div>
        ) : null}

        <div className="order-crm-workspace">
          <aside className="order-crm-list" aria-label="Pharmacies">
            <header>
              <span><small>Directory</small><strong>{overviewResultCount} result{overviewResultCount === 1 ? '' : 's'}</strong></span>
            </header>
            <div className="order-crm-list__scroller">
              <div className="order-crm-list__rows">
                {overviewResultCount === 0 ? (
                  overviewFilter === 'requests' ? (
                    <div className="order-crm-empty">
                      <Building2 size={26} />
                      <strong>{query ? 'No pharmacies match' : 'Nothing waiting on Curaleaf'}</strong>
                      <span>{pharmacyRequests.status === 'error' ? (pharmacyRequests.error ?? 'Try again shortly.') : 'New requests appear here when a pharmacy sends the Curaleaf account form. Activated pharmacies stay here until their PHAR code and API key are entered.'}</span>
                      {pharmacyRequests.status === 'error' ? <button type="button" className="btn btn-sm" onClick={() => void pharmacyRequests.reload()}>Try again</button> : null}
                    </div>
                  ) : (
                    <div className="order-crm-empty">
                      <Building2 size={26} />
                      <strong>{state.organisations.length === 0 ? 'No pharmacies onboarded' : 'No pharmacies match'}</strong>
                      <span>{state.organisations.length === 0 ? 'Onboard a pharmacy to start the portfolio.' : 'Try another filter or search term.'}</span>
                    </div>
                  )
                ) : (
                  <>
                    {overviewRequests.length ? (
                      <section className="order-crm-list-group admin-request-group" aria-label="New pharmacy requests">
                        <header>
                          <span>
                            <strong>New requests</strong>
                            <small>Activate or hold</small>
                          </span>
                          <b>{overviewRequests.length}</b>
                        </header>
                        {overviewRequests.map(renderRequestRow)}
                      </section>
                    ) : null}
                    {awaitingPharmacies.length ? (
                      <section className="order-crm-list-group admin-request-group" aria-label="Pharmacies awaiting Curaleaf">
                        <header>
                          <span>
                            <strong>Awaiting Curaleaf</strong>
                            <small>Enter the PHAR code and API key to activate</small>
                          </span>
                          <b>{awaitingPharmacies.length}</b>
                        </header>
                        {awaitingPharmacies.map(organisation => renderPharmacyRow(organisation))}
                      </section>
                    ) : null}
                    {heldRequests.length ? (
                      <section className="order-crm-list-group" aria-label="Pharmacy requests on hold">
                        <header>
                          <span>
                            <strong>On hold</strong>
                            <small>Unhold to activate</small>
                          </span>
                          <b>{heldRequests.length}</b>
                        </header>
                        {heldRequests.map(renderRequestRow)}
                      </section>
                    ) : null}
                    {registeredPharmacies.length ? (
                      <section className="order-crm-list-group" aria-label="Registered pharmacies">
                        <header>
                          <span>
                            <strong>Live</strong>
                            <small>Live on Curaleaf</small>
                          </span>
                          <b>{registeredPharmacies.length}</b>
                        </header>
                        {registeredPharmacies.map(organisation => renderPharmacyRow(organisation))}
                      </section>
                    ) : null}
                    {suspendedPharmacies.length ? (
                      <section className="order-crm-list-group" aria-label="Suspended or not available pharmacies">
                        <header>
                          <span>
                            <strong>Suspended or not available</strong>
                            <small>Staff locked out, eligibility link off</small>
                          </span>
                          <b>{suspendedPharmacies.length}</b>
                        </header>
                        {suspendedPharmacies.map(organisation => renderPharmacyRow(organisation))}
                      </section>
                    ) : null}
                    {trainingPharmacies.length ? (
                      <section className="order-crm-list-group" aria-label="Testing pharmacies">
                        <header>
                          <span>
                            <strong>Testing pharmacies</strong>
                            <small>Sandbox pharmacies</small>
                          </span>
                          <b>{trainingPharmacies.length}</b>
                        </header>
                        {trainingPharmacies.map(organisation => renderPharmacyRow(organisation))}
                      </section>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          </aside>

          <main className="order-crm-detail">
            {selectedRequest ? (
              <PharmacyRequestRecord
                request={selectedRequest}
                worldpaySubmittedAt={pharmacyRequests.worldpayFor(selectedRequest.gphcNumber)}
                onChanged={pharmacyRequests.replace}
                onActivated={(organisation, request) => {
                  dispatch({ type: 'ADD_ORGANISATION', organisation: tenantFromActivation(organisation) });
                  pharmacyRequests.replace(request);
                  setSelectedRequestId(null);
                  setOverviewFilter('all');
                  setOverviewPharmacyId(organisation.id);
                  setOverviewManagePanel('summary');
                  dispatch({ type: 'ADD_TOAST', message: `${organisation.name} is now a pharmacy in onboarding, with a training workspace. Use Manage to go live when setup is done.`, toastType: 'success' });
                }}
              />
            ) : overviewFilter === 'requests' && !selectedPharmacy ? (
              <div className="order-crm-empty order-crm-empty--detail">
                <Building2 size={38} />
                <strong>Nothing waiting on Curaleaf</strong>
                <span>New pharmacies appear here as soon as they send the Curaleaf account form.</span>
              </div>
            ) : !selectedPharmacy ? (
              <div className="order-crm-empty order-crm-empty--detail">
                <Building2 size={38} />
                <strong>Select a pharmacy</strong>
                <span>Account status and referral fees appear here. Use Manage on a selected pharmacy to review identity, staff, go live or Curaleaf.</span>
              </div>
            ) : (
              <article className={`order-crm-record order-crm-record--${pharmacyTone(selectedPharmacy.status)}`}>
                <header className="order-crm-record__header">
                  <div className="order-crm-record__hero">
                    <div className="order-crm-record__identity">
                      <span className={`order-crm-record__stage order-tone--${pharmacyTone(selectedPharmacy.status)}`} aria-hidden="true">{selectedPharmacy.logoText}</span>
                      <div className="order-crm-record__titles">
                        <strong>{selectedPharmacy.name}</strong>
                        <span className="order-crm-record__ref">{selectedPharmacy.tradingName && selectedPharmacy.tradingName !== selectedPharmacy.name ? `${selectedPharmacy.tradingName} · ` : ''}GPhC {selectedPharmacy.gphcNumber}</span>
                        <em>{workspaceLabel}</em>
                      </div>
                    </div>
                    <span className={`order-stage-pill order-tone--${pharmacyTone(selectedPharmacy.status)}`}>{pharmacyStageLabel(selectedPharmacy)}</span>
                  </div>
                  <div className="order-crm-record__toolbar">
                    {selectedAwaiting ? (
                      <div className="order-crm-record__value">
                        <small>Joined</small>
                        <strong>{formatRequestDate(selectedApplication?.createdAt) || 'Added by HHH'}</strong>
                        <span className="order-crm-record__opened">{selectedApplication ? `Curaleaf form signed by ${selectedApplication.signatureName}` : 'No onboarding form on file'}</span>
                      </div>
                    ) : (
                      <div className="order-crm-record__value">
                        <small>Accrued fees</small>
                        <strong>{financeReady ? referralFeeFormatter.format(selectedFees?.total ?? 0) : 'Loading'}</strong>
                        <span className="order-crm-record__opened">{selectedFees ? `${selectedFees.patients} earning patient${selectedFees.patients === 1 ? '' : 's'}` : 'No fee events yet'}</span>
                      </div>
                    )}
                    <div className="order-crm-record__actions" role="group" aria-label="Pharmacy actions">
                      {selectedCanDecline ? (
                        <button type="button" className="btn btn-sm admin-decline-button" aria-expanded={declineOpen} onClick={() => setDeclineOpen(open => !open)}>Reject</button>
                      ) : null}
                      {selectedCanSuspend || selectedSuspended ? (
                        <button type="button" className={`btn btn-sm${selectedSuspended ? '' : ' admin-decline-button'}`} aria-expanded={suspendOpen} onClick={() => setSuspendOpen(open => !open)}>
                          {selectedSuspended ? 'Lift suspension' : 'Suspend'}
                        </button>
                      ) : null}
                      {selectedCanMarkNotAvailable || selectedNotAvailable ? (
                        <button type="button" className={`btn btn-sm${selectedNotAvailable ? '' : ' admin-decline-button'}`} aria-expanded={notAvailableOpen} onClick={() => setNotAvailableOpen(open => !open)}>
                          {selectedNotAvailable ? 'Clear Not available' : 'Not available'}
                        </button>
                      ) : null}
                      {selectedAwaiting ? null : <button type="button" className="btn btn-sm" onClick={() => { setFinanceOrganisationId(selectedPharmacy.id); setView('finance'); }}>Open ledger</button>}
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => goToSection('identity')}><Pencil size={13} /> Edit details</button>
                    </div>
                  </div>
                </header>

                <nav className="pharmacy-dashboard__nav" aria-label={`${selectedPharmacy.name} sections`}>
                  {PHARMACY_SECTIONS.map(section => (
                    <button
                      key={section.id}
                      type="button"
                      className={activeSection === section.id ? 'is-active' : undefined}
                      aria-current={activeSection === section.id ? 'location' : undefined}
                      onClick={() => goToSection(section.id)}
                    >
                      {section.label}
                    </button>
                  ))}
                </nav>
                <div className="patient-crm-detail__body pharmacy-dashboard">
                  {suspendOpen && (selectedCanSuspend || selectedSuspended) ? (
                    <SuspendPharmacyPanel
                      key={`${selectedPharmacy.id}-${selectedPharmacy.status}`}
                      organisationId={selectedPharmacy.id}
                      pharmacyName={selectedPharmacy.name}
                      suspended={selectedSuspended}
                      onCancel={() => setSuspendOpen(false)}
                      onDone={status => {
                        dispatch({ type: 'UPDATE_ORGANISATION', organisationId: selectedPharmacy.id, updates: { status } });
                        setSuspendOpen(false);
                        dispatch({
                          type: 'ADD_TOAST',
                          toastType: 'success',
                          message: status === 'paused'
                            ? `${selectedPharmacy.name} is suspended. Its staff are signed out and its eligibility link is off.`
                            : status === 'live'
                              ? `${selectedPharmacy.name} is live again.`
                              : `${selectedPharmacy.name}'s suspension is lifted. It is awaiting live Curaleaf credentials.`,
                        });
                      }}
                    />
                  ) : null}
                  {notAvailableOpen && (selectedCanMarkNotAvailable || selectedNotAvailable) ? (
                    <NotAvailablePanel
                      key={`${selectedPharmacy.id}-${selectedPharmacy.status}`}
                      organisationId={selectedPharmacy.id}
                      pharmacyName={selectedPharmacy.name}
                      notAvailable={selectedNotAvailable}
                      onCancel={() => setNotAvailableOpen(false)}
                      onDone={status => {
                        dispatch({
                          type: 'UPDATE_ORGANISATION',
                          organisationId: selectedPharmacy.id,
                          updates: { status, intakeEnabled: status !== 'not_available' },
                        });
                        setNotAvailableOpen(false);
                        dispatch({
                          type: 'ADD_TOAST',
                          toastType: 'success',
                          message: status === 'not_available'
                            ? `${selectedPharmacy.name} is Not available. Its staff are signed out and its eligibility link is off.`
                            : `${selectedPharmacy.name} is no longer Not available. Its eligibility link is open again.`,
                        });
                      }}
                    />
                  ) : null}
                  {declineOpen && selectedCanDecline ? (
                    <DeclinePharmacyPanel
                      key={selectedPharmacy.id}
                      organisationId={selectedPharmacy.id}
                      pharmacyName={selectedPharmacy.name}
                      email={selectedApplication?.pharmacyEmail || selectedPharmacy.pharmacyEmail || selectedPharmacy.mainContactEmail || null}
                      onCancel={() => setDeclineOpen(false)}
                      onDeclined={() => {
                        const name = selectedPharmacy.name;
                        dispatch({ type: 'SET_ORGANISATIONS', organisations: state.organisations.filter(organisation => organisation.id !== selectedPharmacy.id) });
                        setDeclineOpen(false);
                        setOverviewPharmacyId(null);
                        void pharmacyRequests.reload();
                        dispatch({ type: 'ADD_TOAST', message: `${name} was rejected and emailed the reason. It no longer appears in the overview.`, toastType: 'success' });
                      }}
                    />
                  ) : null}
                  {selectedAwaiting ? (
                    <ActivationChecklist
                      pharmacyName={selectedPharmacy.name}
                      request={selectedApplication}
                      worldpaySubmittedAt={selectedWorldpayForm}
                      curaleafEnvironment={selectedPharmacy.curaleafEnvironment ?? null}
                      curaleafCode={selectedPharmacy.curaleafPharmacyCode ?? null}
                      onEnterCredentials={() => goToSection('curaleaf')}
                    />
                  ) : null}
                  <section id="pharmacy-section-summary" className="pharmacy-dashboard__section admin-overview-manage-panel" aria-label="Overview">
                    <PharmacySummary
                      organisation={selectedPharmacy}
                      testPharmacy={isTrainingDirectoryPharmacy(selectedPharmacy)}
                      intakeLive={selectedIntakeLive}
                      worldpayFormSentAt={selectedWorldpayForm}
                      patients={{
                        inCare: selectedStages ? attributedInCare(selectedStages) : selectedPatients,
                        inCareLabel: selectedStages ? attributedCareLabel(selectedStages) : 'Attributed to this pharmacy',
                        declined: selectedStages ? selectedStages.declined : null,
                        note: selectedStages ? attributedClosedNote(selectedStages) : null,
                        status: selectedAttributionStatus === 'error' ? 'error' : selectedStages || selectedPatients != null ? 'ready' : 'loading',
                      }}
                      fees={selectedFees ?? null}
                      feesReady={financeReady}
                      formatMoney={amount => referralFeeFormatter.format(amount)}
                      onOpenPanel={goToSection}
                      period={performancePeriod}
                      onPeriodChange={setPerformancePeriod}
                    />
                    <GoLiveChecklistCard key={selectedPharmacy.id} organisationId={selectedPharmacy.id} />
                  </section>

                  <section id="pharmacy-section-identity" className="pharmacy-dashboard__section admin-overview-manage-panel" aria-labelledby="pharmacy-heading-identity">
                    <h3 id="pharmacy-heading-identity" className="pharmacy-dashboard__heading">Details</h3>
                    <PharmacyDetails
                      key={selectedPharmacy.id}
                      organisation={selectedPharmacy}
                      onSaved={updates => dispatch({ type: 'UPDATE_ORGANISATION', organisationId: selectedPharmacy.id, updates })}
                      curaleaf={(
                        <section id="pharmacy-section-curaleaf" className="pharmacy-details__card is-wide pharmacy-curaleaf-card" aria-labelledby="pharmacy-details-curaleaf">
                          <header>
                            <span className="pharmacy-details__icon" aria-hidden="true"><LockKeyhole size={16} /></span>
                            <h4 id="pharmacy-details-curaleaf">Curaleaf connection</h4>
                          </header>
                          <p className="pharmacy-details__note">The PHAR code and API key Curaleaf send. Live credentials take the pharmacy live; keys are stored server-side and never shown again.</p>
                          <CuraleafConnectionPanel
                          key={selectedPharmacy.id}
                          organisationId={selectedPharmacy.id}
                          customerIdHint={selectedPharmacy.curaleafPharmacyCode}
                          environmentHint={selectedPharmacy.curaleafEnvironment ?? null}
                          onConnection={connection => {
                            const code = connection?.customerId ?? null;
                            const environment = connection?.environment ?? null;
                            if (code === (selectedPharmacy.curaleafPharmacyCode ?? null) && environment === (selectedPharmacy.curaleafEnvironment ?? null)) return;
                            // The server takes the pharmacy live when live credentials are saved, and back
                            // to onboarding if a live one is given test credentials. Mirror that here.
                            const testPharmacy = isTrainingDirectoryPharmacy(selectedPharmacy);
                            const wentLive = !testPharmacy && environment === 'production' && selectedPharmacy.status !== 'live';
                            const leftLive = !testPharmacy && environment !== 'production' && selectedPharmacy.status === 'live';
                            dispatch({
                              type: 'UPDATE_ORGANISATION',
                              organisationId: selectedPharmacy.id,
                              updates: {
                                curaleafPharmacyCode: code ?? undefined,
                                curaleafEnvironment: environment,
                                ...(wentLive ? { status: 'live' as const, intakeEnabled: true } : {}),
                                ...(leftLive ? { status: 'onboarding' as const } : {}),
                              },
                            });
                            if (wentLive) {
                              // It leaves Awaiting Curaleaf, so follow it to All rather than jump away.
                              if (overviewFilter === 'requests') setOverviewFilter('all');
                              dispatch({ type: 'ADD_TOAST', message: `${selectedPharmacy.name} is live. Its eligibility link is on.`, toastType: 'success' });
                            }
                            if (leftLive) dispatch({ type: 'ADD_TOAST', message: `${selectedPharmacy.name} is back in onboarding: its Curaleaf credentials are for test.`, toastType: 'success' });
                          }}
                        />
                        </section>
                      )}
                      onToast={message => dispatch({ type: 'ADD_TOAST', message, toastType: 'success' })}
                      link={{ url: formUrl, loading: referralLinkLoading, error: referralLinkError, retry: () => setReferralLinkRefresh(value => value + 1) }}
                    />
                  </section>

                  <section id="pharmacy-section-staff" className="pharmacy-dashboard__section admin-overview-manage-panel" aria-labelledby="pharmacy-heading-staff">
                    <h3 id="pharmacy-heading-staff" className="pharmacy-dashboard__heading">Staff</h3>
                    <PharmacyStaffManager key={selectedPharmacy.id} organisation={selectedPharmacy} onCountChange={updateSelectedStaffCount} />
                  </section>

                </div>
              </article>
            )}
          </main>
        </div>
      </div>
    );
  };

  const renderLegacyReferrals = () => {
    const pending = state.submissions.filter(submission => submission.status === 'New' || submission.status === 'Under HHH review');
    const reviewed = state.submissions.filter(submission => submission.status === 'Approved' || isNegativeEligibilityStatus(submission.status));
    const referralCard = (submission: typeof state.submissions[number], section: 'queue' | 'history') => {
      const organisation = state.organisations.find(org => org.id === submission.organisationId);
      const recordsComplete = submission.recordsCheck?.status === 'completed' || submission.calls.length > 0;
      const referralComplete = !isNegativeEligibilityStatus(submission.status) && (submission.referral?.status === 'completed' || submission.status === 'Approved');
      const emailStatus = submission.emailDelivery?.status ?? 'not_sent';
      const openAction = (action: 'records' | 'complete' | 'decline' | 'email' | 'reason') => {
        setReferralNotes(action === 'records' ? submission.recordsCheck?.notes ?? '' : action === 'complete' || action === 'decline' ? submission.decisionNote ?? '' : '');
        setReferralPharmacyReason(action === 'reason' && !submission.pharmacyDecisionReasonNeedsReview ? submission.pharmacyDecisionReason ?? '' : '');
        setReferralError(null);
        setReferralDialog({ id: submission.id, organisationId: submission.organisationId, patientName: submission.name, action });
      };
      return (
        <article className={`admin-referral-item admin-referral-item--${section}`} key={submission.id}>
          <div className="admin-referral-item__identity">
            <CompactPatientCell name={submission.name} email={submission.email} mobile={submission.mobile} dob={submission.dob} />
            <div className="admin-referral-item__pharmacy">
              <span className="admin-referral-item__label">Attributed pharmacy</span>
              <strong>{organisation?.name ?? submission.pharmacyName}</strong>
              <small>Token-attributed record</small>
            </div>
          </div>

          <div className="admin-referral-item__screening">
            <span className="admin-referral-item__label">Screening summary</span>
            <ConditionList conditions={submission.conditions} primaryCondition={submission.primaryCondition} />
            <small>{submission.tried2 ? 'Two treatments reported' : 'Treatment history requires review'} · {submission.psychExclusion ? 'Exclusion flagged' : 'No psychosis exclusion reported'}</small>
          </div>

          <div className="admin-referral-item__workflow">
            <div>
              <span className="admin-referral-item__label">Call / check</span>
              <strong>{recordsComplete ? 'Completed' : 'Pending'}</strong>
              <small>{submission.recordsCheck?.completedAt ? new Date(submission.recordsCheck.completedAt).toLocaleDateString('en-GB') : recordsComplete ? 'Recorded in the audit trail' : 'Patient call and records check required'}</small>
            </div>
            <div>
              <span className="admin-referral-item__label">Referral</span>
              <div className="onboarding-status-stack"><span className={`pill onboarding-status-pill ${onboardingStatusPillClass(submission.status)}`}>{onboardingStatusLabel(submission.status)}</span>{submission.reviewerDisplay && <small>{submission.reviewerDisplay} · {submission.reviewedAt ? new Date(submission.reviewedAt).toLocaleDateString('en-GB') : ''}</small>}</div>
            </div>
            {isNegativeEligibilityStatus(submission.status) && <div className="admin-referral-item__pharmacy-reason"><span className="admin-referral-item__label">Pharmacy-facing reason</span><strong>{pharmacyDecisionReason(submission)}</strong>{submission.pharmacyDecisionReasonNeedsReview && <small><AlertCircle size={12} /> Legacy fallback — HHH review required</small>}</div>}
          </div>

          <div className="admin-referral-actions" aria-label={`Actions for ${submission.name}`}>
            {!recordsComplete && <button className="btn btn-sm" onClick={() => openAction('records')}><PhoneCall size={13} /> Log call / records check</button>}
            {!referralComplete && !isNegativeEligibilityStatus(submission.status) && <button className="btn btn-sm btn-primary" disabled={!recordsComplete} onClick={() => openAction('complete')}><UserCheck size={13} /> Complete referral</button>}
            {!referralComplete && !isNegativeEligibilityStatus(submission.status) && <button className="btn btn-sm" disabled={!recordsComplete} onClick={() => openAction('decline')}><UserX size={13} /> Decline</button>}
            {isNegativeEligibilityStatus(submission.status) && <button className="btn btn-sm" onClick={() => openAction('reason')}><Pencil size={13} /> {submission.pharmacyDecisionReasonNeedsReview ? 'Review pharmacy reason' : 'Edit pharmacy reason'}</button>}
            {referralComplete && emailStatus === 'not_sent' && <button className="btn btn-sm btn-primary" onClick={() => openAction('email')}><ExternalLink size={13} /> Send email</button>}
            {referralComplete && emailStatus !== 'not_sent' && <span className={`pill ${emailStatus === 'failed' ? 'pill-red' : 'pill-green'}`}>Email {emailStatus.replace('_', ' ')}</span>}
          </div>
        </article>
      );
    };
    return (
      <>
        <AdminIntakeV2 onOpenRecord={openRegisterRecord} summarySlot={headerSummary} onFreshChange={setFreshIntakeCount} />
        <section className="integration-boundary card"><ShieldCheck size={20} /><div><strong>HHH referral boundary</strong><p>The current assigned pharmacy can see this enquiry. Completing referral above marks them referred for that pharmacy. This does not diagnose, prescribe, replace a doctor’s prescription, or replace the pharmacy’s legal and professional checks before dispensing.</p></div></section>
        <section className="card admin-referral-section">
          <div className="admin-directory-head"><div><p className="section-label">Legacy compatibility</p><h2>Previous-form applications</h2><p>Only schema-v1 applications use this older workflow. New main-site and dedicated-link cases are managed in the HHH intake workspace above.</p></div><span className="pill pill-amber">{pending.length} waiting</span></div>
          {pending.length ? <div className="admin-referral-list">{pending.map(submission => referralCard(submission, 'queue'))}</div> : <div className="empty-state">No onboarding decisions are waiting.</div>}
        </section>
        <section className="card admin-referral-section admin-referral-section--history">
          <div className="admin-directory-head"><div><p className="section-label">Legacy audit trail</p><h2>Previous-form decision history</h2><p>Historic v1 decisions remain available without changing their records or issued links.</p></div><span className="pill pill-neutral">{reviewed.length} recorded</span></div>
          {reviewed.length ? <div className="admin-referral-list">{reviewed.map(submission => referralCard(submission, 'history'))}</div> : <div className="empty-state">No decisions have been recorded.</div>}
        </section>
      </>
    );
  };

  // Kept out of the rendered production surface while historic v1 rows remain
  // readable through the SQL admin intake projection.
  void renderLegacyReferrals;

  // A duplicate's real record lives in the register: clear the filters that
  // could hide it, then select it once the register has loaded.
  const openRegisterRecord = (match: DuplicateRecordMatch) => {
    setQuery('');
    setPatientOrganisationId('all');
    setPatientStatus('all');
    setPatientFrom('');
    setPatientTo('');
    setPendingRegisterKey(`${match.organisationId ?? ''}:${match.kind === 'patient' ? match.id : `sub-${match.id}`}`);
    setView('patients');
  };

  const renderReferrals = () => <AdminIntakeV2 onOpenRecord={openRegisterRecord} summarySlot={headerSummary} onFreshChange={setFreshIntakeCount} />;

  const renderPatients = () => {
    const activeCount = stageCounts['HHH approved'] ?? 0;
    const referredCount = stageCounts.Referred ?? 0;
    const financeReady = isLocalPortalPreview || Boolean(adminFinanceReport) || !adminFinanceLoading;
    const registerAccrued = referralFeeEvents.reduce((total, event) => total + event.amount, 0);
    const selectedKey = selectedRegisterPatient ? registerRowKey(selectedRegisterPatient) : null;
    const selectedFees = selectedRegisterPatient
      ? referralFeeEvents.filter(event => event.organisationId === selectedRegisterPatient.organisationId && event.patientEmail.trim().toLowerCase() === selectedRegisterPatient.email.trim().toLowerCase())
      : [];
    const selectedFeeTotal = selectedFees.reduce((total, event) => total + event.amount, 0);
    const selectedIntake = selectedRegisterPatient
      ? state.submissions.find(submission => submission.organisationId === selectedRegisterPatient.organisationId && submission.email.trim().toLowerCase() === selectedRegisterPatient.email.trim().toLowerCase())
      : null;
    const selectedCrm = selectedRegisterPatient
      ? state.crm.find(patient => patient.organisationId === selectedRegisterPatient.organisationId && patient.email.trim().toLowerCase() === selectedRegisterPatient.email.trim().toLowerCase())
      : null;
    const orderPatientId = selectedCrm?.id ?? (selectedRegisterPatient && !selectedRegisterPatient.id.startsWith('sub-') ? selectedRegisterPatient.id : null);
    const orderActivity = selectedRegisterPatient
      ? patientOrderActivity(state.orders, selectedRegisterPatient.organisationId, orderPatientId)
      : { count: 0, dates: [], uniqueDays: [] };
    const selectedTone = selectedRegisterPatient ? stageTone(selectedRegisterPatient.stage) : 'info';
    const selectedPharmacy = selectedRegisterPatient
      ? state.organisations.find(item => item.id.replaceAll('-', '').toLowerCase() === selectedRegisterPatient.organisationId.replaceAll('-', '').toLowerCase()) ?? null
      : null;
    const selectedPharmacyPostcode = selectedPharmacy?.postcode?.trim() || null;
    const firstDispenseFees = selectedFees.filter(event => event.kind === 'new-referral');
    const annualFees = selectedFees.filter(event => event.kind === 'annual-patient');
    const selectedRetention = selectedRegisterPatient
      ? clinicRetention(state.orders, selectedRegisterPatient.organisationId, orderPatientId, retentionWindows)
      : null;
    // A closed application has no patient row to edit; only patient records can be corrected.
    const selectedCanEditDetails = Boolean(selectedRegisterPatient && selectedRegisterPatient.editable !== false && !selectedRegisterPatient.id.startsWith('sub-'));
    const selectedNameParts = (selectedRegisterPatient?.name ?? '').trim().split(/\s+/);
    const selectedDetailsDraft = {
      firstName: selectedRegisterPatient?.firstName ?? (selectedNameParts.length > 1 ? selectedNameParts.slice(0, -1).join(' ') : selectedNameParts[0] ?? ''),
      surname: selectedRegisterPatient?.surname ?? (selectedNameParts.length > 1 ? selectedNameParts.at(-1)! : ''),
      dob: selectedRegisterPatient?.dob ?? '',
      email: selectedRegisterPatient?.email ?? '',
      mobile: selectedRegisterPatient?.mobile ?? '',
      postcode: selectedRegisterPatient?.postcode ?? '',
    };
    const openSelectedLedger = () => {
      if (!selectedRegisterPatient) return;
      setFinanceOrganisationId(selectedRegisterPatient.organisationId);
      setFinancePatientKey(selectedFees[0]?.patientKey ?? 'all');
      setFinancePeriod('all');
      setView('finance');
    };
    // Only a real patient row can be rewritten. A register entry that is still
    // only an intake submission has no patient record to edit yet.
    const adminConditionPatientId = selectedCrm?.id
      ?? (selectedRegisterPatient && !selectedRegisterPatient.id.startsWith('sub-') ? selectedRegisterPatient.id : null);
    // A referred application has left the intake queue and HHH admin cannot read
    // the pharmacy directory, so the register row itself carries the conditions.
    // An empty list is "nothing known here", not "none": keep looking.
    const adminConditions = [selectedCrm?.conditions, selectedIntake?.conditions, selectedRegisterPatient?.conditions]
      .find(candidate => candidate && candidate.length > 0) ?? [];
    const adminPrimaryCondition = selectedCrm?.primaryCondition ?? selectedIntake?.primaryCondition ?? selectedRegisterPatient?.primaryCondition ?? adminConditions[0] ?? '';
    // Pharmacy and dates live behind Filters; the button shows how many are set. Test patients are the ghost toggle.
    const extraFilterCount = [patientOrganisationId !== 'all', Boolean(patientFrom), Boolean(patientTo)].filter(Boolean).length;
    const filtersActive = Boolean(query.trim() || patientOrganisationId !== 'all' || patientStatus !== 'all' || patientFrom || patientTo || !hideTestPatients);
    // One sentence that says what the list holds, so nobody has to work it
    // out from the state of six controls.
    const scopePharmacy = patientOrganisationId === 'all' ? null : (state.organisations.find(item => item.id === patientOrganisationId)?.name ?? 'the selected pharmacy');
    const stageNoun = patientStatus === 'all' ? 'record' : `${onboardingStatusLabel(patientStatus)} record`;
    const scopeDetail = [
      scopePharmacy ? `at ${scopePharmacy}` : 'across all pharmacies',
      patientFrom && patientTo ? `last updated ${formatUkDayDate(patientFrom)} to ${formatUkDayDate(patientTo)}`
        : patientFrom ? `last updated on or after ${formatUkDayDate(patientFrom)}`
        : patientTo ? `last updated on or before ${formatUkDayDate(patientTo)}` : null,
      query.trim() ? `matching “${query.trim()}”` : null,
      hideTestPatients ? 'test patients hidden' : 'test patients included',
    ].filter(Boolean).join(' · ');

    return (
      <div className="page-body order-crm patient-crm admin-register-crm">
        {headerSummary ? createPortal(
        <section className="order-crm-summary" aria-label="Patient register summary">
          <div className="order-crm-summary__tiles">
            <article className="order-crm-metric">
              <span className="order-crm-metric__icon"><Users size={16} /></span>
              <span><small>Register</small><strong>{scopeTotal}</strong><em>Every stage in the current scope</em></span>
            </article>
            <article className="order-crm-metric">
              <span className="order-crm-metric__icon"><UserCheck size={16} /></span>
              <span><small>Active</small><strong>{activeCount}</strong><em>HHH-approved patient records</em></span>
            </article>
            <article className="order-crm-metric">
              <span className="order-crm-metric__icon"><ClipboardCheck size={16} /></span>
              <span><small>Referred</small><strong>{referredCount}</strong><em>Approved for a destination pharmacy</em></span>
            </article>
            <article className="order-crm-metric">
              <span className="order-crm-metric__icon"><PoundSterling size={16} /></span>
              <span>
                <small>Accrued fees</small>
                <strong>{financeReady ? referralFeeFormatter.format(registerAccrued) : 'Loading'}</strong>
                <em>{adminFinanceError ? 'Ledger unavailable' : 'First dispense £50 · annual £40'}</em>
              </span>
            </article>
          </div>
        </section>,
          headerSummary,
        ) : null}

        <section className="order-crm-controls admin-filter-bar">
          <div className="admin-filter-bar__top">
            <div className="order-crm-search">
              <Search size={15} />
              <input
                type="search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="Search patient, date of birth or pharmacy"
                aria-label="Search the patient register"
              />
            </div>
            <button
              type="button"
              className={`btn btn-sm admin-filter-bar__ghost${hideTestPatients ? '' : ' is-on'}`}
              aria-pressed={!hideTestPatients}
              aria-label={hideTestPatients ? 'Show test patients' : 'Hide test patients'}
              title={hideTestPatients ? 'Test patients are hidden. Click to show them.' : 'Test patients are shown. Click to hide them.'}
              onClick={() => setHideTestPatients(value => !value)}
            >
              <Ghost size={15} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`btn btn-sm admin-filter-bar__filters${extraFilterCount ? ' is-on' : ''}`}
              aria-expanded={patientFiltersOpen}
              aria-controls="admin-register-more-filters"
              onClick={() => setPatientFiltersOpen(open => !open)}
            >
              <SlidersHorizontal size={14} aria-hidden="true" /> Filters{extraFilterCount ? <b>{extraFilterCount}</b> : null}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void exportPatients()}
              disabled={patientExportBusy || patientRegisterLoading || (!isLocalPortalPreview && !serverPatientRegister)}
            >
              <Download size={14} /> {patientExportBusy ? 'Preparing…' : patientRegisterLoading ? 'Loading…' : 'Export CSV'}
            </button>
          </div>
          <div className="order-crm-filters" role="group" aria-label="Filter the patient register by stage">
            <button type="button" className={patientStatus === 'all' ? 'active' : ''} aria-pressed={patientStatus === 'all'} onClick={() => setPatientStatus('all')}>
              <span>All stages</span><strong>{scopeTotal}</strong>
            </button>
            {REGISTER_STAGES.map(stage => (
              <button type="button" key={stage} className={patientStatus === stage ? 'active' : ''} aria-pressed={patientStatus === stage} onClick={() => setPatientStatus(stage)}>
                <span>{onboardingStatusLabel(stage)}</span><strong>{stageCounts[stage] ?? 0}</strong>
              </button>
            ))}
          </div>
          {patientFiltersOpen ? (
            <div id="admin-register-more-filters" className="admin-filter-bar__more" role="group" aria-label="More filters">
              <label className="admin-register-crm__select">
                <small>Pharmacy</small>
                <select value={patientOrganisationId} onChange={event => setPatientOrganisationId(event.target.value)} aria-label="Filter by pharmacy">
                  <option value="all">All pharmacies</option>
                  {state.organisations.map(organisation => <option key={organisation.id} value={organisation.id}>{organisation.name}</option>)}
                </select>
              </label>
              <label className="admin-register-crm__date">
                <small>Last updated from</small>
                <input type="date" value={patientFrom} max={patientTo || undefined} onChange={event => setPatientFrom(event.target.value)} aria-label="Last updated from" />
              </label>
              <label className="admin-register-crm__date">
                <small>Last updated to</small>
                <input type="date" value={patientTo} min={patientFrom || undefined} onChange={event => setPatientTo(event.target.value)} aria-label="Last updated to" />
              </label>
              {filtersActive ? (
                <button type="button" className="btn btn-sm admin-filter-bar__clear" onClick={() => { setQuery(''); setPatientOrganisationId('all'); setPatientStatus('all'); setPatientFrom(''); setPatientTo(''); setHideTestPatients(true); }}>
                  Clear all
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
        <p className="admin-register-crm__scope" aria-live="polite">
          {patientRegisterLoading && !isLocalPortalPreview
            ? 'Loading the register for this scope…'
            : <>Showing <strong>{displayedPatients.length}</strong> {stageNoun}{displayedPatients.length === 1 ? '' : 's'}{patientStatus === 'all' ? '' : ` of ${scopeTotal} in scope`} {scopeDetail}.</>}
        </p>

        {patientExportError ? <div className="banner banner-red" role="alert"><AlertCircle size={16} /> {patientExportError}</div> : null}
        {adminFinanceError ? (
          <div className="banner banner-amber" role="alert">
            <AlertCircle size={16} />
            <span><strong>Referral finance is temporarily unavailable</strong><small>{adminFinanceError}</small></span>
            <button className="btn btn-sm" type="button" onClick={() => setAdminFinanceRefresh(value => value + 1)}>Try again</button>
          </div>
        ) : null}

        <div className="order-crm-workspace">
          <aside className="order-crm-list" aria-label="Patient register">
            <header>
              <span><small>{patientStatus === 'all' ? 'All stages' : onboardingStatusLabel(patientStatus)}</small><strong>{patientRegisterLoading && !isLocalPortalPreview ? 'Loading' : patientStatus === 'all' ? `${displayedPatients.length} record${displayedPatients.length === 1 ? '' : 's'}` : `${displayedPatients.length} of ${scopeTotal}`}</strong></span>
            </header>
            <div className="order-crm-list__scroller">
              <div className="order-crm-list__rows">
                {patientRegisterLoading && !isLocalPortalPreview && displayedPatients.length === 0 ? (
                  <div className="order-crm-empty">
                    <Users size={26} />
                    <strong>Loading register</strong>
                    <span>The protected patient register is being loaded for this scope.</span>
                  </div>
                ) : displayedPatients.length === 0 ? (
                  <div className="order-crm-empty">
                    <Users size={26} />
                    <strong>No {stageNoun}s match</strong>
                    <span>Try another search, stage or filter{hideTestPatients ? ', or use the ghost button to show test patients' : ''}.</span>
                  </div>
                ) : displayedPatients.map(patient => {
                  const row = toRegisterRow(patient);
                  const tone = stageTone(row.stage);
                  const selected = selectedKey === registerRowKey(row);
                  return (
                    <button
                      type="button"
                      key={registerRowKey(row)}
                      className={`order-crm-row order-crm-row--${tone}${selected ? ' selected' : ''}`}
                      aria-pressed={selected}
                      aria-label={`${row.name}, ${onboardingStatusLabel(row.stage)}, ${row.pharmacyName}`}
                      onClick={() => setSelectedRegisterPatient(row)}
                    >
                      <span className={`order-crm-row__stage order-tone--${tone}`} aria-hidden="true">{patientInitials(row.name)}</span>
                      <span className="order-crm-row__identity">
                        <strong title={row.name}>{compactPatientName(row.name)}</strong>
                        <span className={`order-stage-pill order-tone--${tone}`}>{onboardingStatusLabel(row.stage)}</span>
                      {(() => {
                        const retention = clinicRetention(state.orders, row.organisationId, row.id.startsWith('sub-') ? null : row.id, retentionWindows);
                        return retention ? <small>Inferred from prescriptions · {retention.status}</small> : null;
                      })()}
                      </span>
                      <span className="order-crm-row__position">
                        <strong>{row.pharmacyName}</strong>
                        <small>{row.date ? new Date(row.date).toLocaleDateString('en-GB', { timeZone: 'Europe/London' }) : 'No date'}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>

          <main className="order-crm-detail">
            {!selectedRegisterPatient ? (
              <div className="order-crm-empty order-crm-empty--detail">
                <Users size={38} />
                <strong>Select a patient</strong>
                <span>Identity, attribution and fee history appear here. Contact details stay on the selected record only.</span>
              </div>
            ) : (
              <article className={`order-crm-record order-crm-record--${selectedTone}`}>
                <header className="order-crm-record__header">
                  <div className="order-crm-record__hero">
                    <div className="order-crm-record__identity">
                      <span className={`order-crm-record__stage order-tone--${selectedTone}`} aria-hidden="true">{patientInitials(selectedRegisterPatient.name)}</span>
                      <div className="order-crm-record__titles">
                        <strong>{selectedRegisterPatient.name}</strong>
                        <span className="order-crm-record__ref">DOB {formatPatientDob(selectedRegisterPatient.dob)}</span>
                        <em>{selectedRegisterPatient.pharmacyName}{selectedPharmacyPostcode ? ` · ${selectedPharmacyPostcode}` : ''}</em>
                      </div>
                    </div>
                    <span className={`order-stage-pill order-tone--${selectedTone}`}>{onboardingStatusLabel(selectedRegisterPatient.stage)}</span>
                  </div>
                  <div className="order-crm-record__toolbar">
                    <div className="order-crm-record__value">
                      <small>Accrued fees</small>
                      <strong>{financeReady ? referralFeeFormatter.format(selectedFeeTotal) : 'Loading'}</strong>
                      <span className="order-crm-record__opened">{selectedFees.length ? `${selectedFees.length} fee event${selectedFees.length === 1 ? '' : 's'}` : 'No fee events yet'}</span>
                    </div>
                    <div className="order-crm-record__actions" role="group" aria-label="Patient record actions">
                      <button type="button" className="btn btn-sm" onClick={openSelectedLedger}>Open ledger</button>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => openPharmacyOnOverview(selectedRegisterPatient.organisationId, 'identity')}>Manage pharmacy</button>
                    </div>
                  </div>
                </header>

                <RecordSectionNav sections={PATIENT_SECTIONS} active={patientSection} onSelect={goToPatientSection} className="admin-patient-nav" label={`${selectedRegisterPatient.name} sections`} />

                <div className="patient-crm-detail__body pharmacy-dashboard admin-intake-record">
                  <section id="patient-section-overview" className="pharmacy-dashboard__section" aria-label="Overview">
                    <div className="pharmacy-summary__metrics admin-patient-glance">
                      <div className="pharmacy-summary__metric">
                        <small>Stage</small>
                        <strong>{onboardingStatusLabel(selectedRegisterPatient.stage)}</strong>
                        <span>{selectedIntake ? `Came in through ${selectedIntake.source}` : selectedCrm ? 'Patient record' : 'Register entry'}</span>
                      </div>
                      <div className="pharmacy-summary__metric">
                        <small>Last recorded</small>
                        <strong>{selectedRegisterPatient.date ? formatUkDayDate(londonDateKey(selectedRegisterPatient.date) ?? '') : 'None'}</strong>
                        <span>Latest change on the record</span>
                      </div>
                      <div className="pharmacy-summary__metric">
                        <small>Referral fees</small>
                        <strong>{financeReady ? referralFeeFormatter.format(selectedFeeTotal) : '…'}</strong>
                        <span>{firstDispenseFees.length} × £50 · {annualFees.length} × £40</span>
                      </div>
                      <div className="pharmacy-summary__metric">
                        <small>Orders</small>
                        <strong>{orderActivity.count}</strong>
                        <span>{orderActivity.count ? `Last ${londonDayLabel(orderActivity.dates[0])}` : 'None placed yet'}</span>
                      </div>
                    </div>
                    {selectedRetention ? (
                      <RecordCard icon={TrendingUp} title="Retention" subtitle="Inferred from prescriptions" tag={<span className="order-stage-pill order-tone--info">{selectedRetention.status}</span>}>
                        <p className="admin-intake-note">Check this against the clinic’s own appointment records before anything is invoiced. Windows met: {selectedRetention.met.join(', ') || 'none yet'}.</p>
                        <label className="admin-intake-form admin-patient-window">One-month window ends on day
                          <input className="input" type="number" min="21" value={retentionWindows.w2EndDay} onChange={event => {
                            const next = { ...retentionWindows, w2EndDay: Number(event.target.value) };
                            setRetentionWindows(next);
                            localStorage.setItem('hhh.retention.windows', JSON.stringify(next));
                          }} />
                        </label>
                      </RecordCard>
                    ) : null}
                  </section>

                  <section id="patient-section-patient" className="pharmacy-dashboard__section" aria-labelledby="patient-heading-patient">
                    <h3 id="patient-heading-patient" className="pharmacy-dashboard__heading">Patient</h3>
                    <div className="pharmacy-details">
                      <RecordCard
                        icon={UserCheck}
                        title="Contact"
                        subtitle={editingPatientDetails ? 'Editing the patient’s details' : undefined}
                        tag={selectedCanEditDetails && !editingPatientDetails
                          ? <button type="button" className="btn btn-sm" onClick={() => setEditingPatientDetails(true)}><Pencil size={13} /> Edit</button>
                          : undefined}
                      >
                        {editingPatientDetails && selectedCanEditDetails ? (
                          <PatientDetailsForm
                            key={selectedRegisterKey ?? ''}
                            save={details => updateAdminPatientDetails(selectedRegisterPatient.id, { organisationId: selectedRegisterPatient.organisationId, ...details })}
                            initial={selectedDetailsDraft}
                            onCancel={() => setEditingPatientDetails(false)}
                            onSaved={(saved, changed) => {
                              const update: Partial<PatientRegisterExportRow> = { ...saved, name: `${saved.firstName} ${saved.surname}`.trim() };
                              setRegisterEdits(current => ({ ...current, [registerRowKey(selectedRegisterPatient)]: { ...current[registerRowKey(selectedRegisterPatient)], ...update } }));
                              setSelectedRegisterPatient(current => current ? { ...current, ...update } : current);
                              setEditingPatientDetails(false);
                              dispatch({ type: 'ADD_TOAST', toastType: 'success', dedupeKey: 'patient-details', message: changed.length ? `${update.name}’s details are updated.` : 'Nothing changed.' });
                            }}
                          />
                        ) : (
                          <dl className="pharmacy-details__list">
                            <CopyFact label="Name" value={selectedRegisterPatient.name} />
                            <CopyFact label="Date of birth" value={selectedRegisterPatient.dob ? formatPatientDob(selectedRegisterPatient.dob) : null} />
                            <CopyFact label="Email" value={selectedRegisterPatient.email} />
                            <CopyFact label="Mobile" value={selectedRegisterPatient.mobile} />
                            <CopyFact label="Postcode" value={selectedRegisterPatient.postcode} />
                          </dl>
                        )}
                        {!selectedCanEditDetails ? <p className="admin-intake-note">This is a closed application, so its details cannot be edited.</p> : null}
                      </RecordCard>
                      <RecordCard
                        icon={Building2}
                        title={selectedRegisterPatient.pharmacyName}
                        subtitle={[selectedRegisterPatient.gphcNumber ? `GPhC ${selectedRegisterPatient.gphcNumber}` : null, selectedPharmacyPostcode].filter(Boolean).join(' · ') || 'Attributed pharmacy'}
                        tag={<button type="button" className="btn btn-sm" onClick={() => openPharmacyOnOverview(selectedRegisterPatient.organisationId, 'identity')}>Manage</button>}
                      >
                        <dl className="pharmacy-details__list">
                          <CopyFact label="GPhC" value={selectedRegisterPatient.gphcNumber} />
                          <CopyFact label="Postcode" value={selectedPharmacyPostcode} />
                          <CopyFact label="Phone" value={selectedPharmacy?.pharmacyPhone || selectedPharmacy?.mainContactPhone} />
                          <CopyFact label="Email" value={selectedPharmacy?.pharmacyEmail || selectedPharmacy?.mainContactEmail} />
                        </dl>
                      </RecordCard>
                    </div>
                  </section>

                  {/* Admin edits go through the same service as the pharmacy's own
                      Edit conditions, so the register and the Portal cannot end up
                      showing a patient two different condition lists. */}
                  <section id="patient-section-conditions" className="pharmacy-dashboard__section" aria-labelledby="patient-heading-conditions">
                    <h3 id="patient-heading-conditions" className="pharmacy-dashboard__heading">Conditions</h3>
                    <RecordCard
                      icon={ClipboardCheck}
                      title={adminConditions.length ? `${adminConditions.length} condition${adminConditions.length === 1 ? '' : 's'}` : 'No conditions'}
                      subtitle={adminConditionPatientId ? 'Shared with the pharmacy’s own record' : 'From the patient’s eligibility answers'}
                      tag={adminConditionPatientId && !editingAdminConditions
                        ? <button type="button" className="btn btn-sm" onClick={() => { setAdminConditionError(null); setEditingAdminConditions(true); }}><Pencil size={13} /> Edit</button>
                        : undefined}
                    >
                      {adminConditionPatientId && editingAdminConditions ? (
                        <ConditionEditor
                          conditions={adminConditions}
                          primaryCondition={adminPrimaryCondition}
                          saving={savingAdminConditions}
                          error={adminConditionError}
                          onCancel={() => { setEditingAdminConditions(false); setAdminConditionError(null); }}
                          onSave={(conditionCodes, primaryConditionCode) => void saveAdminConditions(
                            adminConditionPatientId,
                            selectedRegisterPatient.organisationId,
                            conditionCodes,
                            primaryConditionCode,
                          )}
                        />
                      ) : adminConditions.length ? (
                        <ConditionList conditions={adminConditions} primaryCondition={adminPrimaryCondition || adminConditions[0]} />
                      ) : (
                        <p className="admin-intake-note">{adminConditionPatientId ? 'No conditions recorded for this patient.' : 'No conditions were given on this application.'}</p>
                      )}
                      {!adminConditionPatientId ? <p className="admin-intake-note">They can be edited once the referral creates the patient record.</p> : null}
                    </RecordCard>
                  </section>

                  <section id="patient-section-fees" className="pharmacy-dashboard__section" aria-labelledby="patient-heading-fees">
                    <h3 id="patient-heading-fees" className="pharmacy-dashboard__heading">Fees</h3>
                    <RecordCard
                      icon={PoundSterling}
                      title={financeReady ? referralFeeFormatter.format(selectedFeeTotal) : 'Loading'}
                      subtitle="First collected dispense £50 · each active anniversary £40"
                      tag={<button type="button" className="btn btn-sm" onClick={openSelectedLedger}>Open ledger</button>}
                    >
                      {selectedFees.length === 0 ? (
                        <p className="admin-intake-note">No fees yet. The first one accrues when the patient collects their first dispense.</p>
                      ) : (
                        <ol className="admin-register-crm__events admin-patient-fees">
                          {selectedFees.map(event => (
                            <li key={event.id}>
                              <span>
                                <strong>{event.kind === 'new-referral' ? 'First collected dispense' : event.anniversary ? `Annual fee · year ${event.anniversary}` : 'Annual patient fee'}</strong>
                                <small>{event.occurredAt.toLocaleDateString('en-GB', { timeZone: 'Europe/London' })} · {event.pharmacyName}</small>
                              </span>
                              <b>{referralFeeFormatter.format(event.amount)}</b>
                            </li>
                          ))}
                        </ol>
                      )}
                    </RecordCard>
                  </section>

                  <section id="patient-section-orders" className="pharmacy-dashboard__section" aria-labelledby="patient-heading-orders">
                    <h3 id="patient-heading-orders" className="pharmacy-dashboard__heading">Orders</h3>
                    <RecordCard icon={Package} title={orderActivity.count ? `${orderActivity.count} order${orderActivity.count === 1 ? '' : 's'} placed` : 'No orders yet'} subtitle="HHH sees when orders were placed, not what was ordered">
                      {orderActivity.count ? (
                        <>
                          <dl className="pharmacy-details__list">
                            <Fact label="Last ordered">{londonDayLabel(orderActivity.dates[0])}</Fact>
                          </dl>
                          <ul className="admin-patient-days" aria-label="Order days">
                            {(orderActivity.uniqueDays ?? []).slice(0, 12).map(day => <li key={day}>{day}</li>)}
                            {(orderActivity.uniqueDays ?? []).length > 12 ? <li>+{(orderActivity.uniqueDays ?? []).length - 12} earlier</li> : null}
                          </ul>
                        </>
                      ) : <p className="admin-intake-note">The pharmacy has not placed an order for this patient.</p>}
                    </RecordCard>
                  </section>
                </div>
              </article>
            )}
          </main>
        </div>
      </div>
    );
  };

  const renderFinance = () => {
    const newReferralEvents = filteredReferralFeeEvents.filter(event => event.kind === 'new-referral');
    const annualEvents = filteredReferralFeeEvents.filter(event => event.kind === 'annual-patient');
    const totalAccrued = filteredReferralFeeEvents.reduce((total, event) => total + event.amount, 0);
    const patientsWithFees = new Set(filteredReferralFeeEvents.map(event => event.patientKey)).size;
    const financeReady = isLocalPortalPreview || Boolean(adminFinanceReport) || !adminFinanceLoading;
    const selectedFinancePatient = visibleFinancePatients.find(patient => patient.key === financePatientKey) ?? null;
    const selectedFinanceEvents = selectedFinancePatient
      ? filteredReferralFeeEvents.filter(event => event.patientKey === selectedFinancePatient.key)
      : [];
    const selectedFirst = selectedFinanceEvents.filter(event => event.kind === 'new-referral');
    const selectedAnnual = selectedFinanceEvents.filter(event => event.kind === 'annual-patient');
    const selectedPharmacy = selectedFinancePatient
      ? state.organisations.find(organisation => organisation.id === selectedFinancePatient.organisationId)
      : null;
    const periodLabel = financePeriod === 'month' ? financeMonth : financePeriod === 'year' ? financeYear : 'All time';
    // The next £40 falls on the next anniversary of the first collected dispense.
    const selectedFirstEver = selectedFinancePatient
      ? referralFeeEvents.find(event => event.patientKey === selectedFinancePatient.key && event.kind === 'new-referral')?.occurredAt ?? null
      : null;
    const selectedNextAnniversary = (() => {
      if (!selectedFirstEver) return null;
      const today = new Date();
      for (let years = 1; years <= 100; years += 1) {
        const next = referralAnniversary(selectedFirstEver, years);
        if (next > today) return next;
      }
      return null;
    })();

    return (
      <div className="page-body order-crm patient-crm admin-finance-crm">
        {headerSummary ? createPortal(
        <section className="order-crm-summary" aria-label="Referral finance summary">
          <div className="order-crm-summary__tiles">
            <article className="order-crm-metric">
              <span className="order-crm-metric__icon"><PoundSterling size={16} /></span>
              <span>
                <small>Total accrued</small>
                <strong>{financeReady ? referralFeeFormatter.format(totalAccrued) : 'Loading'}</strong>
                <em>{filteredReferralFeeEvents.length} fee event{filteredReferralFeeEvents.length === 1 ? '' : 's'} · {periodLabel}</em>
              </span>
            </article>
            <article className="order-crm-metric">
              <span className="order-crm-metric__icon"><TrendingUp size={16} /></span>
              <span>
                <small>First dispenses</small>
                <strong>{financeReady ? referralFeeFormatter.format(newReferralEvents.reduce((sum, event) => sum + event.amount, 0)) : 'Loading'}</strong>
                <em>{newReferralEvents.length} × £50</em>
              </span>
            </article>
            <article className="order-crm-metric">
              <span className="order-crm-metric__icon"><CheckCircle2 size={16} /></span>
              <span>
                <small>Annual fees</small>
                <strong>{financeReady ? referralFeeFormatter.format(annualEvents.reduce((sum, event) => sum + event.amount, 0)) : 'Loading'}</strong>
                <em>{annualEvents.length} × £40</em>
              </span>
            </article>
            <article className="order-crm-metric">
              <span className="order-crm-metric__icon"><Users size={16} /></span>
              <span>
                <small>Earning patients</small>
                <strong>{patientsWithFees}</strong>
                <em>Patients with accrued fees in this period</em>
              </span>
            </article>
          </div>
        </section>,
          headerSummary,
        ) : null}

        <section className="order-crm-controls admin-filter-bar">
          <div className="admin-filter-bar__top admin-filter-bar__top--finance">
            <div className="order-crm-search">
              <Search size={15} />
              <input
                type="search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="Search earning patient or pharmacy"
                aria-label="Search earning patients"
              />
            </div>
            <label className="admin-filter-bar__select">
              <span className="sr-only">Pharmacy</span>
              <select id="finance-pharmacy" className="input" value={financeOrganisationId} onChange={event => setFinanceOrganisationId(event.target.value)} aria-label="Filter by pharmacy">
                <option value="all">All pharmacies</option>
                {state.organisations.filter(organisation => !isTrainingDirectoryPharmacy(organisation)).map(organisation => <option value={organisation.id} key={organisation.id}>{organisation.tradingName}</option>)}
              </select>
            </label>
            <button type="button" className="btn btn-sm" onClick={() => setAdminFinanceRefresh(value => value + 1)} disabled={adminFinanceLoading}>
              <RefreshCw size={13} className={adminFinanceLoading ? 'spin' : ''} /> Refresh
            </button>
          </div>
          <div className="order-crm-filters" role="group" aria-label="Reporting period">
            {([
              { id: 'all' as const, label: 'All time' },
              { id: 'month' as const, label: 'Month' },
              { id: 'year' as const, label: 'Year' },
            ]).map(period => (
              <button
                type="button"
                key={period.id}
                className={financePeriod === period.id ? 'active' : ''}
                aria-pressed={financePeriod === period.id}
                onClick={() => setFinancePeriod(period.id)}
              >
                <span>{period.label}</span>
              </button>
            ))}
          </div>
          {financePeriod !== 'all' ? (
            <div className="admin-filter-bar__more" role="group" aria-label="Reporting period detail">
              {financePeriod === 'month' ? (
                <label className="admin-register-crm__date">
                  <small>Month</small>
                  <input id="finance-month" type="month" value={financeMonth} onChange={event => setFinanceMonth(event.target.value)} aria-label="Reporting month" />
                </label>
              ) : (
                <label className="admin-register-crm__date">
                  <small>Year</small>
                  <input id="finance-year" type="number" min="2000" max="2200" step="1" value={financeYear} onChange={event => setFinanceYear(event.target.value)} aria-label="Reporting year" />
                </label>
              )}
            </div>
          ) : null}
        </section>

        {adminFinanceError ? (
          <div className="banner banner-amber" role="alert">
            <AlertCircle size={16} />
            <span><strong>Referral finance is temporarily unavailable</strong><small>{adminFinanceError}</small></span>
            <button className="btn btn-sm" type="button" onClick={() => setAdminFinanceRefresh(value => value + 1)}>Try again</button>
          </div>
        ) : null}

        {financeReady ? (
          <FeeChart
            events={filteredReferralFeeEvents}
            period={financePeriod}
            month={financeMonth}
            year={financeYear}
            formatMoney={amount => referralFeeFormatter.format(amount)}
          />
        ) : null}

        <div className="order-crm-workspace">
          <aside className="order-crm-list" aria-label="Earning patients">
            <header>
              <span><small>Ledger</small><strong>{adminFinanceLoading && !financeReady ? 'Loading' : `${visibleFinancePatients.length} patient${visibleFinancePatients.length === 1 ? '' : 's'}`}</strong></span>
            </header>
            <div className="order-crm-list__scroller">
              <div className="order-crm-list__rows">
                {adminFinanceLoading && !adminFinanceReport && !isLocalPortalPreview && visibleFinancePatients.length === 0 ? (
                  <div className="order-crm-empty">
                    <PoundSterling size={26} />
                    <strong>Loading ledger</strong>
                    <span>Referral fee events are being loaded for this period.</span>
                  </div>
                ) : visibleFinancePatients.length === 0 ? (
                  <div className="order-crm-empty">
                    <Users size={26} />
                    <strong>No earning patients</strong>
                    <span>No first-dispense or annual fees match the current period and pharmacy filter.</span>
                  </div>
                ) : visibleFinancePatients.map(patient => {
                  const selected = financePatientKey === patient.key;
                  return (
                    <button
                      type="button"
                      key={patient.key}
                      className={`order-crm-row order-crm-row--paid${selected ? ' selected' : ''}`}
                      aria-pressed={selected}
                      aria-label={`${patient.name}, ${patient.pharmacyName}, ${referralFeeFormatter.format(patient.total)} accrued`}
                      onClick={() => setFinancePatientKey(patient.key)}
                    >
                      <span className="order-crm-row__stage order-tone--paid" aria-hidden="true">{patientInitials(patient.name)}</span>
                      <span className="order-crm-row__identity">
                        <strong title={patient.name}>{compactPatientName(patient.name)}</strong>
                        <span className="order-stage-pill order-tone--paid">Earning</span>
                      </span>
                      <span className="order-crm-row__position">
                        <strong>{referralFeeFormatter.format(patient.total)}</strong>
                        <small>{patient.pharmacyName}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>

          <main className="order-crm-detail">
            {!selectedFinancePatient ? (
              <div className="order-crm-empty order-crm-empty--detail">
                <PoundSterling size={38} />
                <strong>Select an earning patient</strong>
                <span>Fee events, pharmacy attribution and a path into the register appear here. This is an operational ledger, not an invoice register.</span>
              </div>
            ) : (
              <article className="order-crm-record order-crm-record--paid">
                <header className="order-crm-record__header">
                  <div className="order-crm-record__hero">
                    <div className="order-crm-record__identity">
                      <span className="order-crm-record__stage order-tone--paid" aria-hidden="true">{patientInitials(selectedFinancePatient.name)}</span>
                      <div className="order-crm-record__titles">
                        <strong>{selectedFinancePatient.name}</strong>
                        <span className="order-crm-record__ref">{selectedFinancePatient.email}</span>
                        <em>{selectedFinancePatient.pharmacyName}{selectedPharmacy?.gphcNumber ? ` · GPhC ${selectedPharmacy.gphcNumber}` : ''}</em>
                      </div>
                    </div>
                    <span className="order-stage-pill order-tone--paid">Earning</span>
                  </div>
                  <div className="order-crm-record__toolbar">
                    <div className="order-crm-record__value">
                      <small>Accrued this period</small>
                      <strong>{referralFeeFormatter.format(selectedFinancePatient.total)}</strong>
                      <span className="order-crm-record__opened">{selectedFinanceEvents.length} event{selectedFinanceEvents.length === 1 ? '' : 's'} · {periodLabel}</span>
                    </div>
                    <div className="order-crm-record__actions" role="group" aria-label="Finance record actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setQuery('');
                          setPatientOrganisationId('all');
                          setPatientStatus('all');
                          setPatientFrom('');
                          setPatientTo('');
                          setPendingRegisterKey(registerPatientKey(selectedFinancePatient));
                          setView('patients');
                        }}
                      >
                        Open register
                      </button>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => openPharmacyOnOverview(selectedFinancePatient.organisationId, 'identity')}>Manage pharmacy</button>
                    </div>
                  </div>
                </header>

                <div className="patient-crm-detail__body pharmacy-dashboard admin-intake-record">
                  <div className="pharmacy-summary__metrics admin-patient-glance">
                    <div className="pharmacy-summary__metric">
                      <small>First dispense</small>
                      <strong>{referralFeeFormatter.format(selectedFirst.reduce((sum, event) => sum + event.amount, 0))}</strong>
                      <span>{selectedFirst.length ? `Collected ${formatUkDayDate(londonDateKey(selectedFirst[0]!.occurredAt) ?? '')}` : 'Not in this period'}</span>
                    </div>
                    <div className="pharmacy-summary__metric">
                      <small>Annual fees</small>
                      <strong>{referralFeeFormatter.format(selectedAnnual.reduce((sum, event) => sum + event.amount, 0))}</strong>
                      <span>{selectedAnnual.length} × £40</span>
                    </div>
                    <div className="pharmacy-summary__metric">
                      <small>Next anniversary</small>
                      <strong>{selectedNextAnniversary ? formatUkDayDate(londonDateKey(selectedNextAnniversary) ?? '') : 'None'}</strong>
                      <span>{selectedNextAnniversary ? '£40 if still active' : 'No first dispense in view'}</span>
                    </div>
                    <div className="pharmacy-summary__metric">
                      <small>Period</small>
                      <strong>{periodLabel}</strong>
                      <span>{selectedFinanceEvents.length} event{selectedFinanceEvents.length === 1 ? '' : 's'}</span>
                    </div>
                  </div>

                  <RecordCard icon={PoundSterling} title="Fee events" subtitle="Newest first" tag={<span className="order-stage-pill order-tone--paid">{referralFeeFormatter.format(selectedFinancePatient.total)}</span>}>
                    {selectedFinanceEvents.length === 0 ? (
                      <p className="admin-intake-note">No fee events remain for this patient after the current filters.</p>
                    ) : (
                      <ol className="fee-timeline">
                        {selectedFinanceEvents.map(event => (
                          <li key={event.id} className={event.kind === 'new-referral' ? 'is-first' : 'is-annual'}>
                            <i aria-hidden="true" />
                            <span>
                              <strong>{event.kind === 'new-referral' ? 'First collected dispense' : event.anniversary ? `Annual fee · year ${event.anniversary}` : 'Annual patient fee'}</strong>
                              <small>{event.occurredAt.toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' })} · {event.pharmacyName}</small>
                            </span>
                            <b>{referralFeeFormatter.format(event.amount)}</b>
                          </li>
                        ))}
                      </ol>
                    )}
                  </RecordCard>

                  <RecordCard
                    icon={Building2}
                    title={selectedFinancePatient.pharmacyName}
                    subtitle={[selectedPharmacy?.gphcNumber ? `GPhC ${selectedPharmacy.gphcNumber}` : null, selectedPharmacy?.postcode].filter(Boolean).join(' · ') || 'Attributed pharmacy'}
                    tag={<button type="button" className="btn btn-sm" onClick={() => openPharmacyOnOverview(selectedFinancePatient.organisationId, 'identity')}>Manage</button>}
                  >
                    <dl className="pharmacy-details__list">
                      <CopyFact label="Patient email" value={selectedFinancePatient.email} />
                      <CopyFact label="GPhC" value={selectedPharmacy?.gphcNumber} />
                    </dl>
                  </RecordCard>

                  <p className="admin-intake-note">Fees accrue on the first collected dispense (£50) and each active anniversary (£40). This is an operational ledger, not an invoice or payment record. Invoices and settlements will appear here once the server provides them.</p>
                </div>
              </article>
            )}
          </main>
        </div>
      </div>
    );
  };

  const pageMeta: Record<AdminView, { title: string }> = {
    overview: { title: 'Portfolio overview' },
    referrals: { title: 'HHH patient intake and referral' },
    patients: { title: 'Patients and pharmacy attribution' },
    finance: { title: 'HHH referral finance' },
  };

  return (
    <div className={`app-shell admin-shell unified-admin-shell admin-view-${view}`}>
      <a className="skip-link" href="#admin-main-content">Skip to main content</a>
      <AdminHeader view={view} pending={pendingAdminDecisions} freshIntake={freshIntakeCount} pharmacyRequests={pharmacyRequests.pending.length} setView={next => { setView(next); setQuery(''); }} onViewAdmins={() => { setAdminDialogFocus('list'); setShowAdminDialog(true); }} />
      <div className="app-main">
        <WorkspacePageHeader summary={<div ref={setHeaderSummary} className="admin-header-summary" />} section="HHH operations" context={pageMeta[view].title} title={pageMeta[view].title} commandLabel="Find anything" onSectionClick={() => { setView('overview'); setQuery(''); }} backAction={view !== 'overview' ? { label: 'Return to pharmacies', onClick: () => { setView('overview'); setQuery(''); } } : undefined} contextControl={<div className="header-context"><span>Access</span><span className="tenant-status tenant-status--live">Admin</span></div>} />
        <div id="admin-main-content" className="page-container admin-content" tabIndex={-1}>
          {view === 'overview' && renderOverview()}
          {view === 'referrals' && renderReferrals()}
          {view === 'patients' && renderPatients()}
          {view === 'finance' && renderFinance()}
        </div>
      </div>
      {showOnboarding && <OnboardPharmacy onClose={() => setShowOnboarding(false)} onCreated={id => { setShowOnboarding(false); openPharmacyOnOverview(id, 'identity'); }} />}
      {showAdminDialog ? <PlatformAdminDialog onClose={() => setShowAdminDialog(false)} focusInvite={adminDialogFocus === 'invite'} /> : null}
      {referralDialog && (
        <div className="drawer-backdrop admin-onboarding-backdrop" role="presentation">
          <aside className="drawer admin-referral-drawer" role="dialog" aria-modal="true" aria-labelledby="referral-action-title">
            <div className="drawer-header">
              <div><p className="section-label">Patient referral</p><h2 id="referral-action-title">{referralDialog.action === 'records' ? 'Log call and records check' : referralDialog.action === 'complete' ? 'Complete referral' : referralDialog.action === 'decline' ? 'Decline referral' : referralDialog.action === 'reason' ? 'Review pharmacy-facing reason' : 'Send patient email'}</h2></div>
              <button className="icon-btn" disabled={referralBusy} onClick={() => setReferralDialog(null)} aria-label="Close"><X size={18} /></button>
            </div>
            <div className="drawer-body onboarding-form">
              <div className="integration-boundary"><ShieldCheck size={17} /><div><strong>{referralDialog.patientName}</strong><p>{referralDialog.action === 'records' ? 'Record the outcome only. Do not upload or paste Summary Care Records or supporting health documents.' : referralDialog.action === 'email' ? 'This queues the approved referral template as a separate, audited action.' : referralDialog.action === 'decline' || referralDialog.action === 'reason' ? 'The pharmacy-facing reason must be suitable for disclosure. Keep confidential clinical detail in the internal notes only.' : 'This decision is recorded in the audit trail and cannot be silently changed.'}</p></div></div>
              {(referralDialog.action === 'decline' || referralDialog.action === 'reason') && <label>Pharmacy-facing reason<textarea className="input" rows={4} minLength={3} maxLength={500} required value={referralPharmacyReason} onChange={event => setReferralPharmacyReason(event.target.value)} placeholder={LEGACY_PHARMACY_DECISION_REASON} /><small className="field-help">Shown read-only in the pharmacy Patients Hub. 3–500 characters.</small></label>}
              {referralDialog.action !== 'email' && referralDialog.action !== 'reason' && <label>{referralDialog.action === 'records' ? 'Call / records-check notes' : 'Internal HHH decision notes'}<textarea className="input" rows={6} maxLength={2000} value={referralNotes} onChange={event => setReferralNotes(event.target.value)} placeholder="Record the operational outcome without attaching health records." /></label>}
              {referralDialog.action === 'reason' && <div className="banner banner-amber"><AlertCircle size={15} /><span><strong>Current pharmacy display</strong><small>{pharmacyDecisionReason(state.submissions.find(item => item.id === referralDialog.id)!)}</small></span></div>}
              {referralError && <div className="banner banner-red" role="alert"><AlertCircle size={16} /> {referralError}</div>}
              <div className="drawer-actions">{referralDialog.action === 'reason' && <button type="button" className="btn btn-danger" disabled={referralBusy} onClick={() => void runReferralAction(true)}>Redact to fallback</button>}<button type="button" className="btn" disabled={referralBusy} onClick={() => setReferralDialog(null)}>Cancel</button><button type="button" className={`btn ${referralDialog.action === 'decline' ? 'btn-danger' : 'btn-primary'}`} disabled={referralBusy || (referralDialog.action === 'records' && !referralNotes.trim()) || ((referralDialog.action === 'decline' || referralDialog.action === 'reason') && referralPharmacyReason.trim().length < 3)} onClick={() => void runReferralAction()}>{referralBusy ? 'Saving…' : referralDialog.action === 'records' ? 'Save check' : referralDialog.action === 'complete' ? 'Complete referral' : referralDialog.action === 'decline' ? 'Record decline' : referralDialog.action === 'reason' ? 'Save pharmacy reason' : 'Queue patient email'}</button></div>
            </div>
          </aside>
        </div>
      )}
      <CommandPalette commands={adminCommands} contextLabel="HHH administration" placeholder="Find a pharmacy, patient or admin action…" />
    </div>
  );
}
