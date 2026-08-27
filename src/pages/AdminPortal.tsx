import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Building2,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  Copy,
  Download,
  ExternalLink,
  FileArchive,
  Globe2,
  LayoutDashboard,
  Link2,
  ImagePlus,
  LockKeyhole,
  MailPlus,
  LogOut,
  MapPin,
  Pencil,
  Plus,
  PhoneCall,
  PoundSterling,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  ShieldOff,
  TrendingUp,
  Trash2,
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
import { downloadContentPack, eligibilityUrl } from '../utils/pharmacyResources';
import { brandSwatchStyle, deriveTenantTheme } from '../utils/tenantTheme';
import { onboardingStatusLabel, onboardingStatusPillClass } from '../utils/onboardingStatus';
import { useAuth } from '../auth/useAuth';
import { completeReferralRecordsCheck, createOrganisation, createPharmacyStaffInvitation, createPlatformAdminInvitation, getAdminPatientRegister, getAdminReferralFinance, getPharmacyStaff, getPlatformAdmins, getReferralLink, goLiveOrganisation, queueReferralPatientEmail, recordPatientRegisterExport, recordReferralDecision, removeOrganisationLogo, removePharmacyStaff, removePlatformAdmin, resendPharmacyStaffInvitation, resendPlatformAdminInvitation, resetPharmacyStaffMfa, updateEligibilityPharmacyReason, updateOrganisation, uploadOrganisationLogo } from '../shared/api';
import { isTrainingDirectoryPharmacy, type AdminReferralFinanceReport, type PatientRegisterExportResult, type PatientRegisterExportRow, type PharmacyStaffAccount, type PharmacyStaffInvitation, type PlatformAdminAccount, type PlatformAdminInvitation, type UpdateOrganisationInput } from '../shared/contracts';
import { AdminGoLivePanel } from '../onboarding/AdminGoLivePanel';
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
import { EMAIL_LOGO_SPEC, normalisePharmacyLogo } from '../utils/pharmacyLogo';
import { LEGACY_PHARMACY_DECISION_REASON, PHARMACY_REVIEWER_DISPLAY, isNegativeEligibilityStatus, pharmacyDecisionReason } from '../utils/eligibilityPresentation';
import { appPathPrefix } from '../auth/surface-path';
import { surfaceRelativePath, surfaceRoutePath } from '../routing/surfaceRoute';
import { ADMIN_VIEW_PATHS, parseAdminRelativePath, type AdminView } from '@hhh/domain/portal-route';
import AdminIntakeV2 from '../components/AdminIntakeV2';
import CuraleafConnectionPanel from '../components/CuraleafConnectionPanel';

type OverviewManagePanel = 'summary' | 'identity' | 'staff' | 'setup' | 'curaleaf';
type AdminDialogFocus = 'list' | 'invite';

const OVERVIEW_MANAGE_PANELS: { id: OverviewManagePanel; label: string }[] = [
  { id: 'summary', label: 'Summary' },
  { id: 'identity', label: 'Identity' },
  { id: 'staff', label: 'Staff' },
  { id: 'setup', label: 'Go live' },
  { id: 'curaleaf', label: 'Curaleaf' },
];

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

function stageTone(status: string) {
  if (status === 'Approved' || status === 'HHH approved') return 'paid';
  if (status === 'Declined' || status === 'Rejected' || status === 'Suspended') return 'danger';
  if (status === 'Under HHH review') return 'warning';
  return 'info';
}

function patientInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'P';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts.at(-1)![0]}`.toUpperCase();
}

function londonDayLabel(value: Date) {
  return value.toLocaleDateString('en-GB', { timeZone: 'Europe/London' });
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

function splitPharmacyAddress(organisation: PharmacyTenant) {
  if (organisation.addressLine1 && organisation.locality && organisation.postcode) {
    return {
      addressLine1: organisation.addressLine1,
      addressLine2: organisation.addressLine2 ?? '',
      locality: organisation.locality,
      postcode: organisation.postcode,
    };
  }
  const raw = organisation.address?.trim() || '';
  const postcodeMatch = raw.toUpperCase().match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/);
  const postcode = (organisation.postcode || postcodeMatch?.[1] || '').toUpperCase();
  const withoutPostcode = postcode
    ? raw.replace(new RegExp(postcode.replace(/\s+/g, '\\s*'), 'i'), '').replace(/[,\s]+$/, '')
    : raw;
  const parts = withoutPostcode.split(',').map(part => part.trim()).filter(Boolean);
  return {
    addressLine1: organisation.addressLine1 || parts[0] || raw,
    addressLine2: organisation.addressLine2 || (parts.length > 3 ? parts.slice(1, -2).join(', ') : ''),
    locality: organisation.locality || (parts.length >= 2 ? parts.at(parts.length >= 3 ? -2 : -1) ?? '' : ''),
    postcode,
  };
}

function AdminHeader({ view, setView, pending = 0, onViewAdmins }: { view: AdminView; setView: (view: AdminView) => void; pending?: number; onViewAdmins: () => void }) {
  const { signOutStaff } = useAuth();
  const { state } = useApp();
  const staffName = state.staffSession?.name || 'HHH Administrator';
  const groups: WorkspaceNavGroup<AdminView>[] = [
    { label: 'Administration', items: [
      { key: 'overview', label: 'Overview', icon: <LayoutDashboard size={17} /> },
      { key: 'referrals', label: 'Patient intake', icon: <UserCheck size={17} />, count: pending },
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
    const slug = slugify(tradingName || name);
    const logoText = (tradingName || name).split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase();
    const websiteDomains = domain ? [domain.replace(/^https?:\/\//, '').replace(/\/$/, '')] : [];
    const address = [addressLine1, addressLine2, addressLocality, addressPostcode.toUpperCase()].map(value => value.trim()).filter(Boolean).join(', ');
    try {
      const created = await createOrganisation({ name, tradingName, gphcNumber, superintendent, companyNumber, mainContactName, mainContactPhone, mainContactEmail, address, websiteDomains, primaryColour: primary, logoText, status: 'onboarding' });
      const organisation: PharmacyTenant = {
        id: created.id, slug, referralToken: created.referralToken, name, tradingName, logoText, gphcNumber, superintendent, companyNumber, mainContactName, mainContactPhone, mainContactEmail, address, websiteDomains,
        status: 'onboarding', staffCount: 0, defaultPaymentRoute: 'manual',
        brand: { primary, portalName: name },
        worldpay: { enabled: false, status: 'not-connected', environment: 'sandbox', merchantId: null, merchantName: null, lastSyncedAt: null },
      };
      dispatch({ type: 'ADD_ORGANISATION', organisation });
      dispatch({ type: 'ADD_TOAST', message: `${tradingName} onboarding record created in Firebase.`, toastType: 'success' });
      onCreated(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The onboarding record could not be created.');
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
              <div className="form-grid-two"><label>Main contact name<input className="input" value={mainContactName} onChange={event => setMainContactName(event.target.value)} required /></label><label>Main contact number<input className="input" type="tel" value={mainContactPhone} onChange={event => setMainContactPhone(event.target.value)} required /></label></div>
              <label>Main contact email<input className="input" type="email" value={mainContactEmail} onChange={event => setMainContactEmail(event.target.value)} required /></label>
              <label>Approved website domain<input className="input" type="text" value={domain} onChange={event => setDomain(event.target.value)} placeholder="pharmacy.cc" /></label>
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
                  <div className="tenant-mark" style={brandSwatchStyle(primary)}>{(tradingName || name).split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase() || 'PH'}</div>
                  <span>
                    <strong>{tradingName || name || 'Pharmacy workspace'}</strong>
                    <small>Preview of their staff portal only</small>
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

function EditPharmacy({ organisation, onClose, onSaved }: { organisation: PharmacyTenant; onClose: () => void; onSaved: (updates: Partial<PharmacyTenant>) => void }) {
  const [name, setName] = useState(organisation.name);
  const [tradingName, setTradingName] = useState(organisation.tradingName);
  const [gphcNumber, setGphcNumber] = useState(organisation.gphcNumber);
  const [superintendent, setSuperintendent] = useState(organisation.superintendent);
  const [companyNumber, setCompanyNumber] = useState(organisation.companyNumber ?? '');
  const [mainContactName, setMainContactName] = useState(organisation.mainContactName ?? organisation.superintendent);
  const [mainContactPhone, setMainContactPhone] = useState(organisation.mainContactPhone ?? '');
  const [mainContactEmail, setMainContactEmail] = useState(organisation.mainContactEmail ?? '');
  const initialAddress = splitPharmacyAddress(organisation);
  const [addressLine1, setAddressLine1] = useState(initialAddress.addressLine1);
  const [addressLine2, setAddressLine2] = useState(initialAddress.addressLine2);
  const [addressLocality, setAddressLocality] = useState(initialAddress.locality);
  const [addressPostcode, setAddressPostcode] = useState(initialAddress.postcode);
  const [domains, setDomains] = useState(organisation.websiteDomains.join('\n'));
  const [status, setStatus] = useState(organisation.status);
  const logoText = (tradingName || name).split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase() || organisation.logoText;
  const [logoPreviewUrl, setLogoPreviewUrl] = useState<string | null>(organisation.emailLogoUrl ?? null);
  const [pendingLogo, setPendingLogo] = useState<File | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [primaryColour, setPrimaryColour] = useState(organisation.brand.primary);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const editTheme = deriveTenantTheme(primaryColour);
  const editDialogRef = useModalFocus<HTMLElement>(true, onClose);

  useEffect(() => () => {
    if (logoPreviewUrl?.startsWith('blob:')) URL.revokeObjectURL(logoPreviewUrl);
  }, [logoPreviewUrl]);

  const selectLogo = async (event: ChangeEvent<HTMLInputElement>) => {
    const source = event.target.files?.[0];
    event.target.value = '';
    if (!source) return;
    setError(null);
    try {
      const normalised = await normalisePharmacyLogo(source);
      setPendingLogo(normalised);
      setRemoveLogo(false);
      setLogoPreviewUrl(current => {
        if (current?.startsWith('blob:')) URL.revokeObjectURL(current);
        return URL.createObjectURL(normalised);
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The logo could not be prepared.');
    }
  };

  const clearLogo = () => {
    setPendingLogo(null);
    setLogoPreviewUrl(null);
    setRemoveLogo(Boolean(organisation.emailLogoStoragePath || organisation.emailLogoUrl));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const websiteDomains = [...new Set(domains.split(/[\n,]+/).map(value => value.trim().replace(/^https?:\/\//i, '').split('/')[0].toLowerCase()).filter(Boolean))];
    const address = [addressLine1, addressLine2, addressLocality, addressPostcode.toUpperCase()].map(value => value.trim()).filter(Boolean).join(', ');
    const input: UpdateOrganisationInput = {
      name, tradingName, gphcNumber, superintendent, companyNumber, mainContactName, mainContactPhone, mainContactEmail,
      address, addressLine1, addressLine2, locality: addressLocality, postcode: addressPostcode,
      websiteDomains, status, logoText: logoText.toUpperCase(),
      primaryColour, portalName: name.trim(),
    };
    try {
      const saved = isLocalPortalPreview ? null : await updateOrganisation(organisation.id, input);
      let logoUpdates: Partial<PharmacyTenant> = {};
      if (isLocalPortalPreview) {
        if (removeLogo) {
          logoUpdates = { emailLogoUrl: null, emailLogoStoragePath: null, emailLogoWidth: null, emailLogoHeight: null, emailLogoUpdatedAt: null };
        } else if (pendingLogo) {
          const localUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(new Error('The logo preview could not be saved.'));
            reader.readAsDataURL(pendingLogo);
          });
          logoUpdates = { emailLogoUrl: localUrl, emailLogoStoragePath: 'local-preview/email-logo.png', emailLogoWidth: EMAIL_LOGO_SPEC.assetWidth, emailLogoHeight: EMAIL_LOGO_SPEC.assetHeight, emailLogoUpdatedAt: new Date() };
        }
      } else if (removeLogo) {
        const updated = await removeOrganisationLogo(organisation.id);
        logoUpdates = { emailLogoUrl: updated.emailLogoUrl ?? null, emailLogoStoragePath: updated.emailLogoStoragePath ?? null, emailLogoWidth: updated.emailLogoWidth ?? null, emailLogoHeight: updated.emailLogoHeight ?? null, emailLogoUpdatedAt: updated.emailLogoUpdatedAt ?? null };
      } else if (pendingLogo) {
        const updated = await uploadOrganisationLogo(organisation.id, pendingLogo);
        logoUpdates = { emailLogoUrl: updated.emailLogoUrl ?? null, emailLogoStoragePath: updated.emailLogoStoragePath ?? null, emailLogoWidth: updated.emailLogoWidth ?? null, emailLogoHeight: updated.emailLogoHeight ?? null, emailLogoUpdatedAt: updated.emailLogoUpdatedAt ?? null };
      }
      onSaved({
        name: name.trim(), tradingName: tradingName.trim(), gphcNumber: gphcNumber.trim(), superintendent: superintendent.trim(), companyNumber: companyNumber.trim() || undefined, mainContactName: mainContactName.trim(), mainContactPhone: mainContactPhone.trim(), mainContactEmail: mainContactEmail.trim(),
        address: saved?.address ?? address.trim(),
        addressLine1: saved?.addressLine1 ?? addressLine1.trim(),
        addressLine2: saved?.addressLine2 ?? addressLine2.trim(),
        locality: saved?.locality ?? addressLocality.trim(),
        postcode: saved?.postcode ?? addressPostcode.trim().toUpperCase(),
        websiteDomains: saved?.websiteDomains ?? websiteDomains,
        status, logoText: logoText.trim().toUpperCase(),
        brand: { primary: primaryColour, portalName: name.trim() },
        slug: slugify(tradingName || name),
        emailLogoUrl: logoUpdates.emailLogoUrl ?? saved?.emailLogoUrl ?? organisation.emailLogoUrl ?? null,
        emailLogoStoragePath: logoUpdates.emailLogoStoragePath ?? saved?.emailLogoStoragePath ?? organisation.emailLogoStoragePath ?? null,
        emailLogoWidth: logoUpdates.emailLogoWidth ?? saved?.emailLogoWidth ?? organisation.emailLogoWidth ?? null,
        emailLogoHeight: logoUpdates.emailLogoHeight ?? saved?.emailLogoHeight ?? organisation.emailLogoHeight ?? null,
        emailLogoUpdatedAt: logoUpdates.emailLogoUpdatedAt ?? saved?.emailLogoUpdatedAt ?? organisation.emailLogoUpdatedAt ?? null,
        ...logoUpdates,
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The pharmacy details could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="drawer-backdrop admin-onboarding-backdrop" role="presentation">
      <aside ref={editDialogRef} className="drawer admin-onboarding-drawer" role="dialog" aria-modal="true" aria-labelledby="edit-pharmacy-title" tabIndex={-1}>
        <div className="drawer-header">
          <div>
            <p className="section-label">HHH administrator</p>
            <h2 id="edit-pharmacy-title">Edit pharmacy details</h2>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <form className="admin-onboard-form" onSubmit={submit}>
          <div className="drawer-body onboarding-form">
            <section className="admin-onboard-section">
              <div className="form-section-heading"><span>01</span><div><strong>Registered organisation</strong><small>Corrections are saved to the pharmacy record and added to the audit trail.</small></div></div>
              <label>Registered pharmacy name<input className="input" value={name} onChange={event => setName(event.target.value)} required /></label>
              <label>Trading name<input className="input" value={tradingName} onChange={event => setTradingName(event.target.value)} required /></label>
              <div className="form-grid-two"><label>GPhC number<input className="input" value={gphcNumber} onChange={event => setGphcNumber(event.target.value)} required /></label><label>Superintendent pharmacist<input className="input" value={superintendent} onChange={event => setSuperintendent(event.target.value)} required /></label></div>
              <label>Company registration number<input className="input" value={companyNumber} onChange={event => setCompanyNumber(event.target.value)} /><small>Optional. This sits on the linked company record, not the pharmacy premises row.</small></label>
              <div className="onboarding-address-grid">
                <label>Address line 1<input className="input" value={addressLine1} onChange={event => setAddressLine1(event.target.value)} autoComplete="address-line1" required /></label>
                <label>Address line 2<input className="input" value={addressLine2} onChange={event => setAddressLine2(event.target.value)} autoComplete="address-line2" /></label>
                <label>Town or city<input className="input" value={addressLocality} onChange={event => setAddressLocality(event.target.value)} autoComplete="address-level2" required /></label>
                <label>Postcode<input className="input" value={addressPostcode} onChange={event => setAddressPostcode(event.target.value.toUpperCase())} autoComplete="postal-code" required /></label>
              </div>
              <div className="form-grid-two"><label>Main contact name<input className="input" value={mainContactName} onChange={event => setMainContactName(event.target.value)} required /></label><label>Main contact number<input className="input" type="tel" value={mainContactPhone} onChange={event => setMainContactPhone(event.target.value)} required /></label></div>
              <label>Main contact email<input className="input" type="email" value={mainContactEmail} onChange={event => setMainContactEmail(event.target.value)} required /></label>
              <label>Approved website domains<textarea className="input" value={domains} onChange={event => setDomains(event.target.value)} placeholder={'pharmacy.cc\nanother-domain.cc'} /><small>Enter one domain per line. Protocols and page paths are removed automatically.</small></label>
              <div className="form-grid-two"><label>Account status<select className="input" value={status === 'intake_live' ? 'onboarding' : status} onChange={event => setStatus(event.target.value as PharmacyTenant['status'])}><option value="onboarding">Onboarding</option>{status === 'live' && <option value="live">Live</option>}<option value="paused">Paused</option></select><small>Onboarding means the workspace is still training. Public intake is already on. Use Go live to unlock the live pharmacy workspace.</small></label></div>
            </section>

            <section className="admin-onboard-section">
              <div className="form-section-heading"><span>02</span><div><strong>Pharmacy workspace identity</strong><small>Logo and colour apply to their staff portal. Replacing the logo archives the previous file.</small></div></div>
              <label>Pharmacy name<input className="input" value={name} readOnly /><small>Also used as the portal name.</small></label>
              <section className="pharmacy-logo-editor" aria-labelledby="pharmacy-logo-heading">
                <div className={`pharmacy-logo-preview${logoPreviewUrl ? ' has-image' : ''}`}>
                  {logoPreviewUrl
                    ? <img src={logoPreviewUrl} alt={`${name} email logo preview`} />
                    : <span aria-hidden="true">{logoText}</span>}
                </div>
                <div className="pharmacy-logo-editor__copy">
                  <small>Email identity</small>
                  <strong id="pharmacy-logo-heading">Pharmacy logo</strong>
                  <p>PNG, JPEG or WebP. It is automatically centred on a transparent {EMAIL_LOGO_SPEC.assetWidth} × {EMAIL_LOGO_SPEC.assetHeight}px canvas for a consistent {EMAIL_LOGO_SPEC.displayWidth} × {EMAIL_LOGO_SPEC.displayHeight}px email header.</p>
                  <div className="pharmacy-logo-editor__actions">
                    <input ref={logoInputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={selectLogo} hidden />
                    <button className="btn" type="button" onClick={() => logoInputRef.current?.click()} disabled={busy}><ImagePlus size={14} /> {logoPreviewUrl ? 'Replace logo' : 'Choose logo'}</button>
                    {logoPreviewUrl && <button className="btn btn-danger" type="button" onClick={clearLogo} disabled={busy}><Trash2 size={14} /> Remove</button>}
                  </div>
                  {pendingLogo && <em>{pendingLogo.name} · ready to save</em>}
                  {removeLogo && <em>Logo will be removed when changes are saved.</em>}
                </div>
              </section>
              <div className="admin-workspace-preview">
                <div className="brand-colour-field">
                  <input type="color" value={primaryColour} onChange={event => setPrimaryColour(event.target.value)} aria-label="Pharmacy workspace primary colour" />
                  <div>
                    <strong>Primary brand colour</strong>
                    <small>{primaryColour.toUpperCase()} · accessible palette generated for their workspace</small>
                  </div>
                  <div className="onboarding-palette" aria-hidden="true">
                    <i style={{ background: editTheme.primary }} />
                    <i style={{ background: editTheme.secondary }} />
                    <i style={{ background: editTheme.primarySoft }} />
                  </div>
                </div>
                <div className="tenant-brand-preview" aria-hidden="true" style={{ borderTopColor: editTheme.primary, background: editTheme.surfaceTint }}>
                  <div className="tenant-mark" style={brandSwatchStyle(primaryColour)}>{logoText}</div>
                  <span>
                    <strong>{name || 'Pharmacy workspace'}</strong>
                    <small>Preview of their staff portal only</small>
                  </span>
                  <span className="brand-preview-button" style={{ background: editTheme.primary, color: editTheme.onPrimary }}>Primary action</span>
                  <span className="preview-secondary" style={{ background: editTheme.secondary, color: editTheme.onSecondary }}>Secondary</span>
                </div>
              </div>
            </section>

            <div className="setup-security-note"><ShieldCheck size={16} /><span>Curaleaf customer IDs and integration credentials are not changed here. Use the secure Integrations workflow to update those values.</span></div>
            {error && <div className="banner banner-red" role="alert"><AlertCircle size={16} /> {error}</div>}
          </div>
          <div className="drawer-actions">
            <button type="button" className="btn" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}><Pencil size={14} /> {busy ? 'Saving securely…' : 'Save all changes'}</button>
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
          dispatch({ type: 'ADD_TOAST', message: 'Account created. Retry the invitation email from this dialog.', toastType: 'warning' });
        }
      } catch {
        setEmailDelivery('failed');
        dispatch({ type: 'ADD_TOAST', message: 'Account created. Retry the invitation email from this dialog.', toastType: 'warning' });
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
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close administrators dialog"><X size={18} /></button>
        </div>
        <div className="drawer-body onboarding-form admin-admins-drawer__body">
          <p>Invite colleagues who need full admin portal access. Admin accounts are separate from pharmacy staff and are not tied to a pharmacy organisation.</p>
          <form className="admin-staff-invite-form" onSubmit={invite}>
            <label htmlFor="admin-invite-name">Admin name<input id="admin-invite-name" ref={nameInputRef} className="input" value={displayName} onChange={event => setDisplayName(event.target.value)} autoComplete="off" required /></label>
            <label htmlFor="admin-invite-email">Work email address<input id="admin-invite-email" className="input" type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="off" required /></label>
            <button className="btn btn-primary" type="submit" disabled={busy}><UserPlus size={14} /> {busy ? 'Creating account…' : 'Invite admin'}</button>
          </form>
          {error && <div className="banner banner-red" role="alert"><AlertCircle size={16} /> {error}</div>}
          {invitation && <div className="staff-invitation-result"><ShieldCheck size={17} /><div><strong>Admin account created · {emailDelivery === 'sent' ? 'Setup email queued' : emailDelivery === 'failed' ? 'Email not queued' : 'Preparing email'}</strong><span>{emailDelivery === 'sent' ? 'A password setup email has been queued. They will choose a password and set up two-factor authentication before entering the admin portal.' : 'A setup email could not be queued. Retry the invitation from this dialog. The setup link is not shown in the browser.'}</span></div></div>}
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    if (isLocalPortalPreview) {
      const records: PharmacyStaffAccount[] = [
        { uid: `${organisation.id}-owner`, email: 'owner@pharmacy.example', displayName: 'Alex Morgan', role: 'pharmacy_staff', pharmacyId: organisation.id, organisationId: organisation.id, contactRole: 'owner', status: 'active', createdAt: new Date().toISOString() },
        { uid: `${organisation.id}-staff`, email: 'dispensary@pharmacy.example', displayName: 'Sam Reed', role: 'pharmacy_staff', pharmacyId: organisation.id, organisationId: organisation.id, contactRole: 'staff', status: 'active', createdAt: new Date().toISOString() },
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
    <section className="card admin-staff-card">
      <div className="admin-directory-head"><div><p className="section-label">Account access</p><h2>Pharmacy staff</h2><p>Create staff access for this pharmacy. The first account is tagged Owner only to identify the main contact; it receives no additional permissions.</p></div><span className="pill pill-info"><Users size={13} /> {staff.length} account{staff.length === 1 ? '' : 's'}</span></div>
      <form className="admin-staff-invite-form" onSubmit={invite}>
        <label>Staff member name<input className="input" value={displayName} onChange={event => setDisplayName(event.target.value)} autoComplete="off" required /></label>
        <label>Work email address<input className="input" type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="off" required /></label>
        <button className="btn btn-primary" type="submit" disabled={busy}><UserPlus size={14} /> {busy ? 'Creating account…' : 'Add staff account'}</button>
      </form>
      {error && <div className="banner banner-red" role="alert"><AlertCircle size={16} /> {error}</div>}
      {invitation && <div className="staff-invitation-result"><ShieldCheck size={17} /><div><strong>{invitation.contactRole === 'owner' ? 'Owner account created' : 'Staff account created'} · {emailDelivery === 'sent' ? 'Setup email queued' : emailDelivery === 'failed' ? 'Email not queued' : 'Preparing email'}</strong><span>{emailDelivery === 'sent' ? 'A password setup email has been queued. They will choose a password and set up two-factor authentication before entering the pharmacy workspace.' : 'A setup email could not be queued. Retry the invitation from this screen. The setup link is not shown in the browser.'}</span></div></div>}
      <div className="admin-staff-list">
        {loading && <div className="empty-state">Loading staff accounts…</div>}
        {!loading && staff.length === 0 && <div className="empty-state">No pharmacy staff accounts yet. The first person added will be tagged Owner.</div>}
        {staff.map(account => <div className="admin-staff-row" key={account.uid}><div className="staff-avatar">{account.displayName.split(/\s+/).map(part => part[0]).join('').slice(0, 2).toUpperCase()}</div><div><strong>{account.displayName}</strong><span>{account.email}</span></div><span className={`pill ${account.contactRole === 'owner' ? 'pill-info' : 'pill-neutral'}`}>{account.contactRole === 'owner' ? 'Owner' : 'Staff'}</span><span className={`pill ${account.status === 'active' ? 'pill-green' : account.status === 'disabled' ? 'pill-red' : 'pill-amber'}`}>{account.status}</span><div className="admin-staff-row-actions"><button className="icon-btn" type="button" disabled={account.status !== 'invited' || resendingUid === account.uid} title={account.status === 'invited' ? 'Resend setup email' : 'Only pending invitations can be resent'} aria-label={`Resend setup email to ${account.displayName}`} onClick={() => void resendStaffInvite(account)}><MailPlus size={16} /></button><button className="icon-btn" type="button" disabled={account.status === 'disabled' || resettingUid === account.uid} title="Remove authenticator app" aria-label={`Remove authenticator for ${account.displayName}`} onClick={() => void resetMfa(account)}><ShieldOff size={16} /></button><button className="icon-btn" type="button" disabled={account.contactRole === 'owner' || deletingUid === account.uid} title={account.contactRole === 'owner' ? 'Owner account is protected' : 'Remove staff access'} aria-label={account.contactRole === 'owner' ? `${account.displayName} is the protected owner account` : `Remove ${account.displayName}`} onClick={() => void removeStaff(account)}><UserX size={16} /></button></div></div>)}
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
  const [patientFrom, setPatientFrom] = useState('');
  const [patientTo, setPatientTo] = useState('');
  const [patientExportBusy, setPatientExportBusy] = useState(false);
  const [patientExportError, setPatientExportError] = useState<string | null>(null);
  const [serverPatientRegister, setServerPatientRegister] = useState<PatientRegisterExportResult | null>(null);
  const [patientRegisterLoading, setPatientRegisterLoading] = useState(false);
  const [selectedRegisterPatient, setSelectedRegisterPatient] = useState<PatientRegisterExportRow | null>(null);
  const [pendingRegisterKey, setPendingRegisterKey] = useState<string | null>(null);
  const [referralLink, setReferralLink] = useState('');
  const [referralLinkLoading, setReferralLinkLoading] = useState(false);
  const [referralLinkError, setReferralLinkError] = useState<string | null>(null);
  const [referralLinkRefresh, setReferralLinkRefresh] = useState(0);
  const [overviewPharmacyId, setOverviewPharmacyId] = useState<string | null>(organisationIdFromPath);
  const [overviewManagePanel, setOverviewManagePanel] = useState<OverviewManagePanel>('summary');
  const [overviewManageOpen, setOverviewManageOpen] = useState(false);
  const [overviewFilter, setOverviewFilter] = useState<'all' | 'registered' | 'training'>('all');
  const overviewManageRef = useRef<HTMLDivElement>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);

  const [showPharmacyEditor, setShowPharmacyEditor] = useState(false);
  const [showAdminDialog, setShowAdminDialog] = useState(false);
  const [adminDialogFocus, setAdminDialogFocus] = useState<AdminDialogFocus>('list');
  const [goLiveBusy, setGoLiveBusy] = useState(false);
  const [goLiveError, setGoLiveError] = useState<string | null>(null);
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
    if (!overviewPharmacy || overviewManagePanel !== 'identity') {
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
  }, [overviewManagePanel, overviewPharmacy?.id, overviewPharmacy?.referralToken, referralLinkRefresh]);

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
    setShowPharmacyEditor(false);
  }, []);

  useEffect(() => {
    document.getElementById('admin-main-content')?.scrollTo({ top: 0 });
  }, [view, overviewPharmacyId, overviewManagePanel]);

  useEffect(() => {
    const onPopState = () => {
      const organisationId = organisationIdFromPath();
      setView(adminViewFromPath());
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
    const path = view === 'overview' && overviewPharmacyId
      ? adminPathForOrganisation(overviewPharmacyId)
      : adminPathForView(view);
    if (window.location.pathname !== path) window.history.pushState(null, '', withLocationSearch(path));
  }, [overviewPharmacyId, view]);

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
      setShowPharmacyEditor(false);
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

        const pharmacyName = organisations.get(submission.organisationId)?.tradingName
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

  const feesByOrganisation = useMemo(() => {
    const positions = new Map<string, { total: number; firstAmount: number; annualAmount: number; firstCount: number; annualCount: number; patients: number }>();
    const patients = new Map<string, Set<string>>();
    for (const event of referralFeeEvents) {
      const current = positions.get(event.organisationId) ?? { total: 0, firstAmount: 0, annualAmount: 0, firstCount: 0, annualCount: 0, patients: 0 };
      current.total += event.amount;
      if (event.kind === 'new-referral') {
        current.firstAmount += event.amount;
        current.firstCount += 1;
      } else {
        current.annualAmount += event.amount;
        current.annualCount += 1;
      }
      positions.set(event.organisationId, current);
      const keys = patients.get(event.organisationId) ?? new Set<string>();
      keys.add(event.patientKey);
      patients.set(event.organisationId, keys);
    }
    for (const [organisationId, position] of positions) {
      position.patients = patients.get(organisationId)?.size ?? 0;
    }
    return positions;
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

  const patientStatuses = [...new Set(allPatients.map(patient => patient.stage))].sort((a, b) => onboardingStatusLabel(a).localeCompare(onboardingStatusLabel(b)));
  const filteredPatients = useMemo(() => allPatients.filter(patient => {
    const org = state.organisations.find(item => item.id === patient.organisationId);
    const searchMatches = `${patient.name} ${patient.email} ${patient.mobile} ${patient.dob} ${formatPatientDob(patient.dob)} ${org?.name ?? ''} ${org?.tradingName ?? ''}`.toLowerCase().includes(query.trim().toLowerCase());
    if (!searchMatches) return false;
    if (patientOrganisationId !== 'all' && patient.organisationId !== patientOrganisationId) return false;
    if (patientStatus !== 'all' && patient.stage !== patientStatus) return false;
    const date = londonDateKey(patient.date);
    if (patientFrom && (!date || date < patientFrom)) return false;
    if (patientTo && (!date || date > patientTo)) return false;
    return true;
  }), [allPatients, patientFrom, patientOrganisationId, patientStatus, patientTo, query, state.organisations]);
  const displayedPatients = useMemo(
    () => (isLocalPortalPreview ? filteredPatients : serverPatientRegister?.rows ?? []),
    [filteredPatients, serverPatientRegister],
  );

  const toRegisterRow = useCallback((patient: typeof displayedPatients[number]): PatientRegisterExportRow => {
    const organisation = state.organisations.find(item => item.id === patient.organisationId);
    const pharmacyName = 'pharmacyName' in patient ? patient.pharmacyName : organisation?.tradingName;
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
    };
  }, [state.organisations]);

  useEffect(() => {
    if (view !== 'patients') return;
    if (pendingRegisterKey) {
      const pending = displayedPatients.find(patient => registerPatientKey(patient) === pendingRegisterKey);
      if (pending) {
        setSelectedRegisterPatient(toRegisterRow(pending));
        setPendingRegisterKey(null);
        return;
      }
      if (patientRegisterLoading) return;
      setPendingRegisterKey(null);
    }
    if (selectedRegisterPatient && displayedPatients.some(patient => registerPatientKey(patient) === registerPatientKey(selectedRegisterPatient))) {
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
            return { ...patient, pharmacyName: organisation?.tradingName ?? 'Unknown pharmacy' };
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

  const flipPharmacyLive = async (organisationId: string) => {
    setGoLiveBusy(true);
    setGoLiveError(null);
    try {
      if (isLocalPortalPreview) {
        dispatch({ type: 'UPDATE_ORGANISATION', organisationId, updates: { status: 'live' } });
        dispatch({ type: 'ADD_TOAST', message: 'Preview workspace marked live.', toastType: 'success' });
        return;
      }
      const readiness = await goLiveOrganisation(organisationId);
      dispatch({ type: 'UPDATE_ORGANISATION', organisationId, updates: { status: readiness.status } });
      dispatch({ type: 'ADD_TOAST', message: 'Pharmacy workspace is live.', toastType: 'success' });
    } catch (error) {
      setGoLiveError(error instanceof Error ? error.message : 'The pharmacy could not be flipped to live.');
    } finally {
      setGoLiveBusy(false);
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
    { label: 'Invite admin', detail: 'Add another HHH administrator account', group: 'Actions', icon: <UserPlus size={16} />, run: () => { setAdminDialogFocus('invite'); setShowAdminDialog(true); } },
    { label: 'View admins', detail: 'HHH administrator accounts', group: 'Navigate', icon: <Users size={16} />, run: () => { setAdminDialogFocus('list'); setShowAdminDialog(true); } },
    { label: 'Onboard pharmacy', detail: 'Create a new pharmacy workspace', group: 'Actions', icon: <Plus size={16} />, run: () => { setView('overview'); setShowOnboarding(true); } },
    ...state.organisations.map((organisation): CommandDefinition => ({
      label: organisation.tradingName,
      detail: `${organisation.name} · GPhC ${organisation.gphcNumber}`,
      keywords: `${organisation.websiteDomains.join(' ')} ${organisation.mainContactEmail}`,
      group: 'Pharmacies',
      searchOnly: true,
      icon: <Building2 size={16} />,
      run: () => openPharmacyOnOverview(organisation.id),
    })),
    ...allPatients.map((patient): CommandDefinition => {
      const organisation = state.organisations.find(item => item.id === patient.organisationId);
      return {
        label: patient.name,
        detail: `${organisation?.tradingName ?? 'Unknown pharmacy'} · ${patient.email}`,
        keywords: `${patient.mobile} ${patient.dob} ${patient.stage}`,
        group: 'Patients',
        searchOnly: true,
        icon: <Users size={16} />,
        run: () => { setView('patients'); setQuery(patient.email); },
      };
    }),
  ], [allPatients, openPharmacyOnOverview, state.organisations]);

  const overviewPharmacies = state.organisations.filter(org => {
    const matchesQuery = `${org.name} ${org.tradingName} ${org.gphcNumber}`.toLowerCase().includes(query.toLowerCase());
    if (!matchesQuery) return false;
    if (overviewFilter === 'registered') return !isTrainingDirectoryPharmacy(org);
    if (overviewFilter === 'training') return isTrainingDirectoryPharmacy(org);
    return true;
  });
  const registeredPharmacies = overviewPharmacies.filter(org => !isTrainingDirectoryPharmacy(org));
  const trainingPharmacies = overviewPharmacies.filter(org => isTrainingDirectoryPharmacy(org));

  useEffect(() => {
    if (view !== 'overview') return;
    if (overviewPharmacyId) {
      if (!state.organisations.length) return;
      if (state.organisations.some(organisation => organisation.id === overviewPharmacyId)) return;
    }
    setOverviewPharmacyId((registeredPharmacies[0] ?? trainingPharmacies[0])?.id ?? null);
    setOverviewManagePanel('summary');
    setOverviewManageOpen(false);
  }, [overviewPharmacies, overviewPharmacyId, state.organisations, view]);

  const statusLabel = (status: PharmacyTenant['status']) => {
    if (status === 'live') return 'Live';
    if (status === 'paused') return 'Paused';
    return 'Onboarding';
  };
  const pharmacyTone = (status: PharmacyTenant['status']) => status === 'live' ? 'paid' : status === 'paused' ? 'danger' : 'warning';
  const intakeIsLive = (organisation: PharmacyTenant) => {
    if (organisation.status === 'paused') return false;
    if (isTrainingDirectoryPharmacy(organisation)) return false;
    if (organisation.intakeEnabled === false) return false;
    return true;
  };

  const renderOverview = () => {
    const portfolioAccrued = referralFeeEvents.reduce((total, event) => total + event.amount, 0);
    const firstDispenseCount = referralFeeEvents.filter(event => event.kind === 'new-referral').length;
    const financeReady = isLocalPortalPreview || Boolean(adminFinanceReport) || !adminFinanceLoading;
    const selectedPharmacy = overviewPharmacy;
    const selectedFees = selectedPharmacy ? feesByOrganisation.get(selectedPharmacy.id) : null;
    const selectedPatients = selectedPharmacy ? new Set([
      ...(crmByOrganisation.get(selectedPharmacy.id) ?? []).map(patient => patient.email),
      ...(submissionsByOrganisation.get(selectedPharmacy.id) ?? []).map(submission => submission.email),
    ]).size : 0;
    const workspaceLabel = selectedPharmacy?.status === 'live'
      ? 'Live'
      : selectedPharmacy?.status === 'paused'
        ? 'Paused'
        : 'Training';
    const managePanelLabel = OVERVIEW_MANAGE_PANELS.find(panel => panel.id === overviewManagePanel)?.label ?? 'Summary';
    const tenantTheme = selectedPharmacy ? deriveTenantTheme(selectedPharmacy.brand.primary) : null;
    const formUrl = referralLink;
    const selectedIntakeLive = selectedPharmacy ? intakeIsLive(selectedPharmacy) : false;

    const renderPharmacyRow = (organisation: PharmacyTenant) => {
      const tone = pharmacyTone(organisation.status);
      const fees = feesByOrganisation.get(organisation.id);
      return (
        <button
          type="button"
          key={organisation.id}
          className={`order-crm-row order-crm-row--${tone}${overviewPharmacyId === organisation.id ? ' selected' : ''}`}
          aria-pressed={overviewPharmacyId === organisation.id}
          aria-label={`${organisation.tradingName}, ${statusLabel(organisation.status)}`}
          onClick={() => {
            if (organisation.id !== overviewPharmacyId) {
              setOverviewManagePanel('summary');
              setShowPharmacyEditor(false);
            }
            setOverviewPharmacyId(organisation.id);
            setOverviewManageOpen(false);
          }}
        >
          <span className={`order-crm-row__stage order-tone--${tone}`} aria-hidden="true">{organisation.logoText}</span>
          <span className="order-crm-row__identity">
            <strong title={organisation.tradingName}>{organisation.tradingName}</strong>
            <span className={`order-stage-pill order-tone--${tone}`}>{statusLabel(organisation.status)}</span>
          </span>
          <span className="order-crm-row__position">
            <strong>{financeReady ? referralFeeFormatter.format(fees?.total ?? 0) : '—'}</strong>
            <small>GPhC {organisation.gphcNumber}</small>
          </span>
        </button>
      );
    };

    return (
      <div className="page-body order-crm patient-crm admin-overview-crm">
        <section className="order-crm-summary" aria-label="Pharmacy portfolio summary">
          <article className="order-crm-metric">
            <span className="order-crm-metric__icon"><Building2 size={16} /></span>
            <span><small>Pharmacies</small><strong>{state.organisations.length}</strong><em>{registeredCount} registered · {trainingCount} testing</em></span>
          </article>
          <article className="order-crm-metric">
            <span className="order-crm-metric__icon"><Users size={16} /></span>
            <span><small>Patient reach</small><strong>{allPatients.length}</strong><em>Attributed records across the portfolio</em></span>
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
            <span><small>Intake queue</small><strong>{pendingAdminDecisions}</strong><em>{pendingAdminDecisions ? 'Decisions waiting on HHH' : 'No pending decisions'}</em></span>
          </article>
        </section>

        <section className="order-crm-controls">
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
          <div className="order-crm-filters" role="group" aria-label="Filter pharmacies">
            {([
              { key: 'all' as const, label: 'All', count: state.organisations.length },
              { key: 'registered' as const, label: 'Registered', count: registeredCount },
              { key: 'training' as const, label: 'Testing', count: trainingCount },
            ]).map(filter => (
              <button
                type="button"
                key={filter.key}
                className={overviewFilter === filter.key ? 'active' : ''}
                aria-pressed={overviewFilter === filter.key}
                onClick={() => setOverviewFilter(filter.key)}
              >
                <span>{filter.label}</span><strong>{filter.count}</strong>
              </button>
            ))}
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowOnboarding(true)}>
              <Plus size={14} /> Onboard pharmacy
            </button>
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
              <span><small>Directory</small><strong>{overviewPharmacies.length} result{overviewPharmacies.length === 1 ? '' : 's'}</strong></span>
            </header>
            <div className="order-crm-list__scroller">
              <div className="order-crm-list__rows">
                {overviewPharmacies.length === 0 ? (
                  <div className="order-crm-empty">
                    <Building2 size={26} />
                    <strong>{state.organisations.length === 0 ? 'No pharmacies onboarded' : 'No pharmacies match'}</strong>
                    <span>{state.organisations.length === 0 ? 'Onboard a pharmacy to start the portfolio.' : 'Try another filter or search term.'}</span>
                  </div>
                ) : (
                  <>
                    {registeredPharmacies.length ? (
                      <section className="order-crm-list-group" aria-label="Registered pharmacies">
                        <header>
                          <span>
                            <strong>Registered pharmacies</strong>
                            <small>Onboarded pharmacies</small>
                          </span>
                          <b>{registeredPharmacies.length}</b>
                        </header>
                        {registeredPharmacies.map(organisation => renderPharmacyRow(organisation))}
                      </section>
                    ) : null}
                    {trainingPharmacies.length ? (
                      <section className="order-crm-list-group" aria-label="Testing pharmacies">
                        <header>
                          <span>
                            <strong>Testing pharmacies</strong>
                            <small>Primary and Alternate sandbox</small>
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
            {!selectedPharmacy ? (
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
                        <strong>{selectedPharmacy.tradingName}</strong>
                        <span className="order-crm-record__ref">{selectedPharmacy.name} · GPhC {selectedPharmacy.gphcNumber}</span>
                        <em>{workspaceLabel}</em>
                      </div>
                    </div>
                    <span className={`order-stage-pill order-tone--${pharmacyTone(selectedPharmacy.status)}`}>{statusLabel(selectedPharmacy.status)}</span>
                  </div>
                  <div className="order-crm-record__toolbar">
                    <div className="order-crm-record__value">
                      <small>Accrued fees</small>
                      <strong>{financeReady ? referralFeeFormatter.format(selectedFees?.total ?? 0) : 'Loading'}</strong>
                      <span className="order-crm-record__opened">{selectedFees ? `${selectedFees.patients} earning patient${selectedFees.patients === 1 ? '' : 's'}` : 'No fee events yet'}</span>
                    </div>
                    <div className="order-crm-record__actions" role="group" aria-label="Pharmacy actions">
                      <button type="button" className="btn btn-sm" onClick={() => { setFinanceOrganisationId(selectedPharmacy.id); setView('finance'); }}>Open ledger</button>
                      <div
                        className={`order-filter-menu admin-overview-manage${overviewManageOpen ? ' is-open' : ''}`}
                        ref={overviewManageRef}
                      >
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          aria-haspopup="menu"
                          aria-expanded={overviewManageOpen}
                          aria-controls="overview-manage-menu"
                          aria-label={`Manage ${selectedPharmacy.tradingName}, ${managePanelLabel} panel`}
                          onClick={() => setOverviewManageOpen(open => !open)}
                        >
                          <span>Manage · {managePanelLabel}</span>
                          <ChevronDown size={14} aria-hidden="true" />
                        </button>
                        {overviewManageOpen ? (
                          <div id="overview-manage-menu" role="menu" aria-label="Pharmacy manage sections">
                            <div role="group" className="order-filter-menu__group">
                              {OVERVIEW_MANAGE_PANELS.map(panel => (
                                <button
                                  type="button"
                                  role="menuitemradio"
                                  key={panel.id}
                                  aria-checked={overviewManagePanel === panel.id}
                                  className={overviewManagePanel === panel.id ? 'active' : ''}
                                  onClick={() => {
                                    setOverviewManagePanel(panel.id);
                                    setOverviewManageOpen(false);
                                  }}
                                >
                                  {panel.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </header>

                <div className="patient-crm-detail__body">
                  {overviewManagePanel === 'summary' ? (
                    <>
                      <div className="admin-overview-crm__facts">
                        <article>
                          <small>Attributed patients</small>
                          <strong>{selectedPatients}</strong>
                        </article>
                        <article>
                          <small>Workspace</small>
                          <strong>{selectedPharmacy.status === 'live' ? 'Live' : selectedPharmacy.status === 'paused' ? 'Paused' : 'Training'}</strong>
                          <em>{selectedPharmacy.status === 'live' ? 'Referred patients and orders' : 'Training examples until go-live'}</em>
                        </article>
                        <article>
                          <small>Intake</small>
                          <strong>{selectedIntakeLive ? 'Live' : 'Off'}</strong>
                          <em>{selectedIntakeLive ? 'Eligibility link and HHH queue' : 'No public intake'}</em>
                        </article>
                        <article>
                          <small>First dispenses</small>
                          <strong>{financeReady ? referralFeeFormatter.format(selectedFees?.firstAmount ?? 0) : '—'}</strong>
                          <em>{selectedFees?.firstCount ?? 0} × £50</em>
                        </article>
                        <article>
                          <small>Annual fees</small>
                          <strong>{financeReady ? referralFeeFormatter.format(selectedFees?.annualAmount ?? 0) : '—'}</strong>
                          <em>{selectedFees?.annualCount ?? 0} × £40</em>
                        </article>
                      </div>
                      <p className="admin-overview-crm__note">Referral fees accrue on the first collected dispense (£50) and each active anniversary (£40). This is an operational ledger, not an invoice register. Open Patients to view the attributed register for this pharmacy.</p>
                    </>
                  ) : null}

                  {overviewManagePanel === 'identity' && tenantTheme ? (
                    <div className="admin-overview-manage-panel">
                      <div className="admin-detail-grid admin-config-grid">
                        <section className="card admin-detail-card">
                          <div className="admin-detail-card-title">
                            <Building2 size={18} />
                            <h2>Registered details</h2>
                            <button type="button" className="btn btn-sm" onClick={() => setShowPharmacyEditor(true)}><Pencil size={13} /> Edit details</button>
                          </div>
                          <div className="admin-detail-list">
                            <div><span>Pharmacy name</span><strong>{selectedPharmacy.name}</strong></div>
                            <div><span>Curaleaf ID (PHAR code)</span><strong>{selectedPharmacy.curaleafPharmacyCode ?? 'Not connected'}</strong></div>
                            <div><span>Company name</span><strong>{selectedPharmacy.tradingName}</strong></div>
                            <div><span>Company registration number</span><strong>{selectedPharmacy.companyNumber || 'Not supplied'}</strong></div>
                            <div><span>GPhC number</span><strong>{selectedPharmacy.gphcNumber}</strong></div>
                            <div><span>Main contact name</span><strong>{selectedPharmacy.mainContactName || selectedPharmacy.superintendent}</strong></div>
                            <div><span>Main contact number</span><strong>{selectedPharmacy.mainContactPhone || 'Not supplied'}</strong></div>
                            <div><span>Main contact email</span><strong>{selectedPharmacy.mainContactEmail || 'Not supplied'}</strong></div>
                            <div><span>Registered office address</span><strong><MapPin size={13} /> {selectedPharmacy.address}</strong></div>
                            <div><span>Approved domains</span><strong><Globe2 size={13} /> {selectedPharmacy.websiteDomains.join(', ') || 'Not supplied'}</strong></div>
                            <div><span>Eligibility handling</span><strong>Managed by HHH admin</strong></div>
                          </div>
                        </section>

                        <section className="card admin-detail-card tenant-brand-editor">
                          <div className="admin-detail-card-title"><Settings2 size={18} /><h2>Brand preview</h2></div>
                          <label>Pharmacy name<input className="input" value={selectedPharmacy.name} readOnly /></label>
                          <div className="brand-editor-row">
                            <label>Primary colour<span><input type="color" value={selectedPharmacy.brand.primary} disabled /><code>{selectedPharmacy.brand.primary}</code></span></label>
                            <label>Automatic secondary<span className="derived-colour"><i style={{ background: tenantTheme.secondary }} /><code>{tenantTheme.secondary}</code><small>Derived from primary</small></span></label>
                          </div>
                          <div className="generated-palette" aria-label="Automatically generated pharmacy palette"><span style={{ background: tenantTheme.primary }} title="Primary" /><span style={{ background: tenantTheme.secondary }} title="Secondary" /><span style={{ background: tenantTheme.primaryMuted }} title="Muted brand" /><span style={{ background: tenantTheme.primarySoft }} title="Soft surface" /><span style={{ background: tenantTheme.sidebar }} title="Navigation" /></div>
                          <p className="theme-help">This palette is applied in the pharmacy staff portal only. HHH admin keeps the Holistic Health Hub forest, cream and rust colours.</p>
                          <div className="tenant-brand-preview" aria-hidden="true" style={{ borderTopColor: tenantTheme.primary, background: tenantTheme.surfaceTint }}>
                            <div className="tenant-mark" style={brandSwatchStyle(selectedPharmacy.brand.primary)}>{selectedPharmacy.logoText}</div>
                            <span><strong>{selectedPharmacy.brand.portalName}</strong><small>Patient and pharmacy workspace preview</small></span>
                            <span className="brand-preview-button" style={{ background: tenantTheme.primary, color: tenantTheme.onPrimary }}>Primary action</span>
                            <span className="preview-secondary" style={{ background: tenantTheme.secondary, color: tenantTheme.onSecondary }}>Secondary</span>
                          </div>
                        </section>
                      </div>

                      <section className="card admin-detail-card admin-detail-assets">
                        <div className="admin-detail-card-title"><Link2 size={18} /><h2>Eligibility form and content assets</h2></div>
                        <p>Every submission through this hosted URL is permanently attributed to this pharmacy token.</p>
                        {referralLinkError ? <div className="banner banner-red" role="alert"><AlertCircle size={15} /><span>{referralLinkError}</span><button className="btn btn-sm" type="button" onClick={() => setReferralLinkRefresh(value => value + 1)}><RefreshCw size={13} /> Retry</button></div> : null}
                        <div className="resource-url" aria-live="polite">{referralLinkLoading ? 'Loading the protected pharmacy link…' : formUrl || 'Link unavailable'}</div>
                        <div className="flex gap-sm flex-wrap">
                          <button className="btn btn-primary btn-sm" disabled={!formUrl} onClick={async () => { if (!formUrl) return; await navigator.clipboard.writeText(formUrl); dispatch({ type: 'ADD_TOAST', message: 'Eligibility link copied.', toastType: 'success' }); }}><Copy size={13} /> Copy link</button>
                          {formUrl ? <a className="btn btn-sm" href={formUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Preview form</a> : <button className="btn btn-sm" type="button" disabled><ExternalLink size={13} /> Preview form</button>}
                          <button className="btn btn-sm" disabled={!formUrl} onClick={() => void downloadContentPack(selectedPharmacy, formUrl)}><FileArchive size={13} /> Content pack</button>
                        </div>
                      </section>
                    </div>
                  ) : null}

                  {overviewManagePanel === 'staff' ? (
                    <div className="admin-overview-manage-panel">
                      <PharmacyStaffManager key={selectedPharmacy.id} organisation={selectedPharmacy} onCountChange={updateSelectedStaffCount} />
                    </div>
                  ) : null}

                  {overviewManagePanel === 'setup' ? (
                    <div className="admin-overview-manage-panel">
                      <AdminGoLivePanel
                        organisation={selectedPharmacy}
                        goLiveError={goLiveError}
                        goLiveBusy={goLiveBusy}
                        onFlipLive={() => void flipPharmacyLive(selectedPharmacy.id)}
                        onReverted={status => dispatch({ type: 'UPDATE_ORGANISATION', organisationId: selectedPharmacy.id, updates: { status } })}
                      />
                    </div>
                  ) : null}

                  {overviewManagePanel === 'curaleaf' ? (
                    <div className="admin-overview-manage-panel">
                      <section className="card admin-detail-card">
                        <div className="admin-detail-card-title"><LockKeyhole size={18} /><h2>Curaleaf connection</h2></div>
                        <p>Credentials are protected server-side and never returned to the portal. Rotate the API key or refresh the live connection for this pharmacy here.</p>
                        <CuraleafConnectionPanel
                          key={selectedPharmacy.id}
                          organisationId={selectedPharmacy.id}
                          customerIdHint={selectedPharmacy.curaleafPharmacyCode}
                        />
                      </section>
                    </div>
                  ) : null}
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
              <strong>{organisation?.tradingName ?? submission.pharmacyName}</strong>
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
        <AdminIntakeV2 />
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

  const renderReferrals = () => <AdminIntakeV2 />;

  const renderPatients = () => {
    const registerStatuses = [...new Set([...patientStatuses, ...displayedPatients.map(patient => patient.stage)])].sort((a, b) => onboardingStatusLabel(a).localeCompare(onboardingStatusLabel(b)));
    const activeCount = allPatients.filter(patient => patient.stage === 'HHH approved').length;
    const referredCount = allPatients.filter(patient => patient.stage === 'Approved').length;
    const financeReady = isLocalPortalPreview || Boolean(adminFinanceReport) || !adminFinanceLoading;
    const registerAccrued = referralFeeEvents.reduce((total, event) => total + event.amount, 0);
    const selectedKey = selectedRegisterPatient ? registerPatientKey(selectedRegisterPatient) : null;
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
    const filtersActive = Boolean(query.trim() || patientOrganisationId !== 'all' || patientStatus !== 'all' || patientFrom || patientTo);

    return (
      <div className="page-body order-crm patient-crm admin-register-crm">
        <section className="order-crm-summary" aria-label="Patient register summary">
          <article className="order-crm-metric">
            <span className="order-crm-metric__icon"><Users size={16} /></span>
            <span><small>Register</small><strong>{isLocalPortalPreview ? allPatients.length : (serverPatientRegister?.resultCount ?? displayedPatients.length)}</strong><em>{isLocalPortalPreview ? 'Attributed records in this preview' : 'Records in the current server scope'}</em></span>
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
        </section>

        <section className="order-crm-controls">
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
          <div className="order-crm-filters" role="group" aria-label="Filter the patient register">
            <button type="button" className={patientStatus === 'all' ? 'active' : ''} aria-pressed={patientStatus === 'all'} onClick={() => setPatientStatus('all')}>
              <span>All</span>
            </button>
            {registerStatuses.map(status => (
              <button type="button" key={status} className={patientStatus === status ? 'active' : ''} aria-pressed={patientStatus === status} onClick={() => setPatientStatus(status)}>
                <span>{onboardingStatusLabel(status)}</span>
              </button>
            ))}
            <label className="admin-register-crm__select">
              <span className="sr-only">Pharmacy</span>
              <select value={patientOrganisationId} onChange={event => setPatientOrganisationId(event.target.value)} aria-label="Filter by pharmacy">
                <option value="all">All pharmacies</option>
                {state.organisations.map(organisation => <option key={organisation.id} value={organisation.id}>{organisation.tradingName}</option>)}
              </select>
            </label>
            <label className="admin-register-crm__date">
              <span className="sr-only">From date</span>
              <input type="date" value={patientFrom} max={patientTo || undefined} onChange={event => setPatientFrom(event.target.value)} aria-label="From date" />
            </label>
            <label className="admin-register-crm__date">
              <span className="sr-only">To date</span>
              <input type="date" value={patientTo} min={patientFrom || undefined} onChange={event => setPatientTo(event.target.value)} aria-label="To date" />
            </label>
            {filtersActive ? (
              <button type="button" onClick={() => { setQuery(''); setPatientOrganisationId('all'); setPatientStatus('all'); setPatientFrom(''); setPatientTo(''); }}>
                Clear
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void exportPatients()}
              disabled={patientExportBusy || patientRegisterLoading || (!isLocalPortalPreview && !serverPatientRegister)}
            >
              <Download size={14} /> {patientExportBusy ? 'Preparing CSV…' : patientRegisterLoading ? 'Loading scope…' : 'Export CSV'}
            </button>
          </div>
        </section>

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
              <span><small>Register</small><strong>{patientRegisterLoading && !isLocalPortalPreview ? 'Loading' : `${displayedPatients.length} result${displayedPatients.length === 1 ? '' : 's'}`}</strong></span>
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
                    <strong>No matching records</strong>
                    <span>Try another search, pharmacy, stage or date range.</span>
                  </div>
                ) : displayedPatients.map(patient => {
                  const row = toRegisterRow(patient);
                  const tone = stageTone(row.stage);
                  const selected = selectedKey === registerPatientKey(row);
                  return (
                    <button
                      type="button"
                      key={registerPatientKey(row)}
                      className={`order-crm-row order-crm-row--${tone}${selected ? ' selected' : ''}`}
                      aria-pressed={selected}
                      aria-label={`${row.name}, ${onboardingStatusLabel(row.stage)}, ${row.pharmacyName}`}
                      onClick={() => setSelectedRegisterPatient(row)}
                    >
                      <span className={`order-crm-row__stage order-tone--${tone}`} aria-hidden="true">{patientInitials(row.name)}</span>
                      <span className="order-crm-row__identity">
                        <strong title={row.name}>{compactPatientName(row.name)}</strong>
                        <span className={`order-stage-pill order-tone--${tone}`}>{onboardingStatusLabel(row.stage)}</span>
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
                        <em>{selectedRegisterPatient.pharmacyName}{selectedRegisterPatient.gphcNumber ? ` · GPhC ${selectedRegisterPatient.gphcNumber}` : ''}</em>
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
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          const feeMatch = selectedFees[0];
                          setFinanceOrganisationId(selectedRegisterPatient.organisationId);
                          setFinancePatientKey(feeMatch?.patientKey ?? 'all');
                          setFinancePeriod('all');
                          setView('finance');
                        }}
                      >
                        Open ledger
                      </button>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => openPharmacyOnOverview(selectedRegisterPatient.organisationId, 'identity')}>Manage pharmacy</button>
                    </div>
                  </div>
                </header>

                <div className="patient-crm-detail__body">
                  <div className="admin-overview-crm__facts">
                    <article>
                      <small>Last recorded</small>
                      <strong>{selectedRegisterPatient.date ? new Date(selectedRegisterPatient.date).toLocaleDateString('en-GB', { timeZone: 'Europe/London' }) : '—'}</strong>
                    </article>
                    <article>
                      <small>First dispenses</small>
                      <strong>{financeReady ? referralFeeFormatter.format(selectedFees.filter(event => event.kind === 'new-referral').reduce((sum, event) => sum + event.amount, 0)) : '—'}</strong>
                      <em>{selectedFees.filter(event => event.kind === 'new-referral').length} × £50</em>
                    </article>
                    <article>
                      <small>Annual fees</small>
                      <strong>{financeReady ? referralFeeFormatter.format(selectedFees.filter(event => event.kind === 'annual-patient').reduce((sum, event) => sum + event.amount, 0)) : '—'}</strong>
                      <em>{selectedFees.filter(event => event.kind === 'annual-patient').length} × £40</em>
                    </article>
                    <article>
                      <small>Intake</small>
                      <strong>{selectedIntake?.source ?? (selectedCrm ? 'Record' : 'Register')}</strong>
                      <em>{selectedIntake ? onboardingStatusLabel(selectedIntake.status) : selectedCrm ? onboardingStatusLabel(selectedCrm.status) : 'Not in queue'}</em>
                    </article>
                  </div>

                  <section className="admin-register-crm__panel">
                    <h3>Attribution and intake</h3>
                    <dl className="admin-register-crm__facts-list">
                      <div>
                        <dt>Date of birth</dt>
                        <dd>{formatPatientDob(selectedRegisterPatient.dob)}</dd>
                      </div>
                      <div>
                        <dt>Email</dt>
                        <dd>{selectedRegisterPatient.email || 'Not recorded'}</dd>
                      </div>
                      <div>
                        <dt>Mobile</dt>
                        <dd>{selectedRegisterPatient.mobile || 'Not recorded'}</dd>
                      </div>
                      <div>
                        <dt>Current pharmacy</dt>
                        <dd>{selectedRegisterPatient.pharmacyName}</dd>
                      </div>
                      <div>
                        <dt>GPhC</dt>
                        <dd>{selectedRegisterPatient.gphcNumber || 'Not recorded'}</dd>
                      </div>
                      <div>
                        <dt>Current outcome</dt>
                        <dd>{onboardingStatusLabel(selectedRegisterPatient.stage)}</dd>
                      </div>
                    </dl>
                  </section>

                  <section className="admin-register-crm__panel">
                    <h3>Fee history</h3>
                    {selectedFees.length === 0 ? (
                      <p>No first-dispense or annual fees are recorded for this patient.</p>
                    ) : (
                      <ol className="admin-register-crm__events">
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
                  </section>

                  <section className="admin-register-crm__panel">
                    <h3>Order activity</h3>
                    {orderActivity.count === 0 ? (
                      <p>No placed orders recorded for this patient.</p>
                    ) : (
                      <>
                        <dl className="admin-register-crm__facts-list">
                          <div>
                            <dt>Orders placed</dt>
                            <dd>{orderActivity.count}</dd>
                          </div>
                          <div>
                            <dt>Last ordered</dt>
                            <dd>{londonDayLabel(orderActivity.dates[0])}</dd>
                          </div>
                        </dl>
                        <p className="admin-register-crm__order-dates">
                          {orderActivity.uniqueDays.slice(0, 8).join(' · ')}
                          {orderActivity.uniqueDays.length > 8 ? ` · ${orderActivity.uniqueDays.length - 8} earlier` : ''}
                        </p>
                      </>
                    )}
                    <p className="admin-overview-crm__note">HHH admin does not show what was ordered.</p>
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

    return (
      <div className="page-body order-crm patient-crm admin-finance-crm">
        <section className="order-crm-summary" aria-label="Referral finance summary">
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
        </section>

        <section className="order-crm-controls">
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
          <div className="order-crm-filters" role="group" aria-label="Filter referral finance">
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
            <label className="admin-register-crm__select">
              <span className="sr-only">Pharmacy</span>
              <select id="finance-pharmacy" value={financeOrganisationId} onChange={event => setFinanceOrganisationId(event.target.value)} aria-label="Filter by pharmacy">
                <option value="all">All pharmacies</option>
                {state.organisations.filter(organisation => !isTrainingDirectoryPharmacy(organisation)).map(organisation => <option value={organisation.id} key={organisation.id}>{organisation.tradingName}</option>)}
              </select>
            </label>
            {financePeriod === 'month' ? (
              <label className="admin-register-crm__date">
                <span className="sr-only">Month</span>
                <input id="finance-month" type="month" value={financeMonth} onChange={event => setFinanceMonth(event.target.value)} aria-label="Reporting month" />
              </label>
            ) : null}
            {financePeriod === 'year' ? (
              <label className="admin-register-crm__date">
                <span className="sr-only">Year</span>
                <input id="finance-year" type="number" min="2000" max="2200" step="1" value={financeYear} onChange={event => setFinanceYear(event.target.value)} aria-label="Reporting year" />
              </label>
            ) : null}
            <button type="button" className="btn btn-sm" onClick={() => setAdminFinanceRefresh(value => value + 1)} disabled={adminFinanceLoading}>
              <RefreshCw size={13} className={adminFinanceLoading ? 'spin' : ''} /> Refresh
            </button>
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

                <div className="patient-crm-detail__body">
                  <div className="admin-overview-crm__facts">
                    <article>
                      <small>First dispenses</small>
                      <strong>{referralFeeFormatter.format(selectedFirst.reduce((sum, event) => sum + event.amount, 0))}</strong>
                      <em>{selectedFirst.length} × £50</em>
                    </article>
                    <article>
                      <small>Annual fees</small>
                      <strong>{referralFeeFormatter.format(selectedAnnual.reduce((sum, event) => sum + event.amount, 0))}</strong>
                      <em>{selectedAnnual.length} × £40</em>
                    </article>
                    <article>
                      <small>Events</small>
                      <strong>{selectedFinanceEvents.length}</strong>
                      <em>{periodLabel}</em>
                    </article>
                    <article>
                      <small>Pharmacy</small>
                      <strong>{selectedFinancePatient.pharmacyName}</strong>
                    </article>
                  </div>

                  <section className="admin-register-crm__panel">
                    <h3>Fee events</h3>
                    {selectedFinanceEvents.length === 0 ? (
                      <p>No fee events remain for this patient after the current filters.</p>
                    ) : (
                      <ol className="admin-register-crm__events">
                        {selectedFinanceEvents.map(event => (
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
                  </section>

                  <p className="admin-overview-crm__note">Referral fees accrue on the first collected dispense (£50) and each active anniversary (£40). This is an operational ledger, not an invoice or payment-receipt register.</p>

                  <section className="admin-register-crm__panel admin-register-crm__later">
                    <h3>Invoices and settlements</h3>
                    <p>Not in the current finance contract. When the server returns invoice, settlement or payout fields, they will appear in this pane.</p>
                  </section>
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
      <AdminHeader view={view} pending={pendingAdminDecisions} setView={next => { setView(next); setQuery(''); }} onViewAdmins={() => { setAdminDialogFocus('list'); setShowAdminDialog(true); }} />
      <div className="app-main">
        <WorkspacePageHeader section="HHH operations" context={pageMeta[view].title} title={pageMeta[view].title} commandLabel="Find anything" onSectionClick={() => { setView('overview'); setQuery(''); }} backAction={view !== 'overview' ? { label: 'Return to pharmacies', onClick: () => { setView('overview'); setQuery(''); } } : undefined} contextControl={<div className="header-context"><span>Access</span><span className="tenant-status tenant-status--live">Admin</span></div>} />
        <div id="admin-main-content" className="page-container admin-content" tabIndex={-1}>
          {view === 'overview' && renderOverview()}
          {view === 'referrals' && renderReferrals()}
          {view === 'patients' && renderPatients()}
          {view === 'finance' && renderFinance()}
        </div>
      </div>
      {showOnboarding && <OnboardPharmacy onClose={() => setShowOnboarding(false)} onCreated={id => { setShowOnboarding(false); openPharmacyOnOverview(id, 'identity'); }} />}
      {showAdminDialog ? <PlatformAdminDialog onClose={() => setShowAdminDialog(false)} focusInvite={adminDialogFocus === 'invite'} /> : null}
      {showPharmacyEditor && overviewPharmacy ? (
        <EditPharmacy
          key={overviewPharmacy.id}
          organisation={overviewPharmacy}
          onClose={() => setShowPharmacyEditor(false)}
          onSaved={updates => {
            dispatch({ type: 'UPDATE_ORGANISATION', organisationId: overviewPharmacy.id, updates });
            dispatch({ type: 'ADD_TOAST', message: `${updates.tradingName ?? overviewPharmacy.tradingName} details saved to Firebase.`, toastType: 'success' });
          }}
        />
      ) : null}
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
