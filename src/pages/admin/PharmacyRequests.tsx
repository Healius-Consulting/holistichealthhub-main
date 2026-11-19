import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, FileText } from 'lucide-react';
import {
  activatePharmacyOnboardingRequest,
  describeApiError,
  listPharmacyOnboardingRequests,
  openPharmacyOnboardingFile,
  type ActivatedPharmacyOnboarding,
  type PharmacyOnboardingRequestView,
} from '../../shared/api';
import { compactGphc, formatRequestDate, requestStatusLabel, requestTone } from './requestFormat';
import { isLocalPortalPreview } from '../../dev/localPortalPreview';
import { LOCAL_PREVIEW_PHARMACY_REQUESTS } from '../../dev/localPharmacyRequests';
import { OnboardingEmailLog } from './OnboardingEmailLog';
import { OnboardingHoldCard, OnboardingHoldPanel } from './OnboardingHold';
import { holdReasonLabel, sendableEmailKinds } from './onboardingAdmin';

/**
 * Pharmacy requests (Curaleaf account forms sent from the onboarding page) live
 * in the pharmacies overview. A request is not a pharmacy yet: HHH either
 * activates it (creating the pharmacy, after which the normal Manage options
 * apply) or puts it on hold with a reason. A hold can be lifted back to new.
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
  const [busy, setBusy] = useState<null | 'activate' | FileKind>(null);
  const [error, setError] = useState<string | null>(null);
  const [holding, setHolding] = useState(false);
  // Bumped after a hold change so the send log shows the new Hold email.
  const [emailsVersion, setEmailsVersion] = useState(0);
  const [preview, setPreview] = useState<{ url: string; kind: FileKind } | null>(null);
  const previewRef = useRef<string | null>(null);
  const tone = requestTone(request.status);
  const pending = request.status === 'pending';
  const onHold = request.status === 'on_hold';
  // The sign-up acceptance; re-acceptance rows (a later feature) come after it.
  const terms = request.termsAcceptances?.find(row => row.source === 'signup') ?? request.termsAcceptances?.[0] ?? null;
  const licenceIsPdf = request.licenceFilename.toLowerCase().endsWith('.pdf');

  // A different request starts clean: no open hold box or file from the last one.
  useEffect(() => {
    setHolding(false);
    setError(null);
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
    setPreview(null);
  }, [request.id]);

  useEffect(() => () => {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
  }, []);

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

  const holdChanged = (next: PharmacyOnboardingRequestView) => {
    setHolding(false);
    setEmailsVersion(version => version + 1);
    onChanged(next);
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
              <em>{onHold ? `On hold since ${formatRequestDate(request.heldAt ?? request.decidedAt)}` : 'Not on the platform yet'}</em>
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
              <button type="button" className="btn btn-sm admin-decline-button" disabled={busy !== null} aria-expanded={holding} onClick={() => setHolding(open => !open)}>Hold</button>
              <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void activate()}>
                {busy === 'activate' ? 'Activating…' : 'Activate'}
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <div className="patient-crm-detail__body pharmacy-dashboard">
        {error ? <div className="banner banner-amber" role="alert"><span>{error}</span></div> : null}

        {holding && pending ? (
          <OnboardingHoldPanel request={request} onCancel={() => setHolding(false)} onHeld={holdChanged} />
        ) : null}

        {onHold ? <OnboardingHoldCard request={request} onChanged={next => holdChanged(next)} /> : null}

        {pending ? (
          <p className="admin-request-next">
            Submitting the form does not create a pharmacy. <strong>Activate</strong> creates it in demonstration mode, where it waits for
            Curaleaf's live credentials like any other, and emails the pharmacy that its account is ready to try.
            {request.holdReason ? <> Previously on hold: <em>{holdReasonLabel(request.holdReason)}</em>{request.heldAt ? `, ${formatRequestDate(request.heldAt)}` : ''}.</> : null}
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

        <OnboardingEmailLog
          requestId={request.id}
          refreshKey={emailsVersion}
          sendable={sendableEmailKinds({ termsAccepted: Boolean(request.termsAcceptances?.length), requestStatus: request.status, activated: Boolean(request.organisationId), live: false })}
        />

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
