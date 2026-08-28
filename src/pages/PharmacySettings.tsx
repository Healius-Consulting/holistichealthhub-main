import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
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
  Pencil,
  QrCode,
  RefreshCw,
  Save,
  ShieldCheck,
  Tags,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { brandSwatchStyle } from '../utils/tenantTheme';
import { ApiRequestError, getCuraleafConnectionStatus, getReferralLink, isApiConfigured, refreshCuraleafConnection, updatePaymentSettings, updatePharmacyProfile } from '../shared/api';
import type { CuraleafConnectionStatus } from '../shared/contracts';
import WorldpayConnectionPanel from '../components/WorldpayConnectionPanel';
import { downloadContentPack, downloadDataUrl, eligibilityUrl, qrDataUrl } from '../utils/pharmacyResources';
import { isLocalPortalPreview } from '../dev/localPortalPreview';
import './PharmacySettings.css';

/** A verification is only reassuring if staff can see how recent it is. */
function formatLastVerified(value: Date | string | null): string {
  if (!value) return 'Not yet checked';
  const when = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(when.getTime())) return 'Not yet checked';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(when);
}

export default function PharmacySettings() {
  const { state, dispatch } = useApp();
  const organisation = useMemo(() => state.organisations.find(org => org.id === state.currentOrganisationId) ?? state.organisations[0], [state]);
  const [activeTab, setActiveTab] = useState<'settings' | 'assets'>('settings');
  const [savingRoute, setSavingRoute] = useState(false);
  const [savingDelivery, setSavingDelivery] = useState(false);
  const [worldpayRefreshControl, setWorldpayRefreshControl] = useState<{ refresh: () => void; busy: boolean } | null>(null);
  const [qr, setQr] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [linkLoading, setLinkLoading] = useState(true);
  const [linkError, setLinkError] = useState('');
  const [linkRefresh, setLinkRefresh] = useState(0);
  const [curaleafStatus, setCuraleafStatus] = useState<CuraleafConnectionStatus | null>(null);
  const [curaleafRefreshing, setCuraleafRefreshing] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  // Read-only is the resting state: these details are correct far more often than
  // they are wrong, and a page of live inputs invites accidental edits to a
  // pharmacy's registered name or GPhC number.
  const [editingProfile, setEditingProfile] = useState(false);
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

  const profileFromOrganisation = useCallback(() => {
    const address = organisationAddressFields(organisation);
    return {
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
    };
  }, [organisation]);

  useEffect(() => {
    setProfileForm(profileFromOrganisation());
  }, [profileFromOrganisation]);

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

  const refreshCuraleaf = async () => {
    setCuraleafRefreshing(true);
    // A refresh that fell back to the read-only status did not actually re-test
    // anything, so it must not be reported back as a successful re-test.
    let readOnlyFallback = false;
    try {
      // Preview has no write endpoint, so re-read the status instead of forcing a refresh.
      const status = isLocalPortalPreview
        ? await getCuraleafConnectionStatus(organisation.id)
        : await refreshCuraleafConnection(organisation.id).catch(async error => {
          // A role wall on the probe is not an outage. Fall back to the read-only
          // status endpoint so staff still see the truth about the connection.
          if (error instanceof ApiRequestError && error.status === 403) {
            readOnlyFallback = true;
            const readOnly = await getCuraleafConnectionStatus(organisation.id);
            dispatch({
              type: 'ADD_TOAST',
              message: 'Your role cannot re-test the Curaleaf credential. Showing the last recorded connection state instead.',
              toastType: 'warning',
            });
            return readOnly;
          }
          throw error;
        });
      setCuraleafStatus(status);
      // The catalogue is the thing staff actually came here to unstick.
      dispatch({ type: 'REQUEST_CATALOGUE_REFRESH' });
      // Pressing a button and watching nothing change reads as a broken button,
      // so a refresh that worked says so — and one that came back disconnected
      // says that instead of claiming success.
      if (!readOnlyFallback) {
        dispatch({
          type: 'ADD_TOAST',
          dedupeKey: 'curaleaf-refresh',
          message: status?.connected === false
            ? 'Curaleaf answered but the connection is not usable. Contact your HHH administrator.'
            : 'Curaleaf connection re-tested and the product catalogue is reloading.',
          toastType: status?.connected === false ? 'warning' : 'success',
        });
      }
    } catch (error) {
      dispatch({
        type: 'ADD_TOAST',
        dedupeKey: 'curaleaf-refresh',
        message: error instanceof ApiRequestError && error.status >= 500
          ? 'Curaleaf did not respond. The connection is unchanged — try again shortly.'
          : error instanceof Error ? error.message : 'The Curaleaf connection could not be refreshed.',
        toastType: 'error',
      });
    } finally {
      setCuraleafRefreshing(false);
    }
  };
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
      setEditingProfile(false);
      notify('Pharmacy details saved.');
    } catch (error) {
      // Editing stays open on failure so the typed values are not thrown away.
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

  const setPharmacyDelivery = async (enabled: boolean) => {
    const previous = organisation.pharmacyDeliveryEnabled;
    setSavingDelivery(true);
    dispatch({ type: 'UPDATE_ORGANISATION', organisationId: organisation.id, updates: { pharmacyDeliveryEnabled: enabled } });
    try {
      if (!isLocalPortalPreview && isApiConfigured) await updatePaymentSettings(organisation.id, { pharmacyDeliveryEnabled: enabled });
      dispatch({
        type: 'ADD_TOAST',
        message: enabled
          ? 'Pharmacy Delivery is enabled for new drafts.'
          : 'Pharmacy Delivery is disabled for new drafts. Existing eligible drafts are unchanged.',
        toastType: 'success',
      });
    } catch (error) {
      dispatch({ type: 'UPDATE_ORGANISATION', organisationId: organisation.id, updates: { pharmacyDeliveryEnabled: previous } });
      dispatch({ type: 'ADD_TOAST', message: error instanceof Error ? error.message : 'Pharmacy Delivery could not be updated.', toastType: 'error' });
    } finally {
      setSavingDelivery(false);
    }
  };

  return (
    <div className="page-body pharmacy-settings">
      <header className="pharmacy-settings__header">
        <div className="tenant-mark" style={brandSwatchStyle(organisation.brand.primary)}>{organisation.logoText}</div>
        <div className="pharmacy-settings__identity">
          <h2>{organisation.brand.portalName}</h2>
          <p>{organisation.name} · GPhC {organisation.gphcNumber}</p>
        </div>
        <span className={`pill ${organisation.status === 'paused' ? 'pill-red' : state.workspaceMode === 'live' ? 'pill-green' : 'pill-amber'}`}>
          {organisation.status === 'paused' ? 'Paused' : state.workspaceMode === 'live' ? 'Live' : 'Training'}
        </span>
      </header>

      <div className="pharmacy-settings__nav" role="tablist" aria-label="Settings views">
        <button type="button" role="tab" id="settings-tab-organisation" aria-selected={activeTab === 'settings'} aria-controls="settings-panel-organisation" onClick={() => setActiveTab('settings')}>
          <Building2 size={14} aria-hidden="true" /> Organisation
        </button>
        <button type="button" role="tab" id="settings-tab-assets" aria-selected={activeTab === 'assets'} aria-controls="settings-panel-assets" onClick={() => setActiveTab('assets')}>
          <QrCode size={14} aria-hidden="true" /> Assets
        </button>
      </div>

      {activeTab === 'settings' ? (
        <div className="pharmacy-settings__flow" id="settings-panel-organisation" role="tabpanel" aria-labelledby="settings-tab-organisation">
          <section className="pharmacy-settings-section">
            <header>
              <h3><Building2 size={16} aria-hidden="true" /> Pharmacy Delivery</h3>
              <span className={`pill ${organisation.pharmacyDeliveryEnabled ? 'pill-green' : 'pill-neutral'}`}>
                {organisation.pharmacyDeliveryEnabled ? 'Enabled' : 'Disabled'}
              </span>
            </header>
            <p className="pharmacy-settings-section__lead">Allow new order drafts to add a pharmacy-managed delivery charge of up to £15. Existing eligible drafts keep their choice if this is later disabled.</p>
            <label className="pharmacy-settings-toggle">
              <span><strong>Offer Pharmacy Delivery</strong><small>{organisation.pharmacyDeliveryEnabled ? 'Enabled for new drafts.' : 'Disabled for new drafts.'}</small></span>
              <input type="checkbox" checked={organisation.pharmacyDeliveryEnabled} disabled={savingDelivery} onChange={event => void setPharmacyDelivery(event.target.checked)} />
              <span aria-hidden="true" />
            </label>
          </section>

          <section className="pharmacy-settings-section">
            <header><h3><Tags size={16} aria-hidden="true" /> Curaleaf</h3></header>
            <div className="pharmacy-settings-curaleaf">
              <div className="pharmacy-settings-curaleaf__id">
                <span>Customer ID</span>
                <strong>{curaleafStatus?.customerId ?? 'Not assigned'}</strong>
              </div>
              <button type="button" className="btn btn-secondary" disabled={curaleafRefreshing} onClick={() => void refreshCuraleaf()}>
                <RefreshCw size={14} aria-hidden="true" /> {curaleafRefreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
            <p className="pharmacy-settings-section__lead">Curaleaf supplies patient price and wholesale cost. Your team can add optional dispensing and eligible Pharmacy Delivery charges while building an order.</p>
            <button type="button" className="pharmacy-settings-link" onClick={() => dispatch({ type: 'SET_SCREEN', screen: 'formulary' })}>Open Curaleaf catalogue</button>
          </section>

          <section className="pharmacy-settings-section">
            <header>
              <h3><Building2 size={16} aria-hidden="true" /> Pharmacy details</h3>
              {!editingProfile ? (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditingProfile(true)}>
                  <Pencil size={14} aria-hidden="true" /> Edit
                </button>
              ) : null}
            </header>
            <p className="pharmacy-settings-section__lead">Trading name, GPhC registration, address and contact details. Branding and go-live status remain managed by HHH.</p>
            {/* Three groups, in the order someone reads a pharmacy record: who the
                business is, where it is, and who to call about it. */}
            {!editingProfile ? (
              <div className="pharmacy-settings-profile">
                <div className="pharmacy-settings-profile__group">
                  <h4>Pharmacy details</h4>
                  <dl>
                    <div><dt>Trading name</dt><dd>{organisation.tradingName || '—'}</dd></div>
                    <div><dt>Registered company name</dt><dd>{organisation.name || '—'}</dd></div>
                    <div><dt>GPhC number</dt><dd>{organisation.gphcNumber || '—'}</dd></div>
                    <div><dt>Superintendent pharmacist</dt><dd>{organisation.superintendent || '—'}</dd></div>
                  </dl>
                </div>
                <div className="pharmacy-settings-profile__group">
                  <h4>Address</h4>
                  <dl>
                    <div><dt>Address line 1</dt><dd>{profileForm.addressLine1 || '—'}</dd></div>
                    <div><dt>Address line 2</dt><dd>{profileForm.addressLine2 || '—'}</dd></div>
                    <div><dt>Town or city</dt><dd>{profileForm.locality || '—'}</dd></div>
                    <div><dt>County</dt><dd>{profileForm.county || '—'}</dd></div>
                    <div><dt>Postcode</dt><dd>{profileForm.postcode || '—'}</dd></div>
                  </dl>
                </div>
                <div className="pharmacy-settings-profile__group">
                  <h4>Main contact</h4>
                  <dl>
                    <div><dt>Name</dt><dd>{organisation.mainContactName || '—'}</dd></div>
                    <div><dt>Phone</dt><dd>{organisation.mainContactPhone || '—'}</dd></div>
                    <div><dt>Email</dt><dd>{organisation.mainContactEmail || '—'}</dd></div>
                  </dl>
                </div>
              </div>
            ) : (
              <form className="pharmacy-settings-form" onSubmit={event => void saveProfile(event)}>
                <fieldset className="pharmacy-settings-form__group">
                  <legend>Pharmacy details</legend>
                  <div className="pharmacy-settings-form__grid">
                    <label>Trading name<input className="input" value={profileForm.tradingName} onChange={event => setProfileForm(current => ({ ...current, tradingName: event.target.value }))} required /></label>
                    <label>Registered company name<input className="input" value={profileForm.name} onChange={event => setProfileForm(current => ({ ...current, name: event.target.value }))} required /></label>
                    <label>GPhC number<input className="input" value={profileForm.gphcNumber} onChange={event => setProfileForm(current => ({ ...current, gphcNumber: event.target.value }))} required /></label>
                    <label>Superintendent pharmacist<input className="input" value={profileForm.superintendent} onChange={event => setProfileForm(current => ({ ...current, superintendent: event.target.value }))} required /></label>
                  </div>
                </fieldset>
                <fieldset className="pharmacy-settings-form__group">
                  <legend>Address</legend>
                  <div className="pharmacy-settings-form__grid">
                    <label>Address line 1<input className="input" value={profileForm.addressLine1} onChange={event => setProfileForm(current => ({ ...current, addressLine1: event.target.value }))} autoComplete="address-line1" required /></label>
                    <label>Address line 2<input className="input" value={profileForm.addressLine2} onChange={event => setProfileForm(current => ({ ...current, addressLine2: event.target.value }))} autoComplete="address-line2" /></label>
                    <label>Town or city<input className="input" value={profileForm.locality} onChange={event => setProfileForm(current => ({ ...current, locality: event.target.value }))} autoComplete="address-level2" required /></label>
                    <label>County<input className="input" value={profileForm.county} onChange={event => setProfileForm(current => ({ ...current, county: event.target.value }))} autoComplete="address-level1" /></label>
                    <label>Postcode<input className="input" value={profileForm.postcode} onChange={event => setProfileForm(current => ({ ...current, postcode: event.target.value.toUpperCase() }))} autoComplete="postal-code" required /></label>
                  </div>
                </fieldset>
                <fieldset className="pharmacy-settings-form__group">
                  <legend>Main contact</legend>
                  <div className="pharmacy-settings-form__grid">
                    <label>Main contact name<input className="input" value={profileForm.mainContactName} onChange={event => setProfileForm(current => ({ ...current, mainContactName: event.target.value }))} /></label>
                    <label>Main contact phone<input className="input" type="tel" value={profileForm.mainContactPhone} onChange={event => setProfileForm(current => ({ ...current, mainContactPhone: event.target.value }))} /></label>
                    <label className="is-wide">Main contact email<input className="input" type="email" value={profileForm.mainContactEmail} onChange={event => setProfileForm(current => ({ ...current, mainContactEmail: event.target.value }))} /></label>
                  </div>
                </fieldset>
                <div className="pharmacy-settings-actions">
                  <button type="submit" className="btn btn-primary" disabled={profileSaving}><Save size={14} /> {profileSaving ? 'Saving…' : 'Save pharmacy details'}</button>
                  {/* Cancel restores what is on record rather than leaving half-typed
                      values behind for the next person who opens Edit. */}
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={profileSaving}
                    onClick={() => { setProfileForm(profileFromOrganisation()); setEditingProfile(false); }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </section>

          <section className="pharmacy-settings-section">
            <header>
              <h3><CreditCard size={16} aria-hidden="true" /> Payment route</h3>
              <span className={`pill ${organisation.defaultPaymentRoute === 'worldpay' ? 'pill-green' : 'pill-neutral'}`}>
                {organisation.defaultPaymentRoute === 'worldpay' ? 'Worldpay' : 'Pharmacy payment'}
              </span>
            </header>
            <p className="pharmacy-settings-section__lead">How new orders take payment. Each order permanently records the route selected when it was created.</p>

            <div className="pharmacy-settings-route" role="radiogroup" aria-label="Default payment route">
              <button type="button" role="radio" aria-checked={organisation.defaultPaymentRoute === 'manual'} disabled={savingRoute} onClick={() => void setPaymentRoute('manual')}>
                <span><strong>Pharmacy payment</strong><small>EPOS, cash, bank transfer or another pharmacy-controlled route.</small></span>
                {organisation.defaultPaymentRoute === 'manual' ? <CheckCircle2 size={16} /> : <span />}
              </button>
              <button type="button" role="radio" aria-checked={organisation.defaultPaymentRoute === 'worldpay'} disabled={savingRoute || organisation.worldpay.status !== 'connected'} onClick={() => void setPaymentRoute('worldpay')}>
                <span><strong>Worldpay hosted checkout</strong><small>{organisation.worldpay.status === 'connected' ? 'Verified merchant connection; settlement goes directly to this pharmacy.' : 'Connect and verify the pharmacy merchant account below first.'}</small></span>
                {organisation.defaultPaymentRoute === 'worldpay' ? <CheckCircle2 size={16} /> : <span />}
              </button>
            </div>

            {/* The merchant entity and the chosen route are each stated exactly once —
                the entity by the connection panel below, the route by the pill and the
                radio group above — so this strip carries only what neither of them says. */}
            {organisation.worldpay.status === 'connected' && (
              <div className="pharmacy-settings-connection">
                <div><span>Environment</span><strong>{organisation.worldpay.environment === 'live' ? 'Live' : 'Try'}</strong></div>
                <div><span>Last verified</span><strong>{formatLastVerified(organisation.worldpay.lastSyncedAt)}</strong></div>
                <button type="button" className="btn btn-sm" disabled={!worldpayRefreshControl || worldpayRefreshControl.busy} onClick={() => worldpayRefreshControl?.refresh()}>
                  <RefreshCw size={13} className={worldpayRefreshControl?.busy ? 'spin' : ''} /> {worldpayRefreshControl?.busy ? 'Refreshing…' : 'Refresh status'}
                </button>
              </div>
            )}

            {/* Only worth saying while it is still a decision to make. */}
            {organisation.worldpay.status !== 'connected' ? (
              <p className="pharmacy-settings-note"><ShieldCheck size={15} aria-hidden="true" /><span>Worldpay is optional. Connect the merchant here when you are ready.</span></p>
            ) : null}
            <WorldpayConnectionPanel
              organisationId={organisation.id}
              onNotify={(message, tone) => dispatch({ type: 'ADD_TOAST', message, toastType: tone, dedupeKey: 'worldpay-refresh' })}
              onRefreshControl={setWorldpayRefreshControl}
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
        </div>
      ) : (
        <div className="pharmacy-settings__flow" id="settings-panel-assets" role="tabpanel" aria-labelledby="settings-tab-assets">
          {linkError ? <div className="banner banner-red" role="alert"><AlertTriangle size={16} /><span>{linkError}</span><button className="btn btn-sm" type="button" onClick={() => setLinkRefresh(value => value + 1)}><RefreshCw size={14} /> Retry</button></div> : null}

          <p className="pharmacy-settings-assets__intro">
            Everything you need to point patients at your eligibility form — a link to share, a QR
            code to print, and a pack for whoever looks after your website. Use whichever you need,
            in any order.
          </p>

          <div className="pharmacy-settings-assets__tools">
            <section className="pharmacy-settings-section pharmacy-settings-tool">
              <header><h3><Link2 size={16} aria-hidden="true" /> Your eligibility link</h3></header>
              <p className="pharmacy-settings-section__lead">The form stays hosted by HHH. Put this URL on your website, in emails, or on counter materials.</p>
              <p className="pharmacy-settings-url" aria-live="polite">{linkLoading ? 'Loading the protected pharmacy link…' : formUrl || 'Link unavailable'}</p>
              <div className="pharmacy-settings-actions">
                <button className="btn btn-primary" type="button" disabled={!formUrl} onClick={copyLink}><Copy size={14} /> Copy link</button>
                {formUrl ? <a className="btn btn-secondary" href={formUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Preview form</a> : <button className="btn btn-secondary" type="button" disabled><ExternalLink size={14} /> Preview form</button>}
              </div>
            </section>

            <section className="pharmacy-settings-section pharmacy-settings-tool">
              <header><h3><QrCode size={16} aria-hidden="true" /> Print-ready QR code</h3></header>
              <p className="pharmacy-settings-section__lead">The same link as a high-resolution image, for leaflets, posters and counter cards.</p>
              {qr ? (
                <img className="pharmacy-settings-qr" src={qr} alt={`Eligibility QR code for ${organisation.name}`} />
              ) : (
                <div className="pharmacy-settings-qr-placeholder">{linkError ? 'QR unavailable' : 'Generating QR…'}</div>
              )}
              <div className="pharmacy-settings-actions">
                <button
                  className="btn btn-secondary"
                  type="button"
                  disabled={!qr}
                  onClick={() => { downloadDataUrl(qr, `${organisation.slug}-eligibility-qr.png`); notify('High-resolution QR code saved.'); }}
                >
                  <Download size={14} /> Save QR code
                </button>
              </div>
            </section>
          </div>

          <div className="pharmacy-settings-packs" aria-label="Content packs">
            <section className="pharmacy-settings-section pharmacy-settings-tool pharmacy-settings-tool--secondary">
              <header><h3><FileArchive size={16} aria-hidden="true" /> Developer pack</h3></header>
              <p className="pharmacy-settings-section__lead">Suggested page copy, the hosted-form link, QR usage notes and the high-resolution image, zipped up to hand over.</p>
              <div className="pharmacy-settings-actions">
                <button className="btn btn-secondary" type="button" disabled={!formUrl} onClick={async () => { await downloadContentPack(organisation, formUrl); notify('Developer content pack created.'); }}>
                  <FileArchive size={15} /> Download content pack (.zip)
                </button>
              </div>
            </section>
            {[2, 3].map(number => (
              <section key={number} className="pharmacy-settings-section pharmacy-settings-tool pharmacy-settings-tool--secondary is-coming-soon">
                <header><h3><FileArchive size={16} aria-hidden="true" /> Content pack {number}</h3><span className="pill pill-neutral">Coming soon</span></header>
                <p className="pharmacy-settings-section__lead">Additional approved pharmacy materials will appear here when available.</p>
                <div className="pharmacy-settings-actions"><button className="btn btn-secondary" type="button" disabled>Coming soon</button></div>
              </section>
            ))}
          </div>

          <p className="pharmacy-settings-attribution">
            <Link2 size={14} aria-hidden="true" />
            <span>Submissions from this link are attributed to {organisation.name}. The token is specific to your pharmacy — do not share another pharmacy&rsquo;s URL.</span>
          </p>
        </div>
      )}
    </div>
  );
}
