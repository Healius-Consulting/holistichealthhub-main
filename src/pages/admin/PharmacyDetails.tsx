import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { Building2, Copy, ExternalLink, FileArchive, Globe2, ImagePlus, Link2, Palette, Pencil, Phone, RefreshCw, Trash2 } from 'lucide-react';
import type { PharmacyTenant } from '../../context/AppContext';
import type { UpdateOrganisationInput } from '../../shared/contracts';
import { ApiRequestError, describeApiError, removeOrganisationLogo, updateOrganisation, uploadOrganisationLogo } from '../../shared/api';
import { isLocalPortalPreview } from '../../dev/localPortalPreview';
import { pharmacyFieldErrors, pharmacyLogoText, type PharmacyFieldErrors, type PharmacyFormField } from '../../utils/pharmacyFormErrors';
import { EMAIL_LOGO_SPEC, normalisePharmacyLogo } from '../../utils/pharmacyLogo';
import { brandSwatchStyle, deriveTenantTheme } from '../../utils/tenantTheme';
import { downloadContentPack } from '../../utils/pharmacyResources';
import { splitPharmacyAddress } from './pharmacyAddress';
import { WorldpayEmailCard } from './WorldpayEmailCard';

/**
 * The pharmacy's details as four small cards. Each card edits in place and saves
 * only its own fields, so a correction to an email never touches the brand or
 * the address. There is no status here: a pharmacy goes live when its live
 * Curaleaf credentials are saved, and is rejected from the record header.
 */

type CardId = 'pharmacy' | 'contacts' | 'brand';
type Save = (input: UpdateOrganisationInput, updates: Partial<PharmacyTenant>) => Promise<void>;

function Row({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="pharmacy-details__row">
      <dt>{label}</dt>
      <dd>{value || <span className="pharmacy-details__empty">Not given</span>}{hint ? <small>{hint}</small> : null}</dd>
    </div>
  );
}

function Field({ label, name, value, onChange, errors, type = 'text', required, hint, autoComplete, wide }: {
  label: string;
  name: PharmacyFormField;
  value: string;
  onChange: (value: string) => void;
  errors: PharmacyFieldErrors;
  type?: string;
  required?: boolean;
  hint?: string;
  autoComplete?: string;
  wide?: boolean;
}) {
  const error = errors[name];
  return (
    <label className={wide ? 'is-wide' : undefined}>
      <span>{label}{required ? null : <em>Optional</em>}</span>
      <input
        className="input"
        name={name}
        type={type}
        value={value}
        onChange={event => onChange(event.target.value)}
        required={required}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
      />
      {error ? <small className="admin-field-error">{error}</small> : hint ? <small>{hint}</small> : null}
    </label>
  );
}

function Card({ id, icon, title, editing, onEdit, children }: {
  id: CardId;
  icon: ReactNode;
  title: string;
  editing: CardId | null;
  onEdit: (id: CardId) => void;
  children: ReactNode;
}) {
  return (
    <section className={`pharmacy-details__card${editing === id ? ' is-editing' : ''}`} aria-labelledby={`pharmacy-details-${id}`}>
      <header>
        <span className="pharmacy-details__icon" aria-hidden="true">{icon}</span>
        <h4 id={`pharmacy-details-${id}`}>{title}</h4>
        {editing === id ? null : (
          <button type="button" className="btn btn-sm" disabled={editing !== null} onClick={() => onEdit(id)} aria-label={`Edit ${title.toLowerCase()}`}>
            <Pencil size={13} /> Edit
          </button>
        )}
      </header>
      {children}
    </section>
  );
}

function EditForm({ onCancel, onSubmit, busy, error, children }: {
  onCancel: () => void;
  onSubmit: () => void;
  busy: boolean;
  error: string | null;
  children: ReactNode;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <form className="pharmacy-details__form" onSubmit={submit} noValidate={false}>
      <div className="pharmacy-details__fields">{children}</div>
      {error ? <p className="pharmacy-details__error" role="alert">{error}</p> : null}
      <div className="pharmacy-details__actions">
        <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

function useCardForm(save: Save, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errors, setErrors] = useState<PharmacyFieldErrors>({});
  const run = async (input: UpdateOrganisationInput, updates: Partial<PharmacyTenant>, after?: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setErrors({});
    try {
      await save(input, updates);
      if (after) await after();
      onDone();
    } catch (cause) {
      const { fields, unplaced } = pharmacyFieldErrors(cause instanceof ApiRequestError ? cause.details : []);
      setErrors(fields);
      setError(Object.keys(fields).length ? (unplaced.join(' ') || 'Check the highlighted fields.') : describeApiError(cause, 'These details could not be saved.'));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, errors, run };
}

function PharmacyCard({ organisation, editing, setEditing, save }: CardProps) {
  const empty = { name: '', tradingName: '', companyNumber: '', gphcNumber: '', superintendent: '', addressLine1: '', addressLine2: '', locality: '', postcode: '' };
  const [form, setForm] = useState(empty);
  const { busy, error, errors, run } = useCardForm(save, () => setEditing(null));
  const open = editing === 'pharmacy';
  useEffect(() => {
    if (open) setForm({
      name: organisation.name,
      tradingName: organisation.tradingName,
      companyNumber: organisation.companyNumber ?? '',
      gphcNumber: organisation.gphcNumber,
      superintendent: organisation.superintendent,
      ...splitPharmacyAddress(organisation),
    });
  }, [open, organisation]);
  const set = (key: keyof typeof form) => (value: string) => setForm(current => ({ ...current, [key]: key === 'postcode' ? value.toUpperCase() : value }));
  const submit = () => {
    const name = form.name.trim();
    const logoText = pharmacyLogoText(name, organisation.logoText).toUpperCase();
    const lines = { addressLine1: form.addressLine1.trim(), addressLine2: form.addressLine2.trim(), locality: form.locality.trim(), postcode: form.postcode.trim().toUpperCase() };
    const address = [lines.addressLine1, lines.addressLine2, lines.locality, lines.postcode].filter(Boolean).join(', ');
    const fields = { name, tradingName: form.tradingName.trim(), gphcNumber: form.gphcNumber.trim(), superintendent: form.superintendent.trim() };
    void run(
      { ...fields, companyNumber: form.companyNumber.trim(), portalName: name, logoText, address, ...lines },
      { ...fields, companyNumber: form.companyNumber.trim() || undefined, logoText, brand: { ...organisation.brand, portalName: name }, address, ...lines },
    );
  };
  const lines = splitPharmacyAddress(organisation);
  return (
    <Card id="pharmacy" icon={<Building2 size={16} />} title="Pharmacy" editing={editing} onEdit={setEditing}>
      {open ? (
        <EditForm onCancel={() => setEditing(null)} onSubmit={submit} busy={busy} error={error}>
          <Field label="Pharmacy name" name="name" value={form.name} onChange={set('name')} errors={errors} required hint="Also the name staff see in their portal." wide />
          <Field label="Company name" name="tradingName" value={form.tradingName} onChange={set('tradingName')} errors={errors} required />
          <Field label="Company number" name="companyNumber" value={form.companyNumber} onChange={set('companyNumber')} errors={errors} />
          <Field label="GPhC premises number" name="gphcNumber" value={form.gphcNumber} onChange={set('gphcNumber')} errors={errors} required />
          <Field label="Superintendent pharmacist" name="superintendent" value={form.superintendent} onChange={set('superintendent')} errors={errors} required />
          <p className="pharmacy-details__group is-wide">Registered premises</p>
          <Field label="Address line 1" name="addressLine1" value={form.addressLine1} onChange={set('addressLine1')} errors={errors} required autoComplete="address-line1" wide />
          <Field label="Address line 2" name="addressLine2" value={form.addressLine2} onChange={set('addressLine2')} errors={errors} autoComplete="address-line2" wide />
          <Field label="Town or city" name="locality" value={form.locality} onChange={set('locality')} errors={errors} required autoComplete="address-level2" />
          <Field label="Postcode" name="postcode" value={form.postcode} onChange={set('postcode')} errors={errors} required autoComplete="postal-code" />
        </EditForm>
      ) : (
        <dl className="pharmacy-details__list">
          <Row label="Pharmacy name" value={organisation.name} />
          <Row label="Company" value={organisation.tradingName} hint={organisation.companyNumber ? `Company number ${organisation.companyNumber}` : undefined} />
          <Row label="GPhC number" value={organisation.gphcNumber} />
          <Row label="Superintendent" value={organisation.superintendent} />
          <Row label="Premises" value={[lines.addressLine1, lines.addressLine2, lines.locality, lines.postcode].filter(Boolean).join(', ')} />
        </dl>
      )}
    </Card>
  );
}

type CardProps = {
  organisation: PharmacyTenant;
  editing: CardId | null;
  setEditing: (id: CardId | null) => void;
  save: Save;
};

function ContactsCard({ organisation, editing, setEditing, save }: CardProps) {
  const [form, setForm] = useState({ pharmacyPhone: '', pharmacyEmail: '', mainContactName: '', mainContactPhone: '', mainContactEmail: '' });
  const { busy, error, errors, run } = useCardForm(save, () => setEditing(null));
  const open = editing === 'contacts';
  useEffect(() => {
    if (open) setForm({
      pharmacyPhone: organisation.pharmacyPhone ?? '',
      pharmacyEmail: organisation.pharmacyEmail ?? '',
      mainContactName: organisation.mainContactName ?? organisation.superintendent,
      mainContactPhone: organisation.mainContactPhone ?? '',
      mainContactEmail: organisation.mainContactEmail ?? '',
    });
  }, [open, organisation]);
  const set = (key: keyof typeof form) => (value: string) => setForm(current => ({ ...current, [key]: value }));
  const submit = () => {
    const trimmed = Object.fromEntries(Object.entries(form).map(([key, value]) => [key, value.trim()])) as typeof form;
    void run(trimmed, { ...trimmed, pharmacyPhone: trimmed.pharmacyPhone || undefined, pharmacyEmail: trimmed.pharmacyEmail || undefined });
  };
  return (
    <Card id="contacts" icon={<Phone size={16} />} title="Contacts" editing={editing} onEdit={setEditing}>
      {open ? (
        <EditForm onCancel={() => setEditing(null)} onSubmit={submit} busy={busy} error={error}>
          <p className="pharmacy-details__group is-wide">Pharmacy</p>
          <Field label="Pharmacy landline" name="pharmacyPhone" type="tel" value={form.pharmacyPhone} onChange={set('pharmacyPhone')} errors={errors} autoComplete="tel" />
          <Field label="Pharmacy email" name="pharmacyEmail" type="email" value={form.pharmacyEmail} onChange={set('pharmacyEmail')} errors={errors} autoComplete="email" />
          <p className="pharmacy-details__group is-wide">For HHH only</p>
          <Field label="Superintendent contact" name="mainContactName" value={form.mainContactName} onChange={set('mainContactName')} errors={errors} required wide />
          <Field label="Contact number" name="mainContactPhone" type="tel" value={form.mainContactPhone} onChange={set('mainContactPhone')} errors={errors} required />
          <Field label="Contact email" name="mainContactEmail" type="email" value={form.mainContactEmail} onChange={set('mainContactEmail')} errors={errors} required />
        </EditForm>
      ) : (
        <dl className="pharmacy-details__list">
          <Row label="Pharmacy landline" value={organisation.pharmacyPhone} />
          <Row label="Pharmacy email" value={organisation.pharmacyEmail} />
          <Row label="Superintendent contact" value={organisation.mainContactName || organisation.superintendent} />
          <Row label="Contact number" value={organisation.mainContactPhone} />
          <Row label="Contact email" value={organisation.mainContactEmail} />
        </dl>
      )}
    </Card>
  );
}

function BrandCard({ organisation, editing, setEditing, save }: CardProps) {
  const [colour, setColour] = useState(organisation.brand.primary);
  const [domains, setDomains] = useState('');
  const [logoUrl, setLogoUrl] = useState<string | null>(organisation.emailLogoUrl ?? null);
  const [pendingLogo, setPendingLogo] = useState<File | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const logoInput = useRef<HTMLInputElement>(null);
  const { busy, error, errors, run } = useCardForm(save, () => setEditing(null));
  const open = editing === 'brand';
  useEffect(() => {
    if (!open) return;
    setColour(organisation.brand.primary);
    setDomains(organisation.websiteDomains.join('\n'));
    setLogoUrl(organisation.emailLogoUrl ?? null);
    setPendingLogo(null);
    setRemoveLogo(false);
    setLogoError(null);
  }, [open, organisation]);
  useEffect(() => () => { if (logoUrl?.startsWith('blob:')) URL.revokeObjectURL(logoUrl); }, [logoUrl]);

  const shownColour = open ? colour : organisation.brand.primary;
  const theme = deriveTenantTheme(shownColour);
  const shownLogo = open ? logoUrl : organisation.emailLogoUrl ?? null;

  const chooseLogo = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setLogoError(null);
    try {
      const normalised = await normalisePharmacyLogo(file);
      setPendingLogo(normalised);
      setRemoveLogo(false);
      setLogoUrl(URL.createObjectURL(normalised));
    } catch (cause) {
      setLogoError(cause instanceof Error ? cause.message : 'The logo could not be prepared.');
    }
  };

  const submit = () => {
    const websiteDomains = [...new Set(domains.split(/[\n,]+/).map(value => value.trim().replace(/^https?:\/\//i, '').split('/')[0]!.toLowerCase()).filter(Boolean))];
    // The logo is its own upload; it runs after the colour and domains save, inside the same Save.
    const saveLogo = async () => {
      if (!pendingLogo && !removeLogo) return;
      if (isLocalPortalPreview) {
        await save({}, { emailLogoUrl: removeLogo ? null : logoUrl });
        return;
      }
      const updated = removeLogo ? await removeOrganisationLogo(organisation.id) : await uploadOrganisationLogo(organisation.id, pendingLogo!);
      await save({}, {
        emailLogoUrl: updated.emailLogoUrl ?? null,
        emailLogoStoragePath: updated.emailLogoStoragePath ?? null,
        emailLogoWidth: updated.emailLogoWidth ?? null,
        emailLogoHeight: updated.emailLogoHeight ?? null,
        emailLogoUpdatedAt: updated.emailLogoUpdatedAt ?? null,
      });
    };
    void run({ primaryColour: colour, websiteDomains }, { brand: { ...organisation.brand, primary: colour }, websiteDomains }, saveLogo);
  };

  return (
    <Card id="brand" icon={<Palette size={16} />} title="Brand and website" editing={editing} onEdit={setEditing}>
      {open ? (
        <EditForm onCancel={() => setEditing(null)} onSubmit={submit} busy={busy} error={error || logoError}>
          <label className="pharmacy-details__colour">
            <span>Brand colour</span>
            <span className="pharmacy-details__colour-input">
              <input type="color" name="primaryColour" value={colour} onChange={event => setColour(event.target.value)} aria-invalid={errors.primaryColour ? true : undefined} />
              <code>{colour.toUpperCase()}</code>
            </span>
            {errors.primaryColour ? <small className="admin-field-error">{errors.primaryColour}</small> : <small>An accessible palette is made from it.</small>}
          </label>
          <div className="pharmacy-details__logo">
            <span>Email logo <em>Optional</em></span>
            <input ref={logoInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => void chooseLogo(event)} />
            <span className="pharmacy-details__logo-actions">
              <button type="button" className="btn btn-sm" onClick={() => logoInput.current?.click()} disabled={busy}><ImagePlus size={13} /> {logoUrl ? 'Replace' : 'Upload'}</button>
              {logoUrl ? (
                <button type="button" className="btn btn-sm" onClick={() => { setPendingLogo(null); setLogoUrl(null); setRemoveLogo(Boolean(organisation.emailLogoUrl)); }} disabled={busy}><Trash2 size={13} /> Remove</button>
              ) : null}
            </span>
            <small>PNG, JPEG or WebP, fitted to {EMAIL_LOGO_SPEC.assetWidth} × {EMAIL_LOGO_SPEC.assetHeight}px.</small>
          </div>
          <label className="is-wide">
            <span>Approved website domains <em>Optional</em></span>
            <textarea className="input" name="websiteDomains" rows={2} value={domains} onChange={event => setDomains(event.target.value)} placeholder={'pharmacy.co.uk\nanother-pharmacy.co.uk'} aria-invalid={errors.websiteDomains ? true : undefined} />
            {errors.websiteDomains ? <small className="admin-field-error">{errors.websiteDomains}</small> : <small>One per line. Sites allowed to embed the eligibility form.</small>}
          </label>
        </EditForm>
      ) : (
        <dl className="pharmacy-details__list">
          <Row label="Brand" value={(
            <span className="pharmacy-details__brand-row">
              <span className={`pharmacy-details__mark${shownLogo ? ' has-image' : ''}`} style={shownLogo ? undefined : brandSwatchStyle(shownColour)}>
                {shownLogo ? <img src={shownLogo} alt="" /> : organisation.logoText}
              </span>
              <span className="pharmacy-details__swatches" aria-hidden="true">
                <i style={{ background: theme.primary }} />
                <i style={{ background: theme.secondary }} />
                <i style={{ background: theme.primarySoft }} />
              </span>
              <code>{organisation.brand.primary.toUpperCase()}</code>
            </span>
          )} hint="Staff portal and eligibility form" />
          <Row label="Email logo" value={organisation.emailLogoUrl ? 'Uploaded' : ''} />
          <Row label="Website domains" value={organisation.websiteDomains.length ? <span className="pharmacy-details__domains"><Globe2 size={13} />{organisation.websiteDomains.join(', ')}</span> : ''} />
        </dl>
      )}
    </Card>
  );
}

function EligibilityCard({ organisation, link, loading, error, onRetry, onCopied }: {
  organisation: PharmacyTenant;
  link: string;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onCopied: () => void;
}) {
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      onCopied();
    } catch {
      /* Clipboard refused: the link stays selectable in the box. */
    }
  };
  return (
    <section className="pharmacy-details__card" aria-labelledby="pharmacy-details-eligibility">
      <header>
        <span className="pharmacy-details__icon" aria-hidden="true"><Link2 size={16} /></span>
        <h4 id="pharmacy-details-eligibility">Eligibility link</h4>
      </header>
      <p className="pharmacy-details__note">Every patient who uses this link or its QR code is attributed to {organisation.name}.</p>
      {error ? (
        <p className="pharmacy-details__error" role="alert">{error} <button type="button" className="pharmacy-details__link" onClick={onRetry}><RefreshCw size={12} /> Try again</button></p>
      ) : (
        <code className="pharmacy-details__url">{loading ? 'Loading the pharmacy link…' : link || 'Link unavailable'}</code>
      )}
      <div className="pharmacy-details__actions is-start">
        <button type="button" className="btn btn-primary btn-sm" disabled={!link} onClick={() => void copy()}><Copy size={13} /> Copy link</button>
        {link ? <a className="btn btn-sm" href={link} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Preview form</a> : null}
        <button type="button" className="btn btn-sm" disabled={!link} onClick={() => void downloadContentPack(organisation, link)}><FileArchive size={13} /> Content pack</button>
      </div>
    </section>
  );
}

export function PharmacyDetails({
  organisation,
  onSaved,
  curaleaf,
  link,
  onToast,
}: {
  organisation: PharmacyTenant;
  onSaved: (updates: Partial<PharmacyTenant>) => void;
  /** The Curaleaf connection, shown as its own card in the details grid. */
  curaleaf: ReactNode;
  link: { url: string; loading: boolean; error: string | null; retry: () => void };
  onToast: (message: string) => void;
}) {
  const [editing, setEditing] = useState<CardId | null>(null);
  useEffect(() => { setEditing(null); }, [organisation.id]);

  const save: Save = async (input, updates) => {
    if (Object.keys(input).length && !isLocalPortalPreview) {
      const saved = await updateOrganisation(organisation.id, input);
      onSaved({ ...updates, ...(saved.address ? { address: saved.address } : {}), ...(saved.websiteDomains ? { websiteDomains: saved.websiteDomains } : {}) });
    } else {
      onSaved(updates);
    }
    if (Object.keys(input).length) onToast('Pharmacy details saved.');
  };

  const props = { organisation, editing, setEditing, save };
  return (
    <div className="pharmacy-details">
      <PharmacyCard {...props} />
      <ContactsCard {...props} />
      <BrandCard {...props} />
      <EligibilityCard organisation={organisation} link={link.url} loading={link.loading} error={link.error} onRetry={link.retry} onCopied={() => onToast('Eligibility link copied.')} />
      {curaleaf}
      <WorldpayEmailCard organisationId={organisation.id} onToast={onToast} />
    </div>
  );
}
