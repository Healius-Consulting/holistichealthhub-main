import { useEffect, useState } from 'react';
import { Download, ExternalLink, FileArchive } from 'lucide-react';
import {
  describeApiError,
  fetchContentPackFile,
  getContentPackDownloadLink,
  getContentPacks,
  isApiConfigured,
  type PharmacyContentPackCard,
  type PharmacyContentPackGroup,
} from '../shared/api';
import { pharmacyContentPacks, resolveContentPacks } from '../../services/api-sql/src/domain/content-packs/content-packs.ts';
import { contentPackGroupElementId } from '../routing/settingsLink';
import { downloadDataUrl } from '../utils/pharmacyResources';

const issued = (group: PharmacyContentPackGroup) => {
  if (!group.version && !group.issuedAt) return null;
  const date = group.issuedAt ? new Date(group.issuedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
  return [group.version, date].filter(Boolean).join(' · ');
};

/**
 * Settings → Assets → Content packs (FB-20): one card per pack, one download per group.
 * Uploaded groups download the file HHH issued. C.1 Website kit and C.2 Counter print are
 * built here for this pharmacy (its link, QR code and logo), as the old Developer pack and
 * Poster pack were. In Demo mode or local preview nothing is fetched; only those two show.
 */
export default function ContentPacks({
  sandbox,
  websiteKitReady,
  onWebsiteKit,
  counterPrint,
  notify,
}: {
  sandbox: boolean;
  /** The eligibility link has loaded (C.1 and C.2 carry it). */
  websiteKitReady: boolean;
  onWebsiteKit: (kit: { zip: Blob | null; libraryUrl: string | null }) => Promise<void>;
  counterPrint: { on: boolean; open: boolean; busy: boolean; download: () => Promise<void> };
  notify: (message: string) => void;
}) {
  const [cards, setCards] = useState<PharmacyContentPackCard[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sandbox || !isApiConfigured) {
      setCards(pharmacyContentPacks(resolveContentPacks(null)).cards as PharmacyContentPackCard[]);
      return;
    }
    let cancelled = false;
    getContentPacks()
      .then(view => { if (!cancelled) setCards(view.cards); })
      .catch(() => {
        if (cancelled) return;
        // Still offer what the portal builds itself.
        setFailed(true);
        setCards(pharmacyContentPacks(resolveContentPacks(null)).cards as PharmacyContentPackCard[]);
      });
    return () => { cancelled = true; };
  }, [sandbox]);

  const download = async (group: PharmacyContentPackGroup) => {
    setBusy(group.id);
    setError(null);
    try {
      if (group.source === 'counter_print') {
        await counterPrint.download();
      } else if (group.source === 'website_kit') {
        const zip = group.hasFile && !sandbox ? await fetchContentPackFile(group.id) : null;
        await onWebsiteKit({ zip, libraryUrl: group.libraryUrl });
        notify(`${group.label} downloaded.`);
      } else {
        // Straight from Storage: the link names the file, so the browser saves it, whatever its size.
        const link = await getContentPackDownloadLink(group.id);
        downloadDataUrl(link.url, link.filename);
        notify(`${group.label} is downloading.`);
      }
    } catch (caught) {
      setError(describeApiError(caught, 'That download could not be made. Try again.'));
    } finally {
      setBusy(null);
    }
  };

  const button = (group: PharmacyContentPackGroup) => {
    const disabled = busy !== null
      || ((group.source === 'website_kit' || group.source === 'counter_print') && !websiteKitReady)
      || (group.source === 'counter_print' && (!counterPrint.open || counterPrint.busy));
    const kind = group.source === 'upload' ? (group.filename?.split('.').pop()?.toLowerCase() ?? 'zip') : 'zip';
    return (
      <button className="btn btn-sm" type="button" disabled={disabled} onClick={() => void download(group)}>
        <Download size={13} /> {busy === group.id || (group.source === 'counter_print' && counterPrint.busy) ? 'Making…' : `Download .${kind}`}
      </button>
    );
  };

  const hint = (group: PharmacyContentPackGroup) => {
    if (group.source === 'website_kit') return 'Your eligibility link, QR code and website files, zipped for your web developer.';
    if (group.source === 'counter_print') {
      if (!counterPrint.on) return 'An A3 poster and a two-sided A5 leaflet with your logo and QR code will appear here soon.';
      return counterPrint.open
        ? 'An A3 poster and a two-sided A5 leaflet with your logo and QR code, as print-ready PDFs to send to your printer.'
        : 'Available again once your eligibility link is back on.';
    }
    return group.filename;
  };

  if (!cards) return null;
  return (
    <>
      {error ? <p className="pharmacy-details__error is-wide" role="alert">{error}</p> : null}
      {failed ? <p className="pharmacy-details__note is-wide">Some content packs could not be loaded just now. Refresh the page to try again.</p> : null}
      {cards.map((card, index) => (
        <section key={card.id} className="pharmacy-details__card is-wide content-pack" aria-labelledby={`content-pack-${card.id}`}>
          <header>
            <span className="pharmacy-details__icon" aria-hidden="true"><FileArchive size={16} /></span>
            {/* The first card keeps the old id, so existing links to "Content packs" still land here. */}
            <h4 id={`content-pack-${card.id}`}>
              {index === 0 ? <span id="settings-card-packs" className="content-pack__anchor" /> : null}
              {card.title}
            </h4>
          </header>
          <p className="pharmacy-details__note">
            {card.description}
            {card.audience ? <small className="content-pack__audience">For: {card.audience}</small> : null}
          </p>
          <ul className="pharmacy-settings-page__packs">
            {card.groups.map(group => (
              <li key={group.id} id={contentPackGroupElementId(group.id)} className={`pharmacy-details__switch-row content-pack__group${group.source === 'counter_print' && !counterPrint.on ? ' is-muted' : ''}`}>
                <span>
                  <strong>{group.label}</strong>
                  <small>
                    {hint(group)}
                    {issued(group) ? <span className="content-pack__issued"> · {issued(group)}</span> : null}
                  </small>
                  {group.source === 'website_kit' && group.libraryUrl ? (
                    <small><a href={group.libraryUrl} target="_blank" rel="noopener noreferrer">Open the block library <ExternalLink size={11} aria-hidden="true" /></a></small>
                  ) : null}
                </span>
                {group.source === 'counter_print' && !counterPrint.on ? <span className="pharmacy-details__tag">Coming soon</span> : button(group)}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
