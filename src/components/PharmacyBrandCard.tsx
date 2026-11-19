import { useState, type FormEvent } from 'react';
import { Palette, Pencil, Save } from 'lucide-react';
import { brandSwatchStyle } from '../utils/tenantTheme';
import { describeApiError, isApiConfigured, updatePharmacyBrand } from '../shared/api';

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Settings → Organisation: the pharmacy's brand colour (its portal and its patient
 * eligibility form) and the websites it publishes the form on (FB-17). HHH admin can
 * still set both from the pharmacy's admin page.
 *
 * `sandbox` (Demo mode or local preview) never touches the server.
 */
export default function PharmacyBrandCard({
  colour,
  domains,
  sandbox,
  onSaved,
  notify,
}: {
  colour: string;
  domains: string[];
  sandbox: boolean;
  onSaved: (next: { colour: string; domains: string[] }) => void;
  notify: (message: string, tone: 'success' | 'error') => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ colour, domains: domains.join('\n') });
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    setForm({ colour: HEX.test(colour) ? colour : '#173f33', domains: domains.join('\n') });
    setError(null);
    setEditing(true);
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const nextDomains = form.domains.split(/[\n,]/).map(value => value.trim()).filter(Boolean);
    if (!HEX.test(form.colour)) { setError('Choose a colour.'); return; }
    if (nextDomains.length > 10) { setError('Enter up to 10 websites.'); return; }
    setSaving(true);
    setError(null);
    try {
      if (sandbox || !isApiConfigured) {
        onSaved({ colour: form.colour.toLowerCase(), domains: nextDomains });
      } else {
        const saved = await updatePharmacyBrand({ primaryColour: form.colour, websiteDomains: nextDomains });
        onSaved({ colour: saved.primaryColour ?? form.colour.toLowerCase(), domains: saved.websiteDomains ?? nextDomains });
        if (saved.rejectedDomains?.length) {
          notify(`Saved. These websites are already used by another pharmacy: ${saved.rejectedDomains.join(', ')}.`, 'error');
          setEditing(false);
          return;
        }
      }
      notify('Brand and website saved.', 'success');
      setEditing(false);
    } catch (caught) {
      setError(describeApiError(caught, 'Your brand and website could not be saved. Try again.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={`pharmacy-details__card${editing ? ' is-editing' : ''}`} aria-labelledby="settings-card-brand">
      <header>
        <span className="pharmacy-details__icon" aria-hidden="true"><Palette size={16} /></span>
        <h4 id="settings-card-brand">Brand and website</h4>
        {editing ? null : (
          <button type="button" className="btn btn-sm" aria-label="Edit brand and website" onClick={start}>
            <Pencil size={13} /> Edit
          </button>
        )}
      </header>
      {editing ? (
        <form className="pharmacy-details__form" onSubmit={event => void save(event)}>
          <div className="pharmacy-details__fields">
            <label>
              <span>Brand colour</span>
              <span className="pharmacy-brand__colour">
                <input type="color" value={form.colour} onChange={event => setForm(current => ({ ...current, colour: event.target.value }))} aria-label="Brand colour" />
                <input className="input" value={form.colour} onChange={event => setForm(current => ({ ...current, colour: event.target.value.trim() }))} maxLength={7} spellCheck={false} aria-label="Brand colour code" />
              </span>
              <small>Used on your portal and your patient eligibility form.</small>
            </label>
            <label className="is-wide">
              <span>Approved website domains <em>Optional</em></span>
              <textarea className="input" rows={3} value={form.domains} onChange={event => setForm(current => ({ ...current, domains: event.target.value }))} placeholder="mypharmacy.co.uk" spellCheck={false} />
              <small>One per line, without https://. The websites where you link patients to your eligibility form.</small>
            </label>
          </div>
          {error ? <p className="pharmacy-details__error" role="alert">{error}</p> : null}
          <div className="pharmacy-details__actions">
            <button type="button" className="btn btn-sm" disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={saving}><Save size={13} /> {saving ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      ) : (
        <dl className="pharmacy-details__list">
          <div className="pharmacy-details__row">
            <dt>Brand colour</dt>
            <dd><span className="pharmacy-brand__swatch" style={brandSwatchStyle(colour)} aria-hidden="true" /> {colour.toLowerCase()}</dd>
          </div>
          <div className="pharmacy-details__row">
            <dt>Website domains</dt>
            <dd>{domains.length ? domains.join(', ') : <span className="pharmacy-details__empty">Not given</span>}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
