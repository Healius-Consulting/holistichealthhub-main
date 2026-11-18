import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { ImageIcon, ImagePlus, LoaderCircle, Trash2 } from 'lucide-react';
import { describeApiError, getOwnLogo, removeOwnLogo, uploadOwnLogo } from '../shared/api';
import { EMAIL_LOGO_SPEC, normalisePharmacyLogo } from '../utils/pharmacyLogo';

/**
 * The pharmacy's own logo, in Settings → Assets. It heads the pharmacy's patient emails
 * and goes on its poster pack; without one, both use the pharmacy's name. HHH admin can
 * still set it too, from the pharmacy's admin page.
 *
 * `sandbox` (Demo mode or local preview) never touches the server: the chosen logo is
 * shown for this visit only.
 */
export default function PharmacyLogoCard({
  pharmacyName,
  initialUrl,
  sandbox,
  onChange,
  notify,
}: {
  pharmacyName: string;
  initialUrl: string | null;
  sandbox: boolean;
  onChange: (url: string | null) => void;
  notify: (message: string) => void;
}) {
  const [url, setUrl] = useState<string | null>(initialUrl);
  const [loading, setLoading] = useState(!sandbox);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const show = (next: string | null) => {
    setUrl(next);
    onChangeRef.current(next);
  };

  useEffect(() => {
    if (sandbox) return;
    let cancelled = false;
    getOwnLogo()
      .then(view => { if (!cancelled) show(view.emailLogoUrl); })
      .catch(() => { if (!cancelled) setError('Your logo could not be loaded.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sandbox]);

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const prepared = await normalisePharmacyLogo(file);
      if (sandbox) {
        show(URL.createObjectURL(prepared));
        notify('Logo shown for this demo only. Nothing was uploaded.');
      } else {
        show((await uploadOwnLogo(prepared)).emailLogoUrl);
        notify('Logo saved. It is now on your patient emails and your poster pack.');
      }
    } catch (cause) {
      setError(describeApiError(cause, 'The logo could not be saved. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!sandbox) await removeOwnLogo();
      show(null);
      notify(sandbox ? 'Logo removed for this demo only.' : 'Logo removed. Your pharmacy name is used instead.');
    } catch (cause) {
      setError(describeApiError(cause, 'The logo could not be removed. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="pharmacy-details__card is-wide" aria-labelledby="settings-card-logo">
      <header>
        <span className="pharmacy-details__icon" aria-hidden="true"><ImageIcon size={16} /></span>
        <h4 id="settings-card-logo">Logo</h4>
      </header>
      <div className="pharmacy-settings-page__logo">
        <div className="pharmacy-settings-page__logo-preview" aria-live="polite">
          {loading
            ? <LoaderCircle size={16} aria-label="Loading your logo" />
            : url
              ? <img src={url} alt={`${pharmacyName} logo`} />
              : <strong>{pharmacyName}</strong>}
        </div>
        <div className="pharmacy-settings-page__logo-text">
          <p className="pharmacy-details__note">
            {url
              ? 'Heads your patient emails and goes on your poster and leaflet.'
              : 'No logo yet, so your patient emails and posters show your pharmacy name.'}
            {' '}PNG, JPEG or WebP. It is fitted to {EMAIL_LOGO_SPEC.assetWidth} × {EMAIL_LOGO_SPEC.assetHeight} pixels for you.
          </p>
          {error ? <p className="pharmacy-details__error" role="alert">{error}</p> : null}
          <div className="pharmacy-details__actions is-start">
            <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={event => void choose(event)} />
            <button className="btn btn-primary btn-sm" type="button" disabled={busy || loading} onClick={() => input.current?.click()}>
              <ImagePlus size={13} /> {busy ? 'Saving…' : url ? 'Replace logo' : 'Upload logo'}
            </button>
            {url ? (
              <button className="btn btn-sm" type="button" disabled={busy || loading} onClick={() => void remove()}>
                <Trash2 size={13} /> Remove
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
