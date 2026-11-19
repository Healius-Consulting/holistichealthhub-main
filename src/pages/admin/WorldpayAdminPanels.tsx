import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ApiRequestError,
  getAdminWorldpayApplication,
  getWorldpayContent,
  listWorldpayApplications,
  openWorldpayApplicationFile,
  openWorldpayServicePdf,
  resendWorldpayApplication,
  saveWorldpayContent,
  setWorldpayApplicationStatus,
  uploadWorldpayServicePdf,
  type AdminWorldpayApplicationRow,
  type WorldpayApplicationStatus,
  type WorldpayContentSettings,
} from '../../shared/api';
import type { WorldpayAnswers } from '../../worldpay/applicationLogic';
import { isLocalPortalPreview } from '../../dev/localPortalPreview';

/**
 * HHH admin: Worldpay merchant applications (spec §3.5) and the content that can
 * change without a release (emails, recipients, pricing panel, scheme answers, the
 * S-04 note and the service information PDF).
 */

const STATUS_LABEL: Record<WorldpayApplicationStatus, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  WITH_WORLDPAY: 'With Worldpay',
  QUERY: 'Query',
  ACCOUNT_OPEN: 'Account open',
  CONNECTED: 'Connected',
  WITHDRAWN: 'Withdrawn',
  DECLINED: 'Declined',
};
const SETTABLE: Array<Exclude<WorldpayApplicationStatus, 'DRAFT' | 'CONNECTED'>> = ['SUBMITTED', 'WITH_WORLDPAY', 'QUERY', 'ACCOUNT_OPEN', 'WITHDRAWN', 'DECLINED'];

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const message = (error: unknown, fallback: string) => (error instanceof ApiRequestError ? error.message : fallback);

function openBlob(url: string) {
  window.open(url, '_blank', 'noopener');
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Shown in Onboarding settings: the submitted applications. */
export function WorldpayApplicationsPanel() {
  if (isLocalPortalPreview) return <p className="wpa-muted">Worldpay applications load from the API, which local preview does not run.</p>;
  return <ApplicationsTab />;
}

/** Shown in Onboarding settings: WP-01 recipients, the service PDF and the Worldpay wording. */
export function WorldpayWordingPanel() {
  if (isLocalPortalPreview) return <p className="wpa-muted">The Worldpay wording loads from the API, which local preview does not run.</p>;
  return <SettingsTab />;
}

function ApplicationsTab() {
  const [rows, setRows] = useState<AdminWorldpayApplicationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const load = useCallback(() => {
    listWorldpayApplications().then(result => { setRows(result.records); setError(null); }).catch(cause => setError(message(cause, 'The applications could not be loaded.')));
  }, []);
  useEffect(load, [load]);
  const replace = (row: AdminWorldpayApplicationRow) => setRows(current => current?.map(item => (item.id === row.id ? row : item)) ?? current);

  if (error) return <p className="wpa-banner is-red" role="alert">{error} <button type="button" className="btn btn-sm" onClick={load}>Try again</button></p>;
  if (!rows) return <p className="wpa-muted">Loading…</p>;
  if (rows.length === 0) return <p className="wpa-muted">No applications have been submitted yet. Drafts appear here once a pharmacy sends one.</p>;
  const current = rows.find(row => row.id === selected) ?? null;
  return (
    <div className="wpa-admin">
      <table className="wpa-admin__table">
        <thead>
          <tr><th>Reference</th><th>Legal name</th><th>Trading name</th><th>Website route</th><th>Status</th><th>Submitted</th><th>Sent</th></tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.id} className={row.id === selected ? 'is-selected' : undefined} onClick={() => setSelected(row.id)} tabIndex={0} onKeyDown={event => { if (event.key === 'Enter') setSelected(row.id); }}>
              <td>{row.reference ?? '—'}</td>
              <td>{row.legalName ?? '—'}{row.companyNameDiffers ? <span className="wpa-tag is-amber" title="The submitted legal name differs from the Companies House name">Name differs</span> : null}</td>
              <td>{row.tradingName ?? '—'}</td>
              <td>{row.websiteRoute}</td>
              <td>{STATUS_LABEL[row.status]}</td>
              <td>{day(row.submittedAt)}</td>
              <td>{row.deliveryError ? <span className="wpa-field__problem">Not sent</span> : day(row.sentAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {current ? <ApplicationDetail key={current.id} row={current} onChanged={replace} /> : <p className="wpa-muted">Choose an application to view it.</p>}
    </div>
  );
}

function Pair({ label, children }: { label: string; children: ReactNode }) {
  return <tr><th scope="row">{label}</th><td>{children || '—'}</td></tr>;
}

function ApplicationDetail({ row, onChanged }: { row: AdminWorldpayApplicationRow; onChanged: (row: AdminWorldpayApplicationRow) => void }) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getAdminWorldpayApplication<WorldpayAnswers>>> | null>(null);
  const [status, setStatus] = useState<Exclude<WorldpayApplicationStatus, 'DRAFT' | 'CONNECTED'>>(row.status === 'DRAFT' || row.status === 'CONNECTED' ? 'SUBMITTED' : row.status);
  const [note, setNote] = useState(row.statusNote ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: 'green' | 'red'; text: string } | null>(null);
  useEffect(() => {
    getAdminWorldpayApplication<WorldpayAnswers>(row.id).then(setDetail).catch(cause => setFeedback({ tone: 'red', text: message(cause, 'The application could not be loaded.') }));
  }, [row.id]);

  const act = async (name: string, run: () => Promise<{ record: AdminWorldpayApplicationRow }>, done: string) => {
    setBusy(name);
    setFeedback(null);
    try {
      const result = await run();
      onChanged(result.record);
      setFeedback({ tone: 'green', text: done });
    } catch (cause) {
      setFeedback({ tone: 'red', text: message(cause, 'That did not work. Try again.') });
    } finally {
      setBusy(null);
    }
  };
  const file = async (kind: 'pdf' | 'xlsx' | 'service') => {
    try { openBlob(await openWorldpayApplicationFile(row.id, kind)); } catch (cause) { setFeedback({ tone: 'red', text: message(cause, 'The file could not be opened.') }); }
  };
  const b = detail?.answers.business;
  return (
    <section className="wpa-card wpa-summary">
      <div className="wpa-summary__head"><strong>{row.reference} · {row.legalName}</strong><span className="wpa-pill is-info">{STATUS_LABEL[row.status]}</span></div>
      {feedback ? <p className={`wpa-banner is-${feedback.tone}`} role="status">{feedback.text}</p> : null}
      {row.deliveryError ? <p className="wpa-banner is-red">WP-01 was not sent: {row.deliveryError}</p> : null}
      <table>
        <tbody>
          <Pair label="Trading name">{row.tradingName}</Pair>
          <Pair label="GPhC">{row.gphcNumber}</Pair>
          <Pair label="Company number">{row.companyNumber ? `${row.companyNumber}${row.companyStatus && row.companyStatus !== 'active' ? ` (Companies House: ${row.companyStatus})` : ''}` : null}</Pair>
          <Pair label="Website route">{row.websiteRoute}</Pair>
          <Pair label="Contact">{b ? [b.contactName, b.contactPosition, b.contactPhone, b.contactEmail || b.businessEmail].filter(Boolean).join(', ') : null}</Pair>
          <Pair label="Principals">{detail ? detail.answers.principals.map(person => `${person.firstNames} ${person.surname}`.trim()).join('; ') : null}</Pair>
          <Pair label="Signed by">{detail ? [detail.signerName, detail.signerPosition].filter(Boolean).join(', ') : null}</Pair>
          <Pair label="Submitted by">{detail ? [detail.submitterName, detail.submitterEmail].filter(Boolean).join(', ') : null}</Pair>
          <Pair label="Submitted">{day(row.submittedAt)}</Pair>
          <Pair label="Sent">{day(row.sentAt)}</Pair>
        </tbody>
      </table>
      {row.cleared ? <p className="wpa-muted">Directors’ and bank details and the files were deleted under the retention rules.</p> : (
        <div className="wpa-inline">
          <button type="button" className="btn btn-sm" onClick={() => void file('pdf')}>Open PDF</button>
          <button type="button" className="btn btn-sm" onClick={() => void file('xlsx')}>Download spreadsheet</button>
          {row.usesHhhWebsite ? <button type="button" className="btn btn-sm" onClick={() => void file('service')}>Open service information PDF</button> : null}
          <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void act('resend', () => resendWorldpayApplication(row.id), 'WP-01 sent again.')}>{busy === 'resend' ? 'Sending…' : 'Resend WP-01'}</button>
        </div>
      )}
      <h4>Status</h4>
      <div className="wpa-grid">
        <label className="wpa-field">
          <span className="wpa-field__label">Status</span>
          <select className="input" value={status} onChange={event => setStatus(event.target.value as typeof status)}>
            {SETTABLE.map(value => <option key={value} value={value}>{STATUS_LABEL[value]}</option>)}
          </select>
          {row.status === 'CONNECTED' ? <span className="wpa-field__hint">Connected is set automatically when the pharmacy’s Worldpay keys validate.</span> : null}
        </label>
        <label className="wpa-field">
          <span className="wpa-field__label">Note for the pharmacy</span>
          <textarea className="input" rows={3} value={note} onChange={event => setNote(event.target.value)} placeholder="Shown to the pharmacy for Query, Withdrawn and Declined" />
        </label>
      </div>
      <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void act('status', () => setWorldpayApplicationStatus(row.id, status, note.trim() || null), 'Status saved.')}>
        {busy === 'status' ? 'Saving…' : 'Save status'}
      </button>
    </section>
  );
}

const MERGE_HELP = 'Merge fields: [legal name], [trading name], [HHH reference], [GPhC number], [contact name], [position], [phone], [contact email], [URL], [submitter first name]. WP-01 can use [If own website]…[/If] and [If no website]…[/If]. A blank line starts a new paragraph.';

function SettingsTab() {
  const [content, setContent] = useState<WorldpayContentSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    getWorldpayContent().then(setContent).catch(cause => setError(message(cause, 'The settings could not be loaded.')));
  }, []);
  if (error && !content) return <p className="wpa-banner is-red" role="alert">{error}</p>;
  if (!content) return <p className="wpa-muted">Loading…</p>;

  const save = async <K extends Exclude<keyof WorldpayContentSettings, 'servicePdf'>>(key: K, label: string) => {
    setBusy(key);
    setError(null);
    setSaved(null);
    try {
      setContent(await saveWorldpayContent(key, content[key]));
      setSaved(`${label} saved.`);
    } catch (cause) {
      setError(message(cause, `${label} could not be saved.`));
    } finally {
      setBusy(null);
    }
  };
  const set = <K extends keyof WorldpayContentSettings>(key: K, value: WorldpayContentSettings[K]) => setContent(current => (current ? { ...current, [key]: value } : current));
  const list = (text: string) => text.split(/[\s,;]+/).map(item => item.trim()).filter(Boolean);
  const saveButton = (key: Exclude<keyof WorldpayContentSettings, 'servicePdf'>, label: string) => (
    <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void save(key, label)}>{busy === key ? 'Saving…' : `Save ${label.toLowerCase()}`}</button>
  );
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy('servicePdf');
    setError(null);
    setSaved(null);
    try {
      setContent(await uploadWorldpayServicePdf(file));
      setSaved('Service information PDF replaced.');
    } catch (cause) {
      setError(message(cause, 'The PDF could not be uploaded.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="wpa-admin-settings">
      {saved ? <p className="wpa-banner is-green" role="status">{saved}</p> : null}
      {error ? <p className="wpa-banner is-red" role="alert">{error}</p> : null}

      <h4>WP-01 recipients</h4>
      <p className="wpa-muted">Where submitted applications are emailed, with the PDF, the spreadsheet and (for a pharmacy with no website) the service information PDF. Forward it to Worldpay, then set the status to “With Worldpay”.</p>
      <div className="wpa-grid">
        <label className="wpa-field"><span className="wpa-field__label">To</span><input className="input" value={content.recipients.to.join(', ')} onChange={event => set('recipients', { ...content.recipients, to: list(event.target.value) })} /></label>
        <label className="wpa-field"><span className="wpa-field__label">Cc</span><input className="input" value={content.recipients.cc.join(', ')} onChange={event => set('recipients', { ...content.recipients, cc: list(event.target.value) })} /></label>
      </div>
      {saveButton('recipients', 'Recipients')}

      <h4>Service information PDF</h4>
      <p className="wpa-muted">Attached to WP-01 when the pharmacy has no website of its own, whose application gives holistichealthhub.live as the website. Until one is uploaded, those applications wait in this list with Resend.</p>
      <div className="wpa-inline">
        <span>{content.servicePdf ? `${content.servicePdf.filename} · uploaded ${day(content.servicePdf.uploadedAt)}` : 'None uploaded'}</span>
        {content.servicePdf ? <button type="button" className="btn btn-sm" onClick={() => void openWorldpayServicePdf().then(openBlob).catch(cause => setError(message(cause, 'The PDF could not be opened.')))}>Open</button> : null}
        <label className="btn btn-sm">
          {busy === 'servicePdf' ? 'Uploading…' : content.servicePdf ? 'Replace PDF' : 'Upload PDF'}
          <input type="file" accept="application/pdf" hidden onChange={event => { void upload(event.target.files?.[0]); event.target.value = ''; }} />
        </label>
      </div>

      <h4>WP-01 — application to Worldpay</h4>
      <p className="wpa-muted">The platform sends the pharmacy no email about its Worldpay application: Worldpay contact the pharmacy themselves.</p>
      <label className="wpa-field"><span className="wpa-field__label">Subject</span><input className="input" value={content.wp01.subject} onChange={event => set('wp01', { ...content.wp01, subject: event.target.value })} /></label>
      <label className="wpa-field"><span className="wpa-field__label">Body</span><textarea className="input" rows={12} value={content.wp01.body} onChange={event => set('wp01', { ...content.wp01, body: event.target.value })} /><span className="wpa-field__hint">{MERGE_HELP}</span></label>
      {saveButton('wp01', 'WP-01')}

      <h4>What it costs (Before you start)</h4>
      <div className="wpa-grid">
        {(['label', 'price', 'priceNote', 'pciLine', 'pciNote', 'footnote'] as const).map(field => (
          <label key={field} className="wpa-field">
            <span className="wpa-field__label">{{ label: 'Label', price: 'Price', priceNote: 'Under the price', pciLine: 'PCI line', pciNote: 'PCI explanation', footnote: 'Footnote' }[field]}</span>
            <textarea className="input" rows={2} value={content.pricingPanel[field]} onChange={event => set('pricingPanel', { ...content.pricingPanel, [field]: event.target.value })} />
          </label>
        ))}
        <label className="wpa-field">
          <span className="wpa-field__label">Ticks (one per line)</span>
          <textarea className="input" rows={3} value={content.pricingPanel.ticks.join('\n')} onChange={event => set('pricingPanel', { ...content.pricingPanel, ticks: event.target.value.split('\n').map(line => line.trim()).filter(Boolean) })} />
        </label>
      </div>
      {saveButton('pricingPanel', 'Pricing panel')}

      <h4>Card scheme answers</h4>
      <p className="wpa-muted">The answers new applications start with. [B-09] is replaced by the pharmacy’s GPhC premises number. Applications already started keep their own answers.</p>
      {(['s01', 's02', 's03', 's04', 's05'] as const).map((key, index) => (
        <label key={key} className="wpa-field">
          <span className="wpa-field__label">S-0{index + 1}</span>
          <textarea className="input" rows={key === 's05' ? 6 : 3} value={content.schemeAnswers[key]} onChange={event => set('schemeAnswers', { ...content.schemeAnswers, [key]: event.target.value })} />
        </label>
      ))}
      {saveButton('schemeAnswers', 'Scheme answers')}

      <h4>Note under S-04</h4>
      <label className="wpa-field"><textarea className="input" rows={3} aria-label="Note under S-04" value={content.s04Note} onChange={event => set('s04Note', event.target.value)} /></label>
      {saveButton('s04Note', 'S-04 note')}
    </div>
  );
}
