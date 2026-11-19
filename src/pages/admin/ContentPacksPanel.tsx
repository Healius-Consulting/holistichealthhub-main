import { useCallback, useEffect, useState } from 'react';
import { Upload } from 'lucide-react';
import { isLocalPortalPreview } from '../../dev/localPortalPreview';
import {
  describeApiError,
  fetchContentPackFile,
  getAdminContentPacks,
  issueContentPackFile,
  saveContentPacksText,
  withdrawContentPackFile,
  type AdminContentPacksView,
  type ContentPackGroupId,
} from '../../shared/api';
import { resolveContentPacks } from '../../../services/api-sql/src/domain/content-packs/content-packs.ts';
import { downloadDataUrl } from '../../utils/pharmacyResources';

/**
 * HHH admin: the content packs pharmacies download from Settings → Assets (FB-20).
 * Edit card titles, descriptions and group labels, and issue, re-issue or withdraw each
 * group's file. A re-issue replaces the download for every pharmacy at once. A group shows
 * to pharmacies only once it has a file (C.1 and C.2 are built per pharmacy and always show).
 */

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' }) : '');
const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

function localView(): AdminContentPacksView {
  const config = resolveContentPacks(null);
  return { cards: config.cards, groups: config.groups.map(group => ({ ...group, file: null, visible: group.source !== 'upload' })) };
}

export function ContentPacksPanel() {
  const [view, setView] = useState<AdminContentPacksView | null>(null);
  const [draft, setDraft] = useState<AdminContentPacksView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [uploads, setUploads] = useState<Record<string, { file: File | null; version: string }>>({});
  const [confirmWithdraw, setConfirmWithdraw] = useState<ContentPackGroupId | null>(null);

  const show = (next: AdminContentPacksView) => { setView(next); setDraft(structuredClone(next)); };
  const load = useCallback(() => {
    setError(null);
    if (isLocalPortalPreview) { show(localView()); return; }
    getAdminContentPacks().then(show).catch(cause => setError(describeApiError(cause, 'The content packs could not be loaded.')));
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (label: string, work: () => Promise<AdminContentPacksView>, done: string) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      show(await work());
      setNotice(done);
    } catch (cause) {
      setError(describeApiError(cause, 'That did not work. Try again.'));
    } finally {
      setBusy(null);
    }
  };

  if (!view || !draft) return error ? <><p className="wpa-banner is-red" role="alert">{error}</p><button type="button" className="btn btn-sm" onClick={load}>Try again</button></> : <p className="wpa-muted">Loading…</p>;

  const dirty = JSON.stringify(draft.cards) !== JSON.stringify(view.cards)
    || draft.groups.some((group, index) => group.label !== view.groups[index]!.label || (group.libraryUrl ?? '') !== (view.groups[index]!.libraryUrl ?? ''));

  const saveText = () => act('text', () => saveContentPacksText({
    cards: draft.cards.map(({ id, title, audience, description }) => ({ id, title, audience, description })),
    groups: draft.groups.map(({ id, label, libraryUrl }) => ({ id, label, ...(id === 'C.1' ? { libraryUrl: libraryUrl ?? '' } : {}) })),
  }), 'Saved. Pharmacies see the new wording straight away.');

  const issue = (groupId: ContentPackGroupId) => {
    const pending = uploads[groupId];
    if (!pending?.file) { setError('Choose a file to issue.'); return; }
    if (!pending.version.trim()) { setError('Give the version a name, such as v1.2.'); return; }
    const reissue = Boolean(view.groups.find(group => group.id === groupId)?.file);
    void act(`issue:${groupId}`, () => issueContentPackFile(groupId, pending.file!, pending.version.trim()), reissue ? `Re-issued ${groupId}. Pharmacies now download the new file.` : `Issued ${groupId}. Pharmacies can download it now.`)
      .then(() => setUploads(current => ({ ...current, [groupId]: { file: null, version: '' } })));
  };

  const preview = async (groupId: ContentPackGroupId, filename: string) => {
    try {
      const blob = await fetchContentPackFile(groupId, true);
      const url = URL.createObjectURL(blob);
      downloadDataUrl(url, filename);
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) {
      setError(describeApiError(cause, 'The file could not be downloaded.'));
    }
  };

  return (
    <div className="onb-settings__panel packs-admin">
      {notice ? <p className="wpa-banner is-green" role="status">{notice}</p> : null}
      {error ? <p className="wpa-banner is-red" role="alert">{error}</p> : null}
      <p className="onb-settings__when">Pharmacies see these under Settings → Assets → Content packs. A card shows once one of its groups has a file; Pack B stays hidden until it has a group.</p>

      {draft.cards.map((card, cardIndex) => (
        <section key={card.id} className="packs-admin__card">
          <div className="packs-admin__fields">
            <label className="wpa-field">
              <span className="wpa-field__label">Card title</span>
              <input className="input" value={card.title} maxLength={80} onChange={event => setDraft(current => current && { ...current, cards: current.cards.map((entry, index) => index === cardIndex ? { ...entry, title: event.target.value } : entry) })} />
            </label>
            <label className="wpa-field">
              <span className="wpa-field__label">For</span>
              <input className="input" value={card.audience} maxLength={120} onChange={event => setDraft(current => current && { ...current, cards: current.cards.map((entry, index) => index === cardIndex ? { ...entry, audience: event.target.value } : entry) })} />
            </label>
            <label className="wpa-field is-wide">
              <span className="wpa-field__label">Description</span>
              <textarea className="input" rows={2} value={card.description} maxLength={400} onChange={event => setDraft(current => current && { ...current, cards: current.cards.map((entry, index) => index === cardIndex ? { ...entry, description: event.target.value } : entry) })} />
            </label>
          </div>
          {draft.groups.filter(group => group.pack === card.id).length === 0 ? <p className="wpa-muted">No download groups yet, so pharmacies don’t see this card.</p> : null}
          <ul className="packs-admin__groups">
            {draft.groups.map((group, groupIndex) => group.pack !== card.id ? null : (
              <li key={group.id} className="packs-admin__group">
                <div className="packs-admin__group-head">
                  <label className="wpa-field">
                    <span className="wpa-field__label">Button label</span>
                    <input className="input" value={group.label} maxLength={80} onChange={event => setDraft(current => current && { ...current, groups: current.groups.map((entry, index) => index === groupIndex ? { ...entry, label: event.target.value } : entry) })} />
                  </label>
                  <span className={`wpa-pill ${view.groups[groupIndex]!.visible ? 'is-green' : 'is-muted'}`}>{view.groups[groupIndex]!.visible ? 'Shown to pharmacies' : 'Hidden: no file yet'}</span>
                </div>
                {group.id === 'C.1' ? (
                  <label className="wpa-field">
                    <span className="wpa-field__label">Block library link <em>Optional</em></span>
                    <input className="input" value={group.libraryUrl ?? ''} placeholder="https://" onChange={event => setDraft(current => current && { ...current, groups: current.groups.map((entry, index) => index === groupIndex ? { ...entry, libraryUrl: event.target.value } : entry) })} />
                  </label>
                ) : null}
                {group.source === 'counter_print' ? (
                  <p className="wpa-muted">Built for each pharmacy: the A3 poster and A5 leaflet with its logo and QR code. No upload.</p>
                ) : (
                  <>
                    <p className="wpa-muted">
                      {group.file
                        ? <>Current: <button type="button" className="wpa-link" onClick={() => void preview(group.id, group.file!.filename)}>{group.file.filename}</button> · {group.version} · issued {day(group.issuedAt)} · {size(group.file.sizeBytes)}</>
                        : group.source === 'website_kit' ? 'No kit issued: pharmacies get their own link, QR code and palette only.' : 'No file issued yet.'}
                    </p>
                    <div className="packs-admin__upload">
                      <label className="wpa-field">
                        <span className="wpa-field__label">Version</span>
                        <input className="input" value={uploads[group.id]?.version ?? ''} maxLength={40} placeholder="v1.0" onChange={event => setUploads(current => ({ ...current, [group.id]: { file: current[group.id]?.file ?? null, version: event.target.value } }))} />
                      </label>
                      <label className="wpa-field">
                        <span className="wpa-field__label">{group.source === 'website_kit' ? 'Kit (.zip)' : 'File (.zip for several files)'}</span>
                        <input className="input" type="file" accept={group.source === 'website_kit' ? '.zip,application/zip' : '.zip,.pdf,.docx,.xlsx,.csv'} onChange={event => { const file = event.target.files?.[0] ?? null; setUploads(current => ({ ...current, [group.id]: { file, version: current[group.id]?.version ?? '' } })); }} />
                      </label>
                      <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null || isLocalPortalPreview} onClick={() => issue(group.id)}>
                        <Upload size={13} /> {busy === `issue:${group.id}` ? 'Uploading…' : group.file ? 'Re-issue' : 'Issue'}
                      </button>
                      {group.file ? (
                        confirmWithdraw === group.id ? (
                          <span className="wpa-inline">
                            <button type="button" className="btn btn-sm btn-danger" disabled={busy !== null} onClick={() => void act(`withdraw:${group.id}`, () => withdrawContentPackFile(group.id), `Withdrew ${group.id}.`).then(() => setConfirmWithdraw(null))}>Yes, withdraw</button>
                            <button type="button" className="btn btn-sm" onClick={() => setConfirmWithdraw(null)}>Cancel</button>
                          </span>
                        ) : <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => setConfirmWithdraw(group.id)}>Withdraw</button>
                      ) : null}
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      <div className="packs-admin__save">
        <button type="button" className="btn btn-sm" disabled={!dirty || busy !== null} onClick={() => setDraft(structuredClone(view))}>Undo changes</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || busy !== null || isLocalPortalPreview} onClick={() => void saveText()}>{busy === 'text' ? 'Saving…' : 'Save wording'}</button>
      </div>
    </div>
  );
}
