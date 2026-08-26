import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { organisationAddressFields } from '../utils/organisationAddress';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Copy,
  CreditCard,
  Download,
  ExternalLink,
  FileArchive,
  Link2,
  QrCode,
  RefreshCw,
  Save,
  ShieldCheck,
  Tags,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { brandSwatchStyle } from '../utils/tenantTheme';
import { getCuraleafConnectionStatus, getReferralLink, isApiConfigured, updatePaymentSettings, updatePharmacyProfile } from '../shared/api';
import type { CuraleafConnectionStatus } from '../shared/contracts';
import WorldpayConnectionPanel from '../components/WorldpayConnectionPanel';
import { downloadContentPack, downloadDataUrl, eligibilityUrl, qrDataUrl } from '../utils/pharmacyResources';
import { isLocalPortalPreview } from '../dev/localPortalPreview';

export default function PharmacySettings() {
  const { state, dispatch } = useApp();
  const organisation = useMemo(() => state.organisations.find(org => org.id === state.currentOrganisationId) ?? state.organisations[0], [state]);
  const [activeTab, setActiveTab] = useState<'settings' | 'assets'>('settings');
  const [savingRoute, setSavingRoute] = useState(false);
  const [qr, setQr] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [linkLoading, setLinkLoading] = useState(true);
  const [linkError, setLinkError] = useState('');
  const [linkRefresh, setLinkRefresh] = useState(0);
  const [curaleafStatus, setCuraleafStatus] = useState<CuraleafConnectionStatus | null>(null);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileForm, setProfileForm] = useState({
    tradingName: '',
    name: '',
    gphcNumber: '',
    superintendent: '',
    addressLine1: '',
    addressLine2: '',
    locality: '',
    county: '',
    postcode: '',
    mainContactName: '',
    mainContactPhone: '',
    mainContactEmail: '',
  });

  useEffect(() => {
    const address = organisationAddressFields(organisation);
    setProfileForm({
      tradingName: organisation.tradingName,
      name: organisation.name,
      gphcNumber: organisation.gphcNumber,
      superintendent: organisation.superintendent,
      addressLine1: address.addressLine1,
      addressLine2: address.addressLine2,
      locality: address.locality,
      county: address.county,
      postcode: address.postcode,
      mainContactName: organisation.mainContactName ?? '',
      mainContactPhone: organisation.mainContactPhone ?? '',
      mainContactEmail: organisation.mainContactEmail ?? '',
    });
  }, [organisation]);

  useEffect(() => {
    let cancelled = false;
    if (activeTab !== 'assets') {
      setFormUrl('');
      setQr('');
      setLinkError('');
      setLinkLoading(false);
      return;
    }
    setFormUrl('');
    setQr('');
    setLinkError('');
    setLinkLoading(true);
    const request = isLocalPortalPreview
      ? Promise.resolve({ url: eligibilityUrl(organisation.referralToken) })
      : getReferralLink();
    void request
      .then(result => { if (!cancelled) setFormUrl(result.url); })
      .catch(error => { if (!cancelled) setLinkError(error instanceof Error ? error.message : 'The eligibility link could not be loaded.'); })
      .finally(() => { if (!cancelled) setLinkLoading(false); });
    return () => { cancelled = true; };
  }, [activeTab, organisation.id, organisation.referralToken, linkRefresh]);

  useEffect(() => {
    let cancelled = false;
    if (isLocalPortalPreview) return () => { cancelled = true; };
    void getCuraleafConnectionStatus()
      .then(status => { if (!cancelled) setCuraleafStatus(status); })
      .catch(() => { if (!cancelled) setCuraleafStatus(null); });
    return () => { cancelled = true; };
  }, [organisation.id]);

  useEffect(() => {
    let cancelled = false;
    if (!formUrl) { setQr(''); return; }
    void qrDataUrl(formUrl)
      .then(value => { if (!cancelled) setQr(value); })
      .catch(() => { if (!cancelled) setLinkError('The eligibility QR code could not be generated safely.'); });
    return () => { cancelled = true; };
  }, [formUrl]);

  const notify = (message: string) => dispatch({ type: 'ADD_TOAST', message, toastType: 'success' });
  const copyLink = async () => {
    if (!formUrl) return;
    await navigator.clipboard.writeText(formUrl);
    notify('Pharmacy eligibility link copied to clipboard.');
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    setProfileSaving(true);
    try {
      if (!isLocalPortalPreview && isApiConfigured) {
        await updatePharmacyProfile(profileForm);
      }
      dispatch({
        type: 'UPDATE_ORGANISATION',
        organisationId: organisation.id,
        updates: {
          tradingName: profileForm.tradingName,
          name: profileForm.name,
          gphcNumber: profileForm.gphcNumber,
          superintendent: profileForm.superintendent,
          addressLine1: profileForm.addressLine1,
          addressLine2: profileForm.addressLine2 || undefined,
          locality: profileForm.locality,
          county: profileForm.county || undefined,
          postcode: profileForm.postcode.toUpperCase(),
          address: [profileForm.addressLine1, profileForm.addressLine2, profileForm.locality, profileForm.county, profileForm.postcode.toUpperCase()].filter(Boolean).join(', '),
          mainContactName: profileForm.mainContactName || undefined,
          mainContactPhone: profileForm.mainContactPhone || undefined,
          mainContactEmail: profileForm.mainContactEmail || undefined,
        },
      });
      notify('Pharmacy details saved.');
    } catch (error) {
      dispatch({ type: 'ADD_TOAST', message: error instanceof Error ? error.message : 'Pharmacy details could not be saved.', toastType: 'error' });
    } finally {
      setProfileSaving(false);
    }
  };

  const setPaymentRoute = async (route: 'manual' | 'worldpay') => {
    if (route === 'worldpay' && organisation.worldpay.status !== 'connected') {
      dispatch({ type: 'ADD_TOAST', message: 'Verify this pharmacy’s Worldpay merchant connection before making it the default.', toastType: 'warning' });
      return;
    }
    const previousRoute = organisation.defaultPaymentRoute;
    setSavingRoute(true);
    dispatch({ type: 'UPDATE_ORGANISATION', organisationId: organisation.id, updates: { defaultPaymentRoute: route } });
    dispatch({ type: 'UPDATE_WORLDPAY', organisationId: organisation.id, updates: { enabled: route === 'worldpay' } });
    try {
      if (!isLocalPortalPreview && isApiConfigured) await updatePaymentSettings(organisation.id, route);
      dispatch({ type: 'ADD_TOAST', message: `${route === 'worldpay' ? 'Worldpay' : 'Pharmacy payment'} will be used for new orders. Existing orders are unchanged.`, toastType: 'success' });
    } catch (error) {
      dispatch({ type: 'UPDATE_ORGANISATION', organisationId: organisation.id, updates: { defaultPaymentRoute: previousRoute } });
      dispatch({ type: 'UPDATE_WORLDPAY', organisationId: organisation.id, updates: { enabled: previousRoute === 'worldpay' } });
      dispatch({ type: 'ADD_TOAST', message: error instanceof Error ? error.message : 'Payment settings could not be saved.', toastType: 'error' });
    } finally {
      setSavingRoute(false);
    }
  };

  return (
    <div className="page-body settings-page">
      <section className="settings-identity card">
        <div className="tenant-mark" style={brandSwatchStyle(organisation.brand.primary)}>{organisation.logoText}</div>
        <div>
          <p className="section-label">Organisation profile</p>
          <h2>{organisation.brand.portalName}</h2>
          <p>{organisation.name} · GPhC {organisation.gphcNumber}</p>
        </div>
        <span className={`pill ${organisation.status === 'paused' ? 'pill-red' : state.workspaceMode === 'live' ? 'pill-green' : 'pill-amber'}`}>
          {organisation.status === 'paused' ? 'Paused' : state.workspaceMode === 'live' ? 'Live' : 'Training'}
        </span>
      </section>

      <div className="filter-grid settings-tabs" role="group" aria-label="Settings views">
        <button type="button" aria-pressed={activeTab === 'settings'} className={`filter-card ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')}>
          <div className="filter-card__head"><span>Organisation</span><Building2 size={14} className={activeTab === 'settings' ? 'text-primary' : 'text-muted'} /></div>
          <span className="filter-card__value filter-card__value--text">Profile & payments</span>
        </button>
        <button type="button" aria-pressed={activeTab === 'assets'} className={`filter-card ${activeTab === 'assets' ? 'active' : ''}`} onClick={() => setActiveTab('assets')}>
          <div className="filter-card__head"><span>Assets</span><QrCode size={14} className={activeTab === 'assets' ? 'text-primary' : 'text-muted'} /></div>
          <span className="filter-card__value filter-card__value--text">Intake link, QR & content pack</span>
        </button>
      </div>

      {activeTab === 'settings' ? (
        <div className="settings-stack">
          <section className="card settings-panel settings-panel--profile">
            <div className="section-heading">
              <div>
                <p className="section-label">Pharmacy details</p>
                <h3><Building2 size={17} /> Public profile & contact</h3>
              </div>
            </div>
            <p className="settings-copy">Update trading name, GPhC registration, address and contact details if anything is incorrect. Branding and go-live status remain managed by HHH.</p>
            <form className="settings-profile-form" onSubmit={event => void saveProfile(event)}>
              <div className="settings-profile-grid">
                <label>Trading name<input className="input" value={profileForm.tradingName} onChange={event => setProfileForm(current => ({ ...current, tradingName: event.target.value }))} required /></label>
                <label>Registered company name<input className="input" value={profileForm.name} onChange={event => setProfileForm(current => ({ ...current, name: event.target.value }))} required /></label>
                <label>GPhC number<input className="input" value={profileForm.gphcNumber} onChange={event => setProfileForm(current => ({ ...current, gphcNumber: event.target.value }))} required /></label>
                <label>Superintendent pharmacist<input className="input" value={profileForm.superintendent} onChange={event => setProfileForm(current => ({ ...current, superintendent: event.target.value }))} required /></label>
                <label>Address line 1<input className="input" value={profileForm.addressLine1} onChange={event => setProfileForm(current => ({ ...current, addressLine1: event.target.value }))} autoComplete="address-line1" required /></label>
                <label>Address line 2<input className="input" value={profileForm.addressLine2} onChange={event => setProfileForm(current => ({ ...current, addressLine2: event.target.value }))} autoComplete="address-line2" /></label>
                <label>Town or city<input className="input" value={profileForm.locality} onChange={event => setProfileForm(current => ({ ...current, locality: event.target.value }))} autoComplete="address-level2" required /></label>
                <label>County<input className="input" value={profileForm.county} onChange={event => setProfileForm(current => ({ ...current, county: event.target.value }))} autoComplete="address-level1" /></label>
                <label>Postcode<input className="input" value={profileForm.postcode} onChange={event => setProfileForm(current => ({ ...current, postcode: event.target.value.toUpperCase() }))} autoComplete="postal-code" required /></label>
                <label>Main contact name<input className="input" value={profileForm.mainContactName} onChange={event => setProfileForm(current => ({ ...current, mainContactName: event.target.value }))} /></label>
                <label>Main contact phone<input className="input" type="tel" value={profileForm.mainContactPhone} onChange={event => setProfileForm(current => ({ ...current, mainContactPhone: event.target.value }))} /></label>
                <label className="settings-profile-grid__wide">Main contact email<input className="input" type="email" value={profileForm.mainContactEmail} onChange={event => setProfileForm(current => ({ ...current, mainContactEmail: event.target.value }))} /></label>
              </div>
              <div className="settings-actions">
                <button type="submit" className="btn btn-primary" disabled={profileSaving}><Save size={14} /> {profileSaving ? 'Saving…' : 'Save pharmacy details'}</button>
              </div>
            </form>
          </section>

          <section className="card settings-panel">
            <div className="section-heading">
              <div>
                <p className="section-label">Default payment route</p>
                <h3><CreditCard size={17} /> How new orders take payment</h3>
              </div>
              <span className={`pill ${organisation.defaultPaymentRoute === 'worldpay' ? 'pill-green' : 'pill-neutral'}`}>
                {organisation.defaultPaymentRoute === 'worldpay' ? 'Worldpay' : 'Pharmacy payment'}
              </span>
            </div>

            <div className="payment-route-settings" role="radiogroup" aria-label="Default payment route">
              <button type="button" role="radio" aria-checked={organisation.defaultPaymentRoute === 'manual'} disabled={savingRoute} onClick={() => void setPaymentRoute('manual')}>
                <span><strong>Pharmacy payment</strong><small>EPOS, cash, bank transfer or another pharmacy-controlled route.</small></span>
                {organisation.defaultPaymentRoute === 'manual' ? <CheckCircle2 size={16} /> : null}
              </button>
              <button type="button" role="radio" aria-checked={organisation.defaultPaymentRoute === 'worldpay'} disabled={savingRoute || organisation.worldpay.status !== 'connected'} onClick={() => void setPaymentRoute('worldpay')}>
                <span><strong>Worldpay hosted checkout</strong><small>{organisation.worldpay.status === 'connected' ? 'Verified merchant connection; settlement goes directly to this pharmacy.' : 'Connect and verify the pharmacy merchant account below first.'}</small></span>
                {organisation.defaultPaymentRoute === 'worldpay' ? <CheckCircle2 size={16} /> : null}
              </button>
            </div>

            {organisation.worldpay.status === 'connected' && (
              <div className="connection-summary">
                <div><span>Environment</span><strong>{organisation.worldpay.environment === 'live' ? 'Live' : 'Try'}</strong></div>
                <div><span>Merchant entity</span><strong>{organisation.worldpay.merchantId ?? 'Stored'}</strong></div>
                <div><span>Patient payment route</span><strong>{organisation.defaultPaymentRoute === 'worldpay' ? 'Worldpay' : 'Managed by pharmacy'}</strong></div>
              </div>
            )}

            <div className="settings-note"><ShieldCheck size={16} /><span>Worldpay is optional. Connect the merchant here when you are ready. Each order permanently records the route selected when that order is created.</span></div>
            <WorldpayConnectionPanel
              organisationId={organisation.id}
              onConnected={connection => {
                dispatch({
                  type: 'UPDATE_WORLDPAY',
                  organisationId: organisation.id,
                  updates: {
                    status: connection.connected ? 'connected' : connection.configured ? 'onboarding' : 'not-connected',
                    environment: connection.environment === 'live' ? 'live' : 'sandbox',
                    merchantId: connection.maskedIdentifier ?? null,
                    lastSyncedAt: connection.updatedAt ?? new Date().toISOString(),
                  },
                });
                if (!connection.connected && organisation.defaultPaymentRoute === 'worldpay') {
                  dispatch({ type: 'UPDATE_ORGANISATION', organisationId: organisation.id, updates: { defaultPaymentRoute: 'manual' } });
                  if (!isLocalPortalPreview && isApiConfigured) {
                    void updatePaymentSettings(organisation.id, 'manual').catch(() => {
                      dispatch({ type: 'ADD_TOAST', message: 'Worldpay was disconnected. Default payment route still needs switching to pharmacy payment.', toastType: 'warning' });
                    });
                  }
                }
              }}
            />
          </section>

          <div className="settings-split">
            <section className="card settings-panel">
              <div className="section-heading">
                <div>
                  <p className="section-label">Pricing</p>
                  <h3><Tags size={17} /> Curaleaf prices & dispensing</h3>
                </div>
              </div>
              <div className="settings-meta-grid">
                <div><span>Curaleaf connection</span><strong>{curaleafStatus?.connected ? 'Connected' : curaleafStatus?.status?.replaceAll('_', ' ') ?? 'Managed by HHH'}</strong></div>
                <div><span>Curaleaf customer ID</span><strong>{curaleafStatus?.customerId ?? 'Not assigned'}</strong></div>
                <div><span>Dispensing charge</span><strong>£5, £10, £15 or custom</strong></div>
              </div>
              <p className="settings-copy">Curaleaf supplies patient price and wholesale cost. Your team can only add an optional dispensing charge while building an order.</p>
              <button type="button" className="btn btn-secondary" onClick={() => dispatch({ type: 'SET_SCREEN', screen: 'formulary' })}>Open Curaleaf catalogue</button>
            </section>

            <section className="card settings-panel">
              <div className="section-heading">
                <div>
                  <p className="section-label">Readiness</p>
                  <h3><ShieldCheck size={17} /> Operational status</h3>
                </div>
                <CheckCircle2 size={20} className="text-green" />
              </div>
              <div className="settings-meta-grid">
                <div><span>Workspace</span><strong>{state.workspaceMode === 'live' ? 'Live' : 'Training'}</strong></div>
                <div><span>Intake link</span><strong>{organisation.status === 'paused' ? 'Off' : 'Live'}</strong></div>
              </div>
              <p className="settings-copy">{state.workspaceMode === 'live' ? 'This pharmacy can see patients HHH has referred here and can dispense.' : 'Enquiries already go to HHH. This workspace shows training examples until HHH flips you to live.'}</p>
            </section>
          </div>

        </div>
      ) : (
        <div className="settings-stack">
          {linkError ? <div className="banner banner-red" role="alert"><AlertTriangle size={16} /><span>{linkError}</span><button className="btn btn-sm" type="button" onClick={() => setLinkRefresh(value => value + 1)}><RefreshCw size={14} /> Retry</button></div> : null}
          <div className="alert-success settings-assets-banner">
            <Link2 size={18} />
            <div>
              <strong>Submissions from this link are attributed to {organisation.name}</strong>
              <span>Keep the token pharmacy-specific. Do not share another pharmacy’s URL.</span>
            </div>
          </div>

          <div className="settings-split settings-split--assets">
            <section className="card settings-panel">
              <div className="section-heading">
                <div>
                  <p className="section-label">Patient intake link</p>
                  <h3><Link2 size={17} /> Share the eligibility form</h3>
                </div>
              </div>
              <p className="settings-copy">The form stays hosted by HHH. Use this URL on the pharmacy website, email, or counter materials.</p>
              <div className="resource-url" aria-live="polite">{linkLoading ? 'Loading the protected pharmacy link…' : formUrl || 'Link unavailable'}</div>
              <div className="settings-actions">
                <button className="btn btn-primary" type="button" disabled={!formUrl} onClick={copyLink}><Copy size={14} /> Copy link</button>
                {formUrl ? <a className="btn btn-secondary" href={formUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Preview form</a> : <button className="btn btn-secondary" type="button" disabled><ExternalLink size={14} /> Preview form</button>}
              </div>
            </section>

            <section className="card settings-panel settings-panel--center">
              <div className="section-heading">
                <div>
                  <p className="section-label">Print-ready QR</p>
                  <h3><QrCode size={17} /> Leaflets & counter cards</h3>
                </div>
              </div>
              {qr ? (
                <img className="resource-qr" src={qr} alt={`Eligibility QR code for ${organisation.name}`} />
              ) : (
                <div className="resource-qr-placeholder">{linkError ? 'QR unavailable' : 'Generating QR…'}</div>
              )}
              <button
                className="btn btn-primary"
                type="button"
                disabled={!qr}
                onClick={() => { downloadDataUrl(qr, `${organisation.slug}-eligibility-qr.png`); notify('High-resolution QR code saved.'); }}
              >
                <Download size={14} /> Save QR code
              </button>
            </section>
          </div>

          <section className="card settings-panel settings-pack">
            <div className="settings-pack__copy">
              <div className="resource-icon"><FileArchive size={20} /></div>
              <div>
                <p className="section-label">Developer hand-off</p>
                <h3>Pharmacy website content pack</h3>
                <p className="settings-copy">Suggested page copy, hosted-form link, QR usage notes and high-resolution QR image.</p>
              </div>
            </div>
            <button
              className="btn btn-primary"
              type="button"
              disabled={!formUrl}
              onClick={async () => { await downloadContentPack(organisation, formUrl); notify('Developer content pack created.'); }}
            >
              <FileArchive size={15} /> Download content pack (.zip)
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
