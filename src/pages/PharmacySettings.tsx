import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { organisationAddressFields } from '../utils/organisationAddress';
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  Compass,
  Copy,
  CreditCard,
  Download,
  ExternalLink,
  FileArchive,
  Link2,
  Mail,
  Pencil,
  Phone,
  QrCode,
  RefreshCw,
  Save,
  ShieldCheck,
  Tags,
} from 'lucide-react';
import { KEY_CONTACTS, telHref } from '@hhh/domain/key-contacts';
import { useApp } from '../context/AppContext';
import { brandSwatchStyle } from '../utils/tenantTheme';
import { ApiRequestError, describeApiError, getCuraleafConnectionStatus, getReferralLink, isApiConfigured, refreshCuraleafConnection, updatePatientEmailVisibility, updatePaymentSettings, updatePharmacyProfile } from '../shared/api';
import type { CuraleafConnectionStatus } from '../shared/contracts';
import { curaleafCatalogueEstateLabel } from '../utils/catalogueEstate';
import WorldpayConnectionPanel from '../components/WorldpayConnectionPanel';
import { downloadContentPack, downloadDataUrl, eligibilityUrl, qrDataUrl } from '../utils/pharmacyResources';
import { isLocalPortalPreview } from '../dev/localPortalPreview';
import { POSTER_TEMPLATES_READY, posterPackAvailable } from '../utils/posterPackRules';
import { requestWorkspaceTourReplay } from '../training/workspaceTourPersist';
import { pharmacyWorkspaceStatusLabel } from '../training/workspace';
import './PharmacySettings.css';

/** A verification is only reassuring if staff can see how recent it is. */
function formatLastVerified(value: Date | string | null): string {
  if (!value) return 'Not yet checked';
  const when = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(when.getTime())) return 'Not yet checked';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(when);
}

const SETTINGS_SECTIONS = [
  { id: 'organisation', label: 'Organisation' },
  { id: 'payments', label: 'Payments' },
  { id: 'assets', label: 'Assets' },
  { id: 'support', label: 'Support' },
] as const;

export type SettingsSection = typeof SETTINGS_SECTIONS[number]['id'];

/** The element that actually scrolls this page (the workspace main area, not the window). */
function scrollParentOf(element: HTMLElement | null): HTMLElement {
  let node = element?.parentElement ?? null;
  while (node && node !== document.body) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return document.scrollingElement as HTMLElement;
}

export default function PharmacySettings({ initialSection }: { initialSection?: SettingsSection } = {}) {
  const { state, dispatch } = useApp();
  // Demo mode and local preview both run on the demo data set, so neither writes to the server.
  const sandboxPortal = isLocalPortalPreview || state.demoMode;
  const organisation = useMemo(() => state.organisations.find(org => org.id === state.currentOrganisationId) ?? state.organisations[0], [state]);
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
  // Read-only is the resting state: each card edits on its own, so a page of live
  // inputs never invites accidental edits to a registered name or GPhC number.
  const [editingCard, setEditingCard] = useState<'pharmacy' | 'contacts' | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection ?? 'organisation');
  const navRef = useRef<HTMLElement | null>(null);
  // The section a click is scrolling to: the highlight follows the scroll, then settles here.
  const pendingSectionRef = useRef<SettingsSection | null>(null);

  // Jump so a section starts just below the pinned bar; scrollIntoView would hide it underneath.
  const goToSection = useCallback((id: SettingsSection, instant = false) => {
    const target = document.getElementById(`settings-section-${id}`);
    if (!target) return;
    const scroller = scrollParentOf(target);
    const barHeight = navRef.current?.offsetHeight ?? 0;
    const scrollerTop = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
    const offset = target.getBoundingClientRect().top - scrollerTop - barHeight - 12;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce || instant || Math.abs(offset) < 2) { pendingSectionRef.current = null; setActiveSection(id); }
    else pendingSectionRef.current = id;
    scroller.scrollTo({ top: scroller.scrollTop + offset, behavior: reduce || instant ? 'auto' : 'smooth' });
    if (!(reduce || instant)) return;
    // An instant jump can be measured where it landed: the header and pinned bar settle
    // only once the page moves, so correct against the bar's real position.
    for (let pass = 0; pass < 3; pass += 1) {
      const bar = navRef.current?.getBoundingClientRect().bottom ?? 0;
      const miss = target.getBoundingClientRect().top - bar - 12;
      if (Math.abs(miss) < 2) break;
      const before = scroller.scrollTop;
      scroller.scrollTop = before + miss;
      if (scroller.scrollTop === before) break;
    }
  }, []);

  // Key contacts and other deep links open straight on their section.
  useEffect(() => {
    if (!initialSection || initialSection === 'organisation') return;
    // The link, QR and Curaleaf cards load after mount and push the section down,
    // so keep it aligned while the page settles, until staff take over or 1.5s pass.
    const root = navRef.current?.parentElement;
    const align = () => goToSection(initialSection, true);
    const frame = window.requestAnimationFrame(align);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(align);
    if (root) observer?.observe(root);
    const stop = () => {
      observer?.disconnect();
      for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) window.removeEventListener(type, stop);
    };
    // Listen a frame later: the keypress or click that opened this page is still bubbling.
    const listen = window.setTimeout(() => {
      for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) window.addEventListener(type, stop, { passive: true });
    }, 50);
    const timer = window.setTimeout(stop, 2500);
    return () => { window.cancelAnimationFrame(frame); window.clearTimeout(listen); window.clearTimeout(timer); stop(); };
  }, [initialSection, goToSection]);

  // Highlight the section under the bar as staff scroll.
  useEffect(() => {
    const first = document.getElementById('settings-section-organisation');
    if (!first) return;
    const scroller = scrollParentOf(first);
    const target: HTMLElement | Window = scroller === document.scrollingElement ? window : scroller;
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = (navRef.current?.getBoundingClientRect().bottom ?? 0) + 40;
      let current: SettingsSection = 'organisation';
      for (const section of SETTINGS_SECTIONS) {
        const el = document.getElementById(`settings-section-${section.id}`);
        if (el && el.getBoundingClientRect().top <= line) current = section.id;
      }
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) current = 'support';
      setActiveSection(current);
    };
    // Pin the bar flush with the top of the scroller, whatever its top padding is at this width.
    const pin = () => {
      if (!navRef.current) return;
      const pad = scroller === document.scrollingElement ? 0 : parseFloat(getComputedStyle(scroller).paddingTop) || 0;
      navRef.current.style.top = `${-pad}px`;
    };
    pin();
    window.addEventListener('resize', pin);
    let settle = 0;
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
      window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        if (pendingSectionRef.current) setActiveSection(pendingSectionRef.current);
        pendingSectionRef.current = null;
      }, 120);
    };
    target.addEventListener('scroll', onScroll, { passive: true });
    update();
    return () => { target.removeEventListener('scroll', onScroll); window.removeEventListener('resize', pin); window.clearTimeout(settle); if (frame) window.cancelAnimationFrame(frame); };
  }, []);
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
    pharmacyPhone: '',
    pharmacyEmail: '',
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
      pharmacyPhone: organisation.pharmacyPhone ?? '',
      pharmacyEmail: organisation.pharmacyEmail ?? '',
    };
  }, [organisation]);

  useEffect(() => {
    setProfileForm(profileFromOrganisation());
  }, [profileFromOrganisation]);

  useEffect(() => {
    let cancelled = false;
    setFormUrl('');
    setQr('');
    setLinkError('');
    setLinkLoading(true);
    const request = sandboxPortal
      ? Promise.resolve({ url: eligibilityUrl(organisation.referralToken) })
      : getReferralLink();
    void request
      .then(result => { if (!cancelled) setFormUrl(result.url); })
      .catch(error => { if (!cancelled) setLinkError(error instanceof Error ? error.message : 'The eligibility link could not be loaded.'); })
      .finally(() => { if (!cancelled) setLinkLoading(false); });
    return () => { cancelled = true; };
  }, [organisation.id, organisation.referralToken, linkRefresh, sandboxPortal]);

  useEffect(() => {
    let cancelled = false;
    if (sandboxPortal) return () => { cancelled = true; };
    void getCuraleafConnectionStatus()
      .then(status => { if (!cancelled) setCuraleafStatus(status); })
      .catch(() => { if (!cancelled) setCuraleafStatus(null); });
    return () => { cancelled = true; };
  }, [organisation.id, sandboxPortal]);

  useEffect(() => {
    let cancelled = false;
    if (!formUrl) { setQr(''); return; }
    void qrDataUrl(formUrl)
      .then(value => { if (!cancelled) setQr(value); })
      .catch(() => { if (!cancelled) setLinkError('The eligibility QR code could not be generated safely.'); });
    return () => { cancelled = true; };
  }, [formUrl]);

  const notify = (message: string) => dispatch({ type: 'ADD_TOAST', message, toastType: 'success' });
  // The poster pack stays off until HHH's templates and wording are in; local preview shows it to check the layout.
  const postersOn = POSTER_TEMPLATES_READY || isLocalPortalPreview;
  const postersOpen = posterPackAvailable(organisation.status);
  const [postersBusy, setPostersBusy] = useState(false);
  const savePosterPack = async () => {
    setPostersBusy(true);
    try {
      const { downloadPosterPack } = await import('../utils/posterPackDownload');
      await downloadPosterPack(organisation, formUrl);
      notify('Poster pack saved: an A4 poster, an A5 leaflet and an A6 counter card.');
    } catch {
      dispatch({ type: 'ADD_TOAST', message: 'The poster pack could not be made. Try again.', toastType: 'error' });
    } finally {
      setPostersBusy(false);
    }
  };

  const refreshCuraleaf = async () => {
    setCuraleafRefreshing(true);
    // A refresh that fell back to the read-only status did not actually re-test
    // anything, so it must not be reported back as a successful re-test.
    let readOnlyFallback = false;
    try {
      // Preview has no write endpoint, so re-read the status instead of forcing a refresh.
      const status = sandboxPortal
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
      if (!sandboxPortal && isApiConfigured) {
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
          pharmacyPhone: profileForm.pharmacyPhone || undefined,
          pharmacyEmail: profileForm.pharmacyEmail || undefined,
        },
      });
     
      setEditingCard(null);
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
      if (!sandboxPortal && isApiConfigured) await updatePaymentSettings(organisation.id, route);
      dispatch({ type: 'ADD_TOAST', message: `${route === 'worldpay' ? 'Worldpay' : 'Pharmacy payment'} will be used for new orders. Existing orders are unchanged.`, toastType: 'success' });
    } catch (error) {
      dispatch({ type: 'UPDATE_ORGANISATION', organisationId: organisation.id, updates: { defaultPaymentRoute: previousRoute } });
      dispatch({ type: 'UPDATE_WORLDPAY', organisationId: organisation.id, updates: { enabled: previousRoute === 'worldpay' } });
      dispatch({ type: 'ADD_TOAST', message: error instanceof Error ? error.message : 'Payment settings could not be saved.', toastType: 'error' });
    } finally {
      setSavingRoute(false);
    }
  };

  const [savingEmailVisibility, setSavingEmailVisibility] = useState(false);
  // The pharmacy's own choice. HHH admin sees it but cannot change it.
  const setEmailVisibility = async (show: boolean) => {
    const previous = Boolean(organisation.showEmailToPatients);
    setSavingEmailVisibility(true);
    dispatch({ type: 'UPDATE_ORGANISATION', organisationId: organisation.id, updates: { showEmailToPatients: show } });
    try {
      if (!sandboxPortal && isApiConfigured) await updatePatientEmailVisibility(show);
      notify(show ? 'Patients will see your email as well as your phone.' : 'Patients will see your phone only.');
    } catch (error) {
      dispatch({ type: 'UPDATE_ORGANISATION', organisationId: organisation.id, updates: { showEmailToPatients: previous } });
      dispatch({ type: 'ADD_TOAST', message: describeApiError(error, 'The setting could not be saved.'), toastType: 'error' });
    } finally {
      setSavingEmailVisibility(false);
    }
  };

  const setPharmacyDelivery = async (enabled: boolean) => {
    const previous = organisation.pharmacyDeliveryEnabled;
    setSavingDelivery(true);
    dispatch({ type: 'UPDATE_ORGANISATION', organisationId: organisation.id, updates: { pharmacyDeliveryEnabled: enabled } });
    try {
      if (!sandboxPortal && isApiConfigured) await updatePaymentSettings(organisation.id, { pharmacyDeliveryEnabled: enabled });
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

  const address = organisationAddressFields(organisation);
  const premises = [address.addressLine1, address.addressLine2, address.locality, address.county, address.postcode].filter(Boolean).join(', ');
  const statusLabel = organisation.status === 'paused' ? 'Paused' : pharmacyWorkspaceStatusLabel(state.workspaceMode);
  const statusTone = organisation.status === 'paused' ? 'danger' : state.workspaceMode === 'live' ? 'paid' : 'warning';
  const field = (key: keyof typeof profileForm) => (event: { target: { value: string } }) => (
    setProfileForm(current => ({ ...current, [key]: key === 'postcode' ? event.target.value.toUpperCase() : event.target.value }))
  );
  const cancelEdit = () => { setProfileForm(profileFromOrganisation()); setEditingCard(null); };
  const editActions = (
    <div className="pharmacy-details__actions">
      <button type="button" className="btn btn-sm" disabled={profileSaving} onClick={cancelEdit}>Cancel</button>
      <button type="submit" className="btn btn-primary btn-sm" disabled={profileSaving}><Save size={13} /> {profileSaving ? 'Saving…' : 'Save'}</button>
    </div>
  );
  const editButton = (card: 'pharmacy' | 'contacts', label: string) => editingCard === card ? null : (
    <button type="button" className="btn btn-sm" disabled={editingCard !== null} aria-label={`Edit ${label}`} onClick={() => { setProfileForm(profileFromOrganisation()); setEditingCard(card); }}>
      <Pencil size={13} /> Edit
    </button>
  );
  const row = (label: string, value: ReactNode, hint?: string) => (
    <div className="pharmacy-details__row">
      <dt>{label}</dt>
      <dd>{value || <span className="pharmacy-details__empty">Not given</span>}{hint ? <small>{hint}</small> : null}</dd>
    </div>
  );

  return (
    <div className="page-body pharmacy-settings-page pharmacy-dashboard" data-tour="settings">
      <header className="pharmacy-settings-page__hero">
        <span className="pharmacy-settings-page__mark" style={brandSwatchStyle(organisation.brand.primary)} aria-hidden="true">{organisation.logoText}</span>
        <div className="pharmacy-settings-page__titles">
          <h2>{organisation.name}</h2>
          <p>{organisation.tradingName && organisation.tradingName !== organisation.name ? `${organisation.tradingName} · ` : ''}GPhC {organisation.gphcNumber}</p>
        </div>
        <span className={`order-stage-pill order-tone--${statusTone}`}>{statusLabel}</span>
      </header>


      <nav ref={navRef} className="pharmacy-dashboard__nav pharmacy-settings-page__nav" aria-label="Settings sections">
        {SETTINGS_SECTIONS.map(section => (
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

      <section id="settings-section-organisation" className="pharmacy-settings-page__section" aria-labelledby="settings-heading-organisation">
        <header className="pharmacy-settings-page__section-head">
          <h3 id="settings-heading-organisation">Organisation</h3>
          <p>Who you are, what you offer, and how patients and HHH reach you.</p>
        </header>
        {state.demoMode ? (
          <p className="pharmacy-settings-demo-note" role="note">Settings are not available in demo mode: they belong to your live account. Return to live to change them.</p>
        ) : null}
        <fieldset className="pharmacy-settings-demo-lock" disabled={state.demoMode}>
        <div className="pharmacy-details">
            {/* Pharmacy: who the business is and where. */}
            <section className={`pharmacy-details__card${editingCard === 'pharmacy' ? ' is-editing' : ''}`} aria-labelledby="settings-card-pharmacy">
              <header>
                <span className="pharmacy-details__icon" aria-hidden="true"><Building2 size={16} /></span>
                <h4 id="settings-card-pharmacy">Pharmacy</h4>
                {editButton('pharmacy', 'pharmacy details')}
              </header>
              {editingCard === 'pharmacy' ? (
                <form className="pharmacy-details__form" onSubmit={event => void saveProfile(event)}>
                  <div className="pharmacy-details__fields">
                    <label className="is-wide"><span>Pharmacy name</span><input className="input" value={profileForm.name} onChange={field('name')} required /></label>
                    <label className="is-wide"><span>Company name</span><input className="input" value={profileForm.tradingName} onChange={field('tradingName')} required /></label>
                    <label><span>GPhC premises number</span><input className="input" value={profileForm.gphcNumber} onChange={field('gphcNumber')} required /></label>
                    <label><span>Superintendent pharmacist</span><input className="input" value={profileForm.superintendent} onChange={field('superintendent')} required /></label>
                    <p className="pharmacy-details__group is-wide">Premises</p>
                    <label className="is-wide"><span>Address line 1</span><input className="input" value={profileForm.addressLine1} onChange={field('addressLine1')} autoComplete="address-line1" required /></label>
                    <label className="is-wide"><span>Address line 2 <em>Optional</em></span><input className="input" value={profileForm.addressLine2} onChange={field('addressLine2')} autoComplete="address-line2" /></label>
                    <label><span>Town or city</span><input className="input" value={profileForm.locality} onChange={field('locality')} autoComplete="address-level2" required /></label>
                    <label><span>County <em>Optional</em></span><input className="input" value={profileForm.county} onChange={field('county')} autoComplete="address-level1" /></label>
                    <label><span>Postcode</span><input className="input" value={profileForm.postcode} onChange={field('postcode')} autoComplete="postal-code" required /></label>
                  </div>
                  {editActions}
                </form>
              ) : (
                <>
                  <dl className="pharmacy-details__list">
                    {row('Pharmacy name', organisation.name)}
                    {row('Company', organisation.tradingName)}
                    {row('GPhC number', organisation.gphcNumber)}
                    {row('Superintendent', organisation.superintendent)}
                    {row('Premises', premises)}
                  </dl>
                <div className="pharmacy-details__switch-row">
                  <span>
                    <strong id="settings-delivery">Offer Pharmacy Delivery</strong>
                    <small>{organisation.pharmacyDeliveryEnabled ? 'New drafts can add a delivery charge of up to £15.' : 'Off for new drafts. Existing drafts keep their choice.'}</small>
                  </span>
                  <button
                    type="button"
                    role="switch"
                    className="pharmacy-details__switch"
                    aria-checked={organisation.pharmacyDeliveryEnabled}
                    aria-labelledby="settings-delivery"
                    disabled={savingDelivery}
                    onClick={() => void setPharmacyDelivery(!organisation.pharmacyDeliveryEnabled)}
                  >
                    <span aria-hidden="true" />
                  </button>
                </div>
                </>
              )}
            </section>
            {/* Contacts: what patients see, and how HHH reaches you. */}
            <section className={`pharmacy-details__card${editingCard === 'contacts' ? ' is-editing' : ''}`} aria-labelledby="settings-card-contacts">
              <header>
                <span className="pharmacy-details__icon" aria-hidden="true"><Phone size={16} /></span>
                <h4 id="settings-card-contacts">Contacts</h4>
                {editButton('contacts', 'contacts')}
              </header>
              {editingCard === 'contacts' ? (
                <form className="pharmacy-details__form" onSubmit={event => void saveProfile(event)}>
                  <div className="pharmacy-details__fields">
                    <p className="pharmacy-details__group is-wide">Pharmacy</p>
                    <label><span>Landline</span><input className="input" type="tel" value={profileForm.pharmacyPhone} onChange={field('pharmacyPhone')} autoComplete="tel" /><small>Shown to patients.</small></label>
                    <label><span>Email</span><input className="input" type="email" value={profileForm.pharmacyEmail} onChange={field('pharmacyEmail')} autoComplete="email" /><small>{organisation.showEmailToPatients ? 'Shown to patients.' : 'Not shown to patients.'}</small></label>
                    <p className="pharmacy-details__group is-wide">For HHH only</p>
                    <label className="is-wide"><span>Superintendent contact</span><input className="input" value={profileForm.mainContactName} onChange={field('mainContactName')} /></label>
                    <label><span>Contact number</span><input className="input" type="tel" value={profileForm.mainContactPhone} onChange={field('mainContactPhone')} /></label>
                    <label><span>Contact email</span><input className="input" type="email" value={profileForm.mainContactEmail} onChange={field('mainContactEmail')} /></label>
                  </div>
                  {editActions}
                </form>
              ) : (
                <>
                  <dl className="pharmacy-details__list">
                    {row('Landline', organisation.pharmacyPhone)}
                    {row('Email', organisation.pharmacyEmail)}
                    {row('Superintendent contact', organisation.mainContactName)}
                    {row('Contact number', organisation.mainContactPhone)}
                    {row('Contact email', organisation.mainContactEmail)}
                  </dl>
                  <div className="pharmacy-details__switch-row">
                    <span>
                      <strong id="settings-email-visibility">Show email to patients</strong>
                      <small>{!organisation.pharmacyEmail?.trim() ? 'Add a pharmacy email first.' : organisation.showEmailToPatients ? 'Patients see your email and phone.' : 'Patients see your phone only.'}</small>
                    </span>
                    <button
                      type="button"
                      role="switch"
                      className="pharmacy-details__switch"
                      aria-checked={Boolean(organisation.showEmailToPatients)}
                      aria-labelledby="settings-email-visibility"
                      disabled={savingEmailVisibility || (!organisation.pharmacyEmail?.trim() && !organisation.showEmailToPatients)}
                      onClick={() => void setEmailVisibility(!organisation.showEmailToPatients)}
                    >
                      <span aria-hidden="true" />
                    </button>
                  </div>
                </>
              )}
            </section>
        </div>
        </fieldset>
      </section>
      <section id="settings-section-payments" className="pharmacy-settings-page__section" aria-labelledby="settings-heading-payments">
        <header className="pharmacy-settings-page__section-head">
          <h3 id="settings-heading-payments">Payments</h3>
          <p>How orders are paid for and priced.</p>
        </header>
        <fieldset className="pharmacy-settings-demo-lock" disabled={state.demoMode}>
        <div className="pharmacy-details">
            {/* Payment: how new orders take payment, with the Worldpay merchant beneath. */}
            <section className="pharmacy-details__card is-wide" aria-labelledby="settings-card-payment">
              <header>
                <span className="pharmacy-details__icon" aria-hidden="true"><CreditCard size={16} /></span>
                <h4 id="settings-card-payment">Payment route</h4>
                <span className={`pharmacy-details__tag${organisation.defaultPaymentRoute === 'worldpay' ? ' is-on' : ''}`}>
                  {organisation.defaultPaymentRoute === 'worldpay' ? 'Worldpay' : 'Pharmacy payment'}
                </span>
              </header>
              <p className="pharmacy-details__note">How new orders take payment. Each order keeps the route chosen when it was created.</p>
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
              {organisation.worldpay.status === 'connected' ? (
                <dl className="pharmacy-details__list pharmacy-settings-page__worldpay">
                  {row('Environment', organisation.worldpay.environment === 'live' ? 'Live' : 'Try')}
                  {row('Last verified', formatLastVerified(organisation.worldpay.lastSyncedAt))}
                </dl>
              ) : (
                <p className="pharmacy-details__note"><ShieldCheck size={14} aria-hidden="true" /> Worldpay is optional. Connect the merchant below when you are ready.</p>
              )}
              {organisation.worldpay.status === 'connected' ? (
                <div className="pharmacy-details__actions is-start">
                  <button type="button" className="btn btn-sm" disabled={!worldpayRefreshControl || worldpayRefreshControl.busy} onClick={() => worldpayRefreshControl?.refresh()}>
                    <RefreshCw size={13} className={worldpayRefreshControl?.busy ? 'spin' : ''} /> {worldpayRefreshControl?.busy ? 'Refreshing…' : 'Refresh status'}
                  </button>
                </div>
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
                      lastSyncedAt: connection.checkedAt ?? connection.updatedAt ?? new Date().toISOString(),
                    },
                  });
                  if (!connection.connected && organisation.defaultPaymentRoute === 'worldpay') {
                    dispatch({ type: 'UPDATE_ORGANISATION', organisationId: organisation.id, updates: { defaultPaymentRoute: 'manual' } });
                    if (!sandboxPortal && isApiConfigured) {
                      void updatePaymentSettings(organisation.id, 'manual').catch(() => {
                        dispatch({ type: 'ADD_TOAST', message: 'Worldpay was disconnected. Default payment route still needs switching to pharmacy payment.', toastType: 'warning' });
                      });
                    }
                  }
                }}
              />
            </section>
            {/* Curaleaf: who supplies you, and the catalogue that comes from it. */}
            <section className="pharmacy-details__card is-wide" aria-labelledby="settings-card-curaleaf">
              <header>
                <span className="pharmacy-details__icon" aria-hidden="true"><Tags size={16} /></span>
                <h4 id="settings-card-curaleaf">Curaleaf</h4>
                <button type="button" className="btn btn-sm" disabled={curaleafRefreshing} onClick={() => void refreshCuraleaf()}>
                  <RefreshCw size={13} className={curaleafRefreshing ? 'spin' : undefined} /> {curaleafRefreshing ? 'Refreshing…' : 'Refresh'}
                </button>
              </header>
              <dl className="pharmacy-details__list">
                {row('Customer ID', curaleafStatus?.customerId ?? '', curaleafStatus?.customerId ? undefined : 'Assigned by HHH once Curaleaf approve the account')}
                {row('Estate', curaleafStatus ? curaleafCatalogueEstateLabel(curaleafStatus.environment) : 'Not yet checked')}
              </dl>
              <p className="pharmacy-details__note">Curaleaf sets patient price and wholesale cost. You can add a dispensing charge, and Pharmacy Delivery if it is on, while building an order.</p>
              <button type="button" className="pharmacy-details__link" onClick={() => dispatch({ type: 'SET_SCREEN', screen: 'formulary' })}>Open Curaleaf catalogue</button>
            </section>
        </div>
        </fieldset>
      </section>
      <section id="settings-section-assets" className="pharmacy-settings-page__section" aria-labelledby="settings-heading-assets">
        <header className="pharmacy-settings-page__section-head">
          <h3 id="settings-heading-assets">Assets</h3>
          <p>Patient intake: your eligibility link, QR code and content packs.</p>
        </header>
        <div className="pharmacy-details">
            {linkError ? (
              <div className="banner banner-red is-wide pharmacy-settings-page__banner" role="alert">
                <AlertTriangle size={16} /><span>{linkError}</span>
                <button className="btn btn-sm" type="button" onClick={() => setLinkRefresh(value => value + 1)}><RefreshCw size={14} /> Retry</button>
              </div>
            ) : null}
            <section className="pharmacy-details__card" aria-labelledby="settings-card-link">
              <header>
                <span className="pharmacy-details__icon" aria-hidden="true"><Link2 size={16} /></span>
                <h4 id="settings-card-link">Eligibility link</h4>
              </header>
              <p className="pharmacy-details__note">Every patient who uses this link or its QR code is attributed to {organisation.name}. Put it on your website, in emails or on counter materials.</p>
              <code className="pharmacy-details__url" aria-live="polite">{linkLoading ? 'Loading your pharmacy link…' : formUrl || 'Link unavailable'}</code>
              <div className="pharmacy-details__actions is-start">
                <button className="btn btn-primary btn-sm" type="button" disabled={!formUrl} onClick={() => void copyLink()}><Copy size={13} /> Copy link</button>
                {formUrl ? <a className="btn btn-sm" href={formUrl} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Preview form</a> : null}
              </div>
            </section>
            <section className="pharmacy-details__card" aria-labelledby="settings-card-qr">
              <header>
                <span className="pharmacy-details__icon" aria-hidden="true"><QrCode size={16} /></span>
                <h4 id="settings-card-qr">QR code</h4>
                <button className="btn btn-sm" type="button" disabled={!qr} onClick={() => { downloadDataUrl(qr, `${organisation.slug}-eligibility-qr.png`); notify('High-resolution QR code saved.'); }}>
                  <Download size={13} /> Save
                </button>
              </header>
              <div className="pharmacy-settings-page__qr">
                {qr
                  ? <img className="pharmacy-settings-qr" src={qr} alt={`Eligibility QR code for ${organisation.name}`} />
                  : <div className="pharmacy-settings-qr-placeholder">{linkError ? 'QR unavailable' : 'Generating QR…'}</div>}
                <p className="pharmacy-details__note">The same link as a high-resolution image, for leaflets, posters and counter cards.</p>
              </div>
            </section>
            <section className="pharmacy-details__card is-wide" aria-labelledby="settings-card-packs">
              <header>
                <span className="pharmacy-details__icon" aria-hidden="true"><FileArchive size={16} /></span>
                <h4 id="settings-card-packs">Content packs</h4>
              </header>
              <ul className="pharmacy-settings-page__packs">
                <li className="pharmacy-details__switch-row">
                  <span>
                    <strong>Developer pack</strong>
                    <small>Suggested page copy, the link, QR usage notes and the high-resolution image, zipped for your web developer.</small>
                  </span>
                  <button className="btn btn-sm" type="button" disabled={!formUrl} onClick={async () => { await downloadContentPack(organisation, formUrl); notify('Developer content pack created.'); }}>
                    <Download size={13} /> Download .zip
                  </button>
                </li>
                {postersOn ? (
                  <li className="pharmacy-details__switch-row">
                    <span>
                      <strong>Poster pack</strong>
                      <small>
                        {postersOpen
                          ? 'An A4 poster, an A5 leaflet and an A6 counter card with your logo and QR code, as print-ready PDFs to send to your printer.'
                          : 'Available again once your eligibility link is back on.'}
                      </small>
                    </span>
                    <button className="btn btn-sm" type="button" disabled={!formUrl || !postersOpen || postersBusy} onClick={() => void savePosterPack()}>
                      <Download size={13} /> {postersBusy ? 'Making…' : 'Download .zip'}
                    </button>
                  </li>
                ) : (
                  <li className="pharmacy-details__switch-row is-muted">
                    <span>
                      <strong>Poster pack</strong>
                      <small>An A4 poster, an A5 leaflet and a counter card with your logo and QR code will appear here when HHH's designs are ready.</small>
                    </span>
                    <span className="pharmacy-details__tag">Coming soon</span>
                  </li>
                )}
              </ul>
            </section>
        </div>
      </section>
      <section id="settings-section-support" className="pharmacy-settings-page__section" aria-labelledby="settings-heading-support">
        <header className="pharmacy-settings-page__section-head">
          <h3 id="settings-heading-support">Support</h3>
          <p>The workspace tour, and who to phone or email. Holistic Health Hub is email only.</p>
        </header>
        <div className="pharmacy-details">
          <section className="pharmacy-details__card is-wide" aria-labelledby="settings-card-tour">
            <header>
              <span className="pharmacy-details__icon" aria-hidden="true"><Compass size={16} /></span>
              <h4 id="settings-card-tour">Workspace tour</h4>
            </header>
            <div className="pharmacy-details__switch-row">
              <span>
                <strong>Replay the tour</strong>
                <small>Walk through Overview, Patients, Orders, Create order, Catalogue, Finance and Settings again.</small>
              </span>
              <button type="button" className="btn btn-sm pharmacy-settings-tour-replay" onClick={() => requestWorkspaceTourReplay()}>
                <RefreshCw size={13} /> Replay
              </button>
            </div>
          </section>
          {KEY_CONTACTS.map((contact, index) => (
            <section
              key={contact.key}
              className={`pharmacy-details__card${KEY_CONTACTS.length % 2 === 1 && index === KEY_CONTACTS.length - 1 ? ' is-wide' : ''}`}
              aria-labelledby={`settings-contact-${contact.key}`}
            >
              <header>
                <span className="pharmacy-details__icon" aria-hidden="true">{contact.phone ? <Phone size={16} /> : <Mail size={16} />}</span>
                <h4 id={`settings-contact-${contact.key}`}>{contact.org}</h4>
                <span className={`pharmacy-details__tag${contact.pill === 'ok' ? ' is-on' : ''}`}>{contact.role}</span>
              </header>
              {contact.description ? <p className="pharmacy-details__note">{contact.description}</p> : null}
              <dl className="pharmacy-details__list">
                {contact.phone
                  ? row('Phone', <a className="pharmacy-settings-page__contact-link" href={telHref(contact.phone)}>{contact.phone}</a>)
                  : row('Phone', <span className="pharmacy-details__empty">Email only</span>)}
                {contact.emails.map(email => (
                  <div key={email.address} className="pharmacy-details__row">
                    <dt>{email.label ?? 'Email'}</dt>
                    <dd><a className="pharmacy-settings-page__contact-link" href={`mailto:${email.address}`}>{email.address}</a></dd>
                  </div>
                ))}
              </dl>
              {contact.portalUrl ? (
                <a className="pharmacy-details__link" href={contact.portalUrl} target="_blank" rel="noreferrer">Open {contact.org} portal <ExternalLink size={12} aria-hidden="true" /></a>
              ) : null}
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}
