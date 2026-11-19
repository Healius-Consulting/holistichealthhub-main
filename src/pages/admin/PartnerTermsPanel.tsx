import { useCallback, useEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { PdfPreview } from '../../components/PdfPreview';
import { isLocalPortalPreview } from '../../dev/localPortalPreview';
import {
  describeApiError,
  getAdminPartnerTerms,
  openAdminPartnerTerms,
  publishPartnerTerms,
  setPartnerTermsEnabled,
  uploadPartnerTerms,
  withdrawPartnerTerms,
  type PartnerTermsAdminView,
  type PartnerTermsDocumentView,
  type PartnerTermsPharmacyStatus,
} from '../../shared/api';

/**
 * HHH admin: the Partner Terms as uploaded PDFs. Upload a version (a draft you can
 * preview), publish it to make it current, and switch acceptance on once a version is
 * published. Every published version asks each pharmacy to sign it at its next login.
 */

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

const STATUS_LABEL: Record<PartnerTermsPharmacyStatus['status'], string> = {
  signed: 'Signed',
  skipped: 'Skipped',
  viewed: 'Seen, not signed',
  not_seen: 'Not seen yet',
};

const LOCAL_VIEW: PartnerTermsAdminView = { settings: { enabled: false, currentDocumentId: null }, currentDocumentId: null, documents: [], pharmacies: [] };

function docState(document: PartnerTermsDocumentView, currentId: string | null) {
  if (document.withdrawnAt) return { label: 'Withdrawn', tone: 'is-muted' };
  if (document.id === currentId) return { label: 'Current', tone: 'is-green' };
  if (document.publishedAt) return { label: 'Replaced', tone: 'is-muted' };
  return { label: 'Draft', tone: 'is-amber' };
}

export function PartnerTermsPanel() {
  const [view, setView] = useState<PartnerTermsAdminView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [version, setVersion] = useState('');
  const [confirming, setConfirming] = useState<{ kind: 'publish' | 'withdraw' | 'enable'; id?: string } | null>(null);
  const [preview, setPreview] = useState<{ id: string; url: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    setError(null);
    if (isLocalPortalPreview) { setView(LOCAL_VIEW); return; }
    getAdminPartnerTerms().then(setView).catch(cause => setError(describeApiError(cause, 'The Partner Terms could not be loaded.')));
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (label: string, work: () => Promise<PartnerTermsAdminView>, done: string) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      setView(await work());
      setNotice(done);
      setConfirming(null);
    } catch (cause) {
      setError(describeApiError(cause, 'That did not work. Try again.'));
    } finally {
      setBusy(null);
    }
  };

  const upload = () => {
    if (!file) { setError('Choose the Partner Terms PDF.'); return; }
    if (!version.trim()) { setError('Name the version, for example v1.0.'); return; }
    void act('upload', () => uploadPartnerTerms(file, version.trim()), `${version.trim()} uploaded as a draft. Preview it, then publish it when it is final.`).then(() => {
      setFile(null);
      setVersion('');
      if (fileInput.current) fileInput.current.value = '';
    });
  };

  const showPreview = async (id: string) => {
    if (preview?.id === id) { setPreview(null); return; }
    try {
      setPreview({ id, url: await openAdminPartnerTerms(id) });
    } catch (cause) {
      setError(describeApiError(cause, 'The PDF could not be opened.'));
    }
  };

  if (!view) return error ? <><p className="wpa-banner is-red" role="alert">{error}</p><button type="button" className="btn btn-sm" onClick={load}>Try again</button></> : <p className="wpa-muted">Loading…</p>;

  const current = view.documents.find(document => document.id === view.currentDocumentId) ?? null;
  const prompted = view.pharmacies.length;
  const signed = view.pharmacies.filter(row => row.status === 'signed').length;

  return (
    <div className="onb-settings__panel terms-admin">
      {notice ? <p className="wpa-banner is-green" role="status">{notice}</p> : null}
      {error ? <p className="wpa-banner is-red" role="alert">{error}</p> : null}

      <section className="terms-admin__switch">
        <div>
          <strong>Ask pharmacies to sign the Partner Terms</strong>
          <p>
            {view.settings.enabled
              ? `On. New pharmacies sign ${current ? `version ${current.version}` : 'the current version'} before their Curaleaf application goes, and every activated pharmacy is asked at login until it signs.`
              : 'Off. Sign-up has no Terms step, the Curaleaf form goes to Curaleaf straight away, and nobody is asked to sign.'}
          </p>
          {!current ? <p className="wpa-field__hint">Publish a version below before switching this on.</p> : null}
        </div>
        <label className={`terms-admin__toggle${view.settings.enabled ? ' is-on' : ''}`}>
          <input
            type="checkbox"
            role="switch"
            checked={view.settings.enabled}
            disabled={busy !== null || (!current && !view.settings.enabled)}
            onChange={event => {
              if (event.target.checked) setConfirming({ kind: 'enable' });
              else void act('switch', () => setPartnerTermsEnabled(false), 'Switched off. Nobody is asked to sign until you switch it on again.');
            }}
          />
          <span aria-hidden="true" />
          <span className="sr-only">Ask pharmacies to sign the Partner Terms</span>
        </label>
      </section>
      {confirming?.kind === 'enable' ? (
        <div className="wpa-banner is-amber terms-admin__confirm" role="alert">
          <span>Switch the Partner Terms on? New pharmacies will have to sign version {current?.version} at sign-up, and {prompted || 'every'} activated pharmac{prompted === 1 ? 'y is' : 'ies are'} asked to sign it at their next login.</span>
          <span className="wpa-inline">
            <button type="button" className="btn btn-sm" onClick={() => setConfirming(null)} disabled={busy !== null}>Cancel</button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void act('switch', () => setPartnerTermsEnabled(true), 'Switched on. Pharmacies are asked to sign at their next login.')} disabled={busy !== null}>{busy === 'switch' ? 'Switching on…' : 'Yes, switch on'}</button>
          </span>
        </div>
      ) : null}

      <section className="terms-admin__upload">
        <h4>Upload a new version</h4>
        <p className="onb-settings__when">A PDF, up to 10 MB. It is saved as a draft: nothing changes for pharmacies until you publish it.</p>
        <div className="terms-admin__upload-row">
          <label className="wpa-field">
            <span className="wpa-field__label">Version name</span>
            <input className="input" value={version} maxLength={60} placeholder="v1.0" onChange={event => setVersion(event.target.value)} />
          </label>
          <label className="wpa-field">
            <span className="wpa-field__label">PDF</span>
            <input ref={fileInput} className="input" type="file" accept="application/pdf,.pdf" onChange={event => setFile(event.target.files?.[0] ?? null)} />
          </label>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null} onClick={upload}>
            <Upload size={13} aria-hidden="true" /> {busy === 'upload' ? 'Uploading…' : 'Upload draft'}
          </button>
        </div>
      </section>

      <section>
        <h4>Versions</h4>
        {view.documents.length === 0 ? <p className="wpa-muted">No versions uploaded yet.</p> : (
          <ul className="terms-admin__versions">
            {view.documents.map(document => {
              const state = docState(document, view.currentDocumentId);
              return (
                <li key={document.id}>
                  <div className="terms-admin__version">
                    <span>
                      <strong>{document.version}</strong> <span className={`wpa-pill ${state.tone}`}>{state.label}</span>
                      <small>{document.filename} · uploaded {day(document.uploadedAt)}{document.publishedAt ? ` · published ${day(document.publishedAt)}` : ''}{document.withdrawnAt ? ` · withdrawn ${day(document.withdrawnAt)}` : ''}</small>
                    </span>
                    <span className="wpa-inline">
                      <button type="button" className="btn btn-sm" onClick={() => void showPreview(document.id)}>{preview?.id === document.id ? 'Hide preview' : 'Preview'}</button>
                      {!document.publishedAt && !document.withdrawnAt ? <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => setConfirming({ kind: 'publish', id: document.id })}>Publish</button> : null}
                      {document.id === view.currentDocumentId && !document.signed ? <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => setConfirming({ kind: 'withdraw', id: document.id })}>Withdraw</button> : null}
                    </span>
                  </div>
                  {confirming?.id === document.id && confirming.kind === 'publish' ? (
                    <div className="wpa-banner is-amber terms-admin__confirm" role="alert">
                      <span>Publish {document.version}? It becomes the current version{view.settings.enabled ? `, and ${prompted || 'every'} activated pharmac${prompted === 1 ? 'y is' : 'ies are'} asked to sign it at their next login` : '. Pharmacies are asked to sign it once you switch the Terms on'}. Once someone signs it, it can no longer be withdrawn.</span>
                      <span className="wpa-inline">
                        <button type="button" className="btn btn-sm" onClick={() => setConfirming(null)} disabled={busy !== null}>Cancel</button>
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => void act('publish', () => publishPartnerTerms(document.id), `${document.version} published.`)} disabled={busy !== null}>{busy === 'publish' ? 'Publishing…' : 'Yes, publish'}</button>
                      </span>
                    </div>
                  ) : null}
                  {confirming?.id === document.id && confirming.kind === 'withdraw' ? (
                    <div className="wpa-banner is-amber terms-admin__confirm" role="alert">
                      <span>Withdraw {document.version}? Nobody has signed it yet. The prompts for it stop and the previous published version, if any, becomes current again.</span>
                      <span className="wpa-inline">
                        <button type="button" className="btn btn-sm" onClick={() => setConfirming(null)} disabled={busy !== null}>Cancel</button>
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => void act('withdraw', () => withdrawPartnerTerms(document.id), `${document.version} withdrawn.`)} disabled={busy !== null}>{busy === 'withdraw' ? 'Withdrawing…' : 'Yes, withdraw'}</button>
                      </span>
                    </div>
                  ) : null}
                  {preview?.id === document.id ? <div className="terms-admin__preview"><PdfPreview href={preview.url} /></div> : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {current ? (
        <section>
          <h4>Pharmacies for {current.version}</h4>
          <p className="onb-settings__when">{signed} of {prompted} signed. A pharmacy that has seen it and not signed after 7 days gets one reminder email; a pharmacy that has not logged in is never emailed.</p>
          {view.pharmacies.length ? (
            <table className="terms-admin__table">
              <thead><tr><th>Pharmacy</th><th>Status</th><th>Details</th></tr></thead>
              <tbody>
                {view.pharmacies.map(row => (
                  <tr key={row.organisationId}>
                    <td>{row.name}{row.test ? <small>Test pharmacy</small> : null}</td>
                    <td><span className={`wpa-pill ${row.status === 'signed' ? 'is-green' : row.status === 'not_seen' ? 'is-muted' : 'is-amber'}`}>{STATUS_LABEL[row.status]}</span></td>
                    <td>
                      {row.signedAt ? <small>{row.signerName}, {day(row.signedAt)}</small> : null}
                      {!row.signedAt && row.firstViewedAt ? <small>First seen {day(row.firstViewedAt)}</small> : null}
                      {row.skipCount ? <small>Skipped {row.skipCount}×, last {day(row.lastSkippedAt)}</small> : null}
                      {row.reminderSentAt ? <small>Reminder sent {day(row.reminderSentAt)}</small> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="wpa-muted">No activated pharmacies yet.</p>}
        </section>
      ) : null}
    </div>
  );
}
