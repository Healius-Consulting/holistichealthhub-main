import { useEffect, useRef, useState } from 'react';
import {
  activatePharmacyOnboardingRequest,
  declinePharmacyOnboardingRequest,
  describeApiError,
  listPharmacyOnboardingRequests,
  openPharmacyOnboardingFile,
  type PharmacyOnboardingRequestView,
} from '../shared/api';

type Filter = 'pending' | 'activated' | 'declined' | 'all';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'pending', label: 'Waiting' },
  { id: 'activated', label: 'Activated' },
  { id: 'declined', label: 'Declined' },
  { id: 'all', label: 'All' },
];

function statusLabel(status: PharmacyOnboardingRequestView['status']) {
  if (status === 'activated') return 'Activated';
  if (status === 'declined') return 'Declined';
  return 'Waiting';
}

function statusPill(status: PharmacyOnboardingRequestView['status']) {
  if (status === 'activated') return 'pill-green';
  if (status === 'declined') return 'pill-red';
  return 'pill-amber';
}

export function PharmacyOnboardingRequests({
  onActivated,
  onPendingCount,
}: {
  onActivated: (organisation: {
    id: string;
    referralToken: string;
    name: string;
    tradingName: string;
    logoText: string;
    gphcNumber: string;
    superintendent: string;
    mainContactName: string;
    mainContactPhone: string;
    mainContactEmail: string;
    pharmacyPhone: string;
    pharmacyEmail: string;
    address: string;
    primaryColour: string;
  }) => void;
  onPendingCount: (count: number) => void;
}) {
  const [records, setRecords] = useState<PharmacyOnboardingRequestView[]>([]);
  const [filter, setFilter] = useState<Filter>('pending');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [declining, setDeclining] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewKind, setPreviewKind] = useState<'form' | 'licence' | null>(null);
  const previewRef = useRef<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await listPharmacyOnboardingRequests();
      setRecords(result.records);
      onPendingCount(result.records.filter(record => record.status === 'pending').length);
    } catch (cause) {
      setError(describeApiError(cause, 'Pharmacy requests could not be loaded.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    return () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
    // The list is loaded once when the page opens. Actions call load() again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = records.filter(record => filter === 'all' || record.status === filter);
  const selected = records.find(record => record.id === selectedId) ?? null;

  const replace = (next: PharmacyOnboardingRequestView) => {
    setRecords(current => {
      const updated = current.map(record => record.id === next.id ? next : record);
      onPendingCount(updated.filter(record => record.status === 'pending').length);
      return updated;
    });
  };

  const showFile = async (kind: 'filled-form' | 'licence') => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const url = await openPharmacyOnboardingFile(selected.id, kind);
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = url;
      setPreviewUrl(url);
      setPreviewKind(kind === 'filled-form' ? 'form' : 'licence');
    } catch (cause) {
      setError(describeApiError(cause, 'The file could not be opened.'));
    } finally {
      setBusy(false);
    }
  };

  const activate = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      const result = await activatePharmacyOnboardingRequest(selected.id);
      replace(result.request);
      onActivated(result.organisation);
    } catch (cause) {
      setError(describeApiError(cause, 'The pharmacy could not be activated.'));
    } finally {
      setBusy(false);
    }
  };

  const decline = async () => {
    if (!selected) return;
    const note = reason.trim();
    if (note.length < 2) {
      setError('Enter a reason the pharmacy can read.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await declinePharmacyOnboardingRequest(selected.id, note);
      replace(result.request);
      setDeclining(false);
      setReason('');
    } catch (cause) {
      setError(describeApiError(cause, 'The request could not be declined.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card admin-referral-section">
      <div className="admin-directory-head">
        <div>
          <p className="section-label">Curaleaf account</p>
          <h2>Pharmacy requests</h2>
          <p>A pharmacy submitted the account form from the onboarding page. Activate creates a training workspace. Decline emails the pharmacy.</p>
        </div>
      </div>
      <div className="pharmacy-request-filters" role="tablist" aria-label="Request status">
        {FILTERS.map(item => (
          <button key={item.id} type="button" className={`btn btn-sm${filter === item.id ? ' btn-primary' : ''}`} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>
        ))}
      </div>
      {error ? <p className="curaleaf-account-form__error" role="alert">{error}</p> : null}
      {loading ? <p className="empty-state">Loading pharmacy requests…</p> : null}
      {!loading && !visible.length ? <div className="empty-state">No pharmacy requests in this list.</div> : null}
      <div className="pharmacy-request-list">
        {visible.map(record => (
          <button
            key={record.id}
            type="button"
            className={`pharmacy-request${selectedId === record.id ? ' is-selected' : ''}`}
            aria-pressed={selectedId === record.id}
            onClick={() => {
              setSelectedId(record.id);
              setDeclining(false);
              setReason('');
              if (previewRef.current) URL.revokeObjectURL(previewRef.current);
              previewRef.current = null;
              setPreviewUrl(null);
              setPreviewKind(null);
            }}
          >
            <span className="pharmacy-request__title">
              <strong>{record.pharmacyName}</strong>
              <span className={`pill ${statusPill(record.status)}`}>{statusLabel(record.status)}</span>
            </span>
            <span className="pharmacy-request__meta">
              <span>GPhC {record.gphcNumber}</span>
              <span>{record.pharmacyEmail}</span>
              {record.createdAt ? <span>{new Date(record.createdAt).toLocaleDateString('en-GB')}</span> : null}
            </span>
          </button>
        ))}
      </div>
      {selected ? (
        <article className="pharmacy-request-detail" aria-labelledby="pharmacy-request-detail-title">
          <h3 id="pharmacy-request-detail-title">{selected.pharmacyName}</h3>
          <dl>
            <dt>Pharmacist</dt><dd>{selected.pharmacistName}</dd>
            <dt>Company</dt><dd>{selected.registeredCompanyName}</dd>
            <dt>GPhC</dt><dd>{selected.gphcNumber}</dd>
            {selected.wdaNumber ? <><dt>WDA</dt><dd>{selected.wdaNumber}</dd></> : null}
            {selected.licenceDetails ? <><dt>Licence details</dt><dd>{selected.licenceDetails}</dd></> : null}
            <dt>Invoice address</dt><dd>{selected.invoiceAddress}</dd>
            <dt>Delivery address</dt><dd>{selected.deliveryAddress}</dd>
            <dt>Pharmacy email</dt><dd>{selected.pharmacyEmail}</dd>
            <dt>Accounts email</dt><dd>{selected.accountsEmail}</dd>
            <dt>Pharmacy telephone</dt><dd>{selected.pharmacyPhone}</dd>
            <dt>Accounts telephone</dt><dd>{selected.accountsPhone}</dd>
            <dt>Fax</dt><dd>{selected.faxNumber || 'Not given'}</dd>
            <dt>Signature</dt><dd>{selected.signatureName} · {selected.signedOn}</dd>
            {selected.declineReason ? <><dt>Decline reason</dt><dd>{selected.declineReason}</dd></> : null}
          </dl>
          <div className="pharmacy-request-actions">
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void showFile('filled-form')}>View filled form</button>
            {selected.licenceFilename ? <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void showFile('licence')}>View licence</button> : null}
            {selected.status === 'pending' ? (
              <>
                <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void activate()}>Activate pharmacy</button>
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setDeclining(open => !open)}>Decline</button>
              </>
            ) : null}
          </div>
          {declining && selected.status === 'pending' ? (
            <label>Reason the pharmacy will be emailed
              <textarea className="input" rows={3} value={reason} onChange={event => setReason(event.target.value)} />
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void decline()}>Send decline</button>
            </label>
          ) : null}
          {previewUrl && previewKind === 'form' ? <iframe className="pharmacy-request-preview" title="Filled Curaleaf account form" src={previewUrl} /> : null}
          {previewUrl && previewKind === 'licence' && selected.licenceFilename.toLowerCase().endsWith('.pdf') ? <iframe className="pharmacy-request-preview" title="Controlled drug licence" src={previewUrl} /> : null}
          {previewUrl && previewKind === 'licence' && !selected.licenceFilename.toLowerCase().endsWith('.pdf') ? <img className="pharmacy-request-preview" alt="Controlled drug licence" src={previewUrl} /> : null}
        </article>
      ) : null}
    </section>
  );
}
