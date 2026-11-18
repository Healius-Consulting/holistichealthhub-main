import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, FileText } from 'lucide-react';
import {
  activatePharmacyOnboardingRequest,
  describeApiError,
  holdPharmacyOnboardingRequest,
  listPharmacyOnboardingRequests,
  openPharmacyOnboardingFile,
  unholdPharmacyOnboardingRequest,
  type ActivatedPharmacyOnboarding,
  type PharmacyOnboardingRequestView,
} from '../../shared/api';
import { compactGphc, formatRequestDate, requestStatusLabel, requestTone } from './requestFormat';
import { isLocalPortalPreview } from '../../dev/localPortalPreview';
import { LOCAL_PREVIEW_PHARMACY_REQUESTS } from '../../dev/localPharmacyRequests';

/**
 * Pharmacy requests (Curaleaf account forms sent from the onboarding page) live
 * in the pharmacies overview. A request is not a pharmacy yet: HHH either
 * activates it (creating the pharmacy, after which the normal Manage options
 * apply) or holds it. A held request can be unheld back to new.
 */

function initials(name: string) {
  const letters = name.split(/\s+/).map(part => part.replace(/[^A-Za-z0-9]/g, '').charAt(0)).filter(Boolean).join('');
  return (letters || 'RX').slice(0, 2).toUpperCase();
}

export function usePharmacyRequests(enabled: boolean) {
  const [records, setRecords] = useState<PharmacyOnboardingRequestView[]>([]);
  const [worldpay, setWorldpay] = useState<Map<string, string>>(new Map());
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (isLocalPortalPreview) {
      setRecords(LOCAL_PREVIEW_PHARMACY_REQUESTS);
      setWorldpay(new Map(LOCAL_PREVIEW_PHARMACY_REQUESTS
        .filter(record => record.worldpaySubmittedAt)
        .map(record => [compactGphc(record.gphcNumber), record.worldpaySubmittedAt as string])));
      setStatus('ready');
      return;
    }
    setStatus('loading');
    setError(null);
    try {
      const result = await listPharmacyOnboardingRequests();
      setRecords(result.records);
      const dates = new Map<string, string>();
      for (const note of result.worldpaySubmissions ?? []) {
        const key = compactGphc(note.gphcNumber);
        const current = dates.get(key);
        if (!current || note.submittedAt > current) dates.set(key, note.submittedAt);
      }
      setWorldpay(dates);
      setStatus('ready');
    } catch (cause) {
      setError(describeApiError(cause, 'Pharmacy requests could not be loaded.'));
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  const replace = useCallback((next: PharmacyOnboardingRequestView) => {
    setRecords(current => current.map(record => (record.id === next.id ? { ...record, ...next, worldpaySubmittedAt: record.worldpaySubmittedAt } : record)));
  }, []);

  const worldpayFor = useCallback((gphcNumber: string) => worldpay.get(compactGphc(gphcNumber)) ?? null, [worldpay]);
  const pending = useMemo(() => records.filter(record => record.status === 'pending'), [records]);
  const onHold = useMemo(() => records.filter(record => record.status === 'on_hold'), [records]);

  return { records, pending, onHold, status, error, reload: load, replace, worldpayFor };
}

export function PharmacyRequestRow({
  request,
  selected,
  worldpaySubmittedAt,
  onSelect,
}: {
  request: PharmacyOnboardingRequestView;
  selected: boolean;
  worldpaySubmittedAt: string | null;
  onSelect: () => void;
}) {
  const tone = requestTone(request.status);
  const worldpayLabel = worldpaySubmittedAt ? 'Worldpay form sent' : 'Worldpay form not sent';
  return (
    <button
      type="button"
      className={`order-crm-row order-crm-row--${tone} admin-request-row${selected ? ' selected' : ''}`}
      aria-pressed={selected}
      aria-label={`${request.pharmacyName}, ${requestStatusLabel(request.status)}, ${worldpayLabel}`}
      onClick={onSelect}
    >
      <span className={`order-crm-row__stage order-tone--${tone}`} aria-hidden="true">{initials(request.pharmacyName)}</span>
      <span className="order-crm-row__identity">
        <strong title={request.pharmacyName}>{request.pharmacyName}</strong>
        <span className={`order-stage-pill order-tone--${tone}`}>{requestStatusLabel(request.status)}</span>
        <span className={`order-stage-pill ${worldpaySubmittedAt ? 'order-tone--paid' : 'order-tone--neutral'}`}>{worldpayLabel}</span>
      </span>
      <span className="order-crm-row__position">
        <strong>{formatRequestDate(request.createdAt) || 'Received'}</strong>
        <small>GPhC {request.gphcNumber}</small>
      </span>
    </button>
  );
}

type FileKind = 'filled-form' | 'licence';

const SIGNER_ROLES: Record<string, string> = {
  SUPERINTENDENT_PHARMACIST: 'Superintendent pharmacist',
  PHARMACIST: 'Pharmacist',
  DIRECTOR: 'Director',
  PHARMACY_MANAGER: 'Pharmacy manager',
  OTHER: 'Other',
};

function signerRoleLabel(role: string) {
  return SIGNER_ROLES[role] ?? role;
}

export function PharmacyRequestRecord({
  request,
  worldpaySubmittedAt,
  onActivated,
  onChanged,
}: {
  request: PharmacyOnboardingRequestView;
  worldpaySubmittedAt: string | null;
  onActivated: (organisation: ActivatedPharmacyOnboarding, request: PharmacyOnboardingRequestView) => void;
  onChanged: (request: PharmacyOnboardingRequestView) => void;
}) {
  const [busy, setBusy] = useState<null | 'activate' | 'hold' | 'unhold' | FileKind>(null);
  const [error, setError] = useState<string | null>(null);
  const [holding, setHolding] = useState(false);
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<{ url: string; kind: FileKind } | null>(null);
  const previewRef = useRef<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const tone = requestTone(request.status);
  const pending = request.status === 'pending';
  const onHold = request.status === 'on_hold';
  // The sign-up acceptance; re-acceptance rows (a later feature) come after it.
  const terms = request.termsAcceptances?.find(row => row.source === 'signup') ?? request.termsAcceptances?.[0] ?? null;
  const licenceIsPdf = request.licenceFilename.toLowerCase().endsWith('.pdf');

  // A different request starts clean: no open hold box or file from the last one.
  useEffect(() => {
    setHolding(false);
    setReason('');
    setError(null);
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    setPreview(null);
  }, [request.id]);

  useEffect(() => () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
  }, []);

  useEffect(() => {
    if (holding) reasonRef.current?.focus();
  }, [holding]);

  const showFile = async (kind: FileKind) => {
    if (preview?.kind === kind) {
      setPreview(null);
      return;
    }
    setBusy(kind);
    setError(null);
    try {
      const url = await openPharmacyOnboardingFile(request.id, kind);
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = url;
      setPreview({ url, kind });
    } catch (cause) {
      setError(describeApiError(cause, 'The file could not be opened.'));
    } finally {
      setBusy(null);
    }
  };

  const activate = async () => {
    setBusy('activate');
    setError(null);
    try {
      const result = await activatePharmacyOnboardingRequest(request.id);
      onActivated(result.organisation, result.request);
    } catch (cause) {
      setError(describeApiError(cause, 'The pharmacy could not be activated.'));
      setBusy(null);
    }
  };

  const hold = async () => {
    const note = reason.trim();
    if (note.length < 2) {
      setError('Enter a reason for the hold. Only HHH admins see it.');
      reasonRef.current?.focus();
      return;
    }
    setBusy('hold');
    setError(null);
    try {
      const result = await holdPharmacyOnboardingRequest(request.id, note);
      onChanged(result.request);
      setHolding(false);
      setReason('');
    } catch (cause) {
      setError(describeApiError(cause, 'The request could not be put on hold.'));
    } finally {
      setBusy(null);
    }
  };

  const unhold = async () => {
    setBusy('unhold');
    setError(null);
    try {
      const result = await unholdPharmacyOnboardingRequest(request.id);
      onChanged(result.request);
    } catch (cause) {
      setError(describeApiError(cause, 'The request could not be unheld.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className={`order-crm-record order-crm-record--${tone} admin-request-record`} aria-labelledby="admin-request-title">
      <header className="order-crm-record__header">
        <div className="order-crm-record__hero">
          <div className="order-crm-record__identity">
            <span className={`order-crm-record__stage order-tone--${tone}`} aria-hidden="true">{initials(request.pharmacyName)}</span>
            <div className="order-crm-record__titles">
              <strong id="admin-request-title">{request.pharmacyName}</strong>
              <span className="order-crm-record__ref">{request.registeredCompanyName} · GPhC {request.gphcNumber}</span>
              <em>{onHold ? `On hold since ${formatRequestDate(request.decidedAt)}` : 'Not on the platform yet'}</em>
            </div>
          </div>
          <span className={`order-stage-pill order-tone--${tone}`}>{requestStatusLabel(request.status)}</span>
        </div>
        <div className="order-crm-record__toolbar">
          <div className="order-crm-record__value">
            <small>Received</small>
            <strong>{formatRequestDate(request.createdAt) || 'Unknown'}</strong>
            <span className="order-crm-record__opened">Signed by {request.signatureName} on {formatRequestDate(request.signedOn) || request.signedOn}</span>
          </div>
          {pending ? (
            <div className="order-crm-record__actions" role="group" aria-label="Request actions">
              <button type="button" className="btn btn-sm" disabled={busy !== null} aria-expanded={holding} onClick={() => setHolding(open => !open)}>Hold</button>
              <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void activate()}>
                {busy === 'activate' ? 'Activating…' : 'Activate'}
              </button>
            </div>
          ) : null}
          {onHold ? (
            <div className="order-crm-record__actions" role="group" aria-label="Request actions">
              <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void unhold()}>
                {busy === 'unhold' ? 'Unholding…' : 'Unhold'}
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <div className="patient-crm-detail__body pharmacy-dashboard">
        {error ? <div className="banner banner-amber" role="alert"><span>{error}</span></div> : null}

        {holding && pending ? (
          <section className="admin-request-decline" aria-labelledby="admin-request-hold-title">
            <h3 id="admin-request-hold-title">Put this request on hold</h3>
            <p>
              Only HHH admins see this reason. <strong>{request.pharmacyEmail}</strong> is emailed that the account could not be
              created at this point and to contact onboarding@holistichealthhub.live. No workspace is created.
            </p>
            <textarea ref={reasonRef} className="input" rows={3} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} aria-label="Reason for the hold (admin only)" />
            <div className="admin-request-decline__actions">
              <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => { setHolding(false); setReason(''); }}>Cancel</button>
              <button type="button" className="btn btn-sm btn-danger" disabled={busy !== null || reason.trim().length < 2} onClick={() => void hold()}>
                {busy === 'hold' ? 'Holding…' : 'Hold request'}
              </button>
            </div>
          </section>
        ) : null}

        {onHold ? (
          <section className="admin-activation admin-activation--stopped" aria-labelledby="admin-request-on-hold">
            <header>
              <span className="admin-activation__icon" aria-hidden="true"><AlertCircle size={18} /></span>
              <span>
                <small>On hold since {formatRequestDate(request.decidedAt)}</small>
                <strong id="admin-request-on-hold">Not activated</strong>
              </span>
            </header>
            {request.declineReason ? <blockquote className="admin-request-quote">{request.declineReason}</blockquote> : null}
            <p className="admin-activation__body">
              Only HHH admins see this reason. The pharmacy was told its account could not be created yet, and a new Curaleaf
              form for GPhC {request.gphcNumber} is refused. <strong>Unhold</strong> moves it back to a new request without emailing the pharmacy.
            </p>
          </section>
        ) : null}

        {pending ? (
          <p className="admin-request-next">
            Submitting the form does not create a pharmacy. <strong>Activate</strong> creates it in onboarding, where it waits for Curaleaf's
            live credentials like any other, and emails the pharmacy that its account is active.
            {request.declineReason ? <> Previously held: <em>{request.declineReason}</em></> : null}
          </p>
        ) : null}

        <section className="pharmacy-summary__card" aria-labelledby="admin-request-forms">
          <header><h3 id="admin-request-forms">Forms</h3></header>
          <ul>
            <li className="pharmacy-summary__row">
              <span className="pharmacy-summary__label">Curaleaf account</span>
              <span className="pharmacy-summary__value">
                <span className="pharmacy-summary__state is-ok">Received</span>
                <small>{formatRequestDate(request.createdAt)} · signed by {request.signatureName}</small>
              </span>
              <button type="button" className="btn btn-sm" disabled={busy !== null} aria-pressed={preview?.kind === 'filled-form'} onClick={() => void showFile('filled-form')}>
                <FileText size={13} /> {preview?.kind === 'filled-form' ? 'Hide form' : busy === 'filled-form' ? 'Opening…' : 'View form'}
              </button>
            </li>
            <li className="pharmacy-summary__row">
              <span className="pharmacy-summary__label">Partner Terms</span>
              <span className="pharmacy-summary__value">
                <span className={`pharmacy-summary__state ${terms ? (terms.nameMatchesPharmsmart === false ? 'is-wait' : 'is-ok') : 'is-off'}`}>
                  {terms ? (terms.nameMatchesPharmsmart === false ? 'Accepted, name differs' : 'Accepted') : 'Not accepted'}
                </span>
                <small>{terms
                  ? `${formatRequestDate(terms.acceptedAt)} · signed by ${terms.signerName} · version ${terms.termsVersion}`
                  : 'The Curaleaf form is not sent to Curaleaf until the pharmacy accepts'}</small>
              </span>
              <span aria-hidden="true" />
            </li>
            <li className="pharmacy-summary__row">
              <span className="pharmacy-summary__label">Worldpay</span>
              <span className="pharmacy-summary__value">
                <span className={`pharmacy-summary__state ${worldpaySubmittedAt ? 'is-ok' : 'is-off'}`}>{worldpaySubmittedAt ? 'Sent' : 'Not sent'}</span>
                <small>{worldpaySubmittedAt ? `${formatRequestDate(worldpaySubmittedAt)} · emailed as a PDF, not stored` : 'Sent by the pharmacy from the onboarding page'}</small>
              </span>
              <span aria-hidden="true" />
            </li>
            <li className="pharmacy-summary__row">
              <span className="pharmacy-summary__label">CD licence</span>
              <span className="pharmacy-summary__value">
                <span className={`pharmacy-summary__state ${request.licenceFilename ? 'is-ok' : 'is-off'}`}>{request.licenceFilename ? 'Uploaded' : 'Not given'}</span>
                <small>{request.licenceFilename || 'Optional on the form'}</small>
              </span>
              {request.licenceFilename ? (
                <button type="button" className="btn btn-sm" disabled={busy !== null} aria-pressed={preview?.kind === 'licence'} onClick={() => void showFile('licence')}>
                  <FileText size={13} /> {preview?.kind === 'licence' ? 'Hide licence' : 'View licence'}
                </button>
              ) : <span aria-hidden="true" />}
            </li>
          </ul>
          {preview?.kind === 'filled-form' || (preview?.kind === 'licence' && licenceIsPdf) ? (
            <iframe className="admin-request-preview" title={preview.kind === 'licence' ? 'Controlled drugs licence' : 'Filled Curaleaf account form'} src={preview.url} />
          ) : null}
          {preview?.kind === 'licence' && !licenceIsPdf ? <img className="admin-request-preview" alt="Controlled drugs licence" src={preview.url} /> : null}
        </section>

        {terms ? (
          <section className="pharmacy-summary__card" aria-labelledby="admin-request-terms">
            <header><h3 id="admin-request-terms">Partner Terms acceptance</h3></header>
            {terms.nameMatchesPharmsmart === false ? (
              <p className="banner banner-amber" role="status">
                <AlertCircle size={14} aria-hidden="true" /> The signer's name does not match the superintendent or manager PharmSmart holds for this pharmacy. Check they can accept for {terms.registeredCompanyName} before activating.
              </p>
            ) : null}
            <dl className="admin-request-details">
              {([
                ['Signed by', terms.signerName],
                ['Role', signerRoleLabel(terms.signerRole)],
                ['Email', terms.signerEmail],
                ...(terms.signerGphcNumber ? [['GPhC registration', terms.signerGphcNumber] as [string, string]] : []),
                ['On behalf of', terms.registeredCompanyName],
                ['Accepted', formatRequestDate(terms.acceptedAt) || terms.acceptedAt],
                ['Terms version', terms.termsVersion],
                ['Name check', terms.nameMatchesPharmsmart === null ? 'Not checked (no PharmSmart names)' : terms.nameMatchesPharmsmart ? 'Matches PharmSmart' : 'Does not match PharmSmart'],
              ] as Array<[string, string]>).map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}

        <section className="pharmacy-summary__card" aria-labelledby="admin-request-details">
          <header><h3 id="admin-request-details">Application details</h3></header>
          <dl className="admin-request-details">
            {([
              ['Pharmacy name', request.pharmacyName],
              ['Company name', request.registeredCompanyName],
              ['GPhC number', request.gphcNumber],
              ['Pharmacist / contact', request.pharmacistName],
              ['Pharmacy email', request.pharmacyEmail],
              ['Pharmacy phone', request.pharmacyPhone],
              ['Accounts email', request.accountsEmail],
              ['Accounts phone', request.accountsPhone],
              ...(request.faxNumber ? [['Fax', request.faxNumber] as [string, string]] : []),
              ['Delivery address', request.deliveryAddress],
              ['Invoice address', request.invoiceAddress],
            ] as Array<[string, string]>).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
    </article>
  );
}
