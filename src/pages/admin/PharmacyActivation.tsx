import { useEffect, useRef, useState } from 'react';
import { Check, FileText, KeyRound } from 'lucide-react';
import {
  declineNewPharmacy,
  describeApiError,
  liftPharmacySuspension,
  suspendPharmacy,
  markPharmacyNotAvailable,
  clearPharmacyNotAvailable,
  openPharmacyOnboardingFile,
  type PharmacyOnboardingRequestView,
} from '../../shared/api';
import { isLocalPortalPreview } from '../../dev/localPortalPreview';
import { formatRequestDate } from './requestFormat';

/**
 * Every pharmacy is created as soon as its Curaleaf form arrives. The one step
 * left to activate it is entering the PHAR code and API key Curaleaf send HHH.
 */

type FileKind = 'filled-form' | 'licence';

function Step({ done, title, detail, children }: { done: boolean; title: string; detail: string; children?: React.ReactNode }) {
  return (
    <li className={done ? 'is-done' : 'is-next'}>
      <span className="admin-activation__mark" aria-hidden="true">{done ? <Check size={13} strokeWidth={3} /> : null}</span>
      <span className="admin-activation__text">
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      {children ? <span className="admin-activation__step-actions">{children}</span> : null}
    </li>
  );
}

export function ActivationChecklist({
  pharmacyName,
  request,
  worldpaySubmittedAt,
  curaleafEnvironment,
  curaleafCode,
  onEnterCredentials,
}: {
  pharmacyName: string;
  request: PharmacyOnboardingRequestView | null;
  worldpaySubmittedAt: string | null;
  curaleafEnvironment: 'test' | 'production' | null;
  curaleafCode: string | null;
  onEnterCredentials: () => void;
}) {
  const onTest = Boolean(curaleafCode) && curaleafEnvironment !== 'production';
  const [preview, setPreview] = useState<{ url: string; kind: FileKind } | null>(null);
  const [busy, setBusy] = useState<FileKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previewRef = useRef<string | null>(null);

  useEffect(() => {
    setPreview(null);
    setError(null);
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = null;
  }, [request?.id]);
  useEffect(() => () => { if (previewRef.current) URL.revokeObjectURL(previewRef.current); }, []);

  const showFile = async (kind: FileKind) => {
    if (!request) return;
    if (preview?.kind === kind) { setPreview(null); return; }
    if (isLocalPortalPreview) { setError('Files open on the live portal only.'); return; }
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

  const licenceIsPdf = request?.licenceFilename.toLowerCase().endsWith('.pdf') ?? false;

  return (
    <section className="admin-activation" aria-labelledby="admin-activation-title">
      <header>
        <span className="admin-activation__icon" aria-hidden="true"><KeyRound size={18} /></span>
        <span>
          <small>One step to activate</small>
          <strong id="admin-activation-title">Waiting on Curaleaf for {pharmacyName}</strong>
        </span>
        <button type="button" className="btn btn-primary btn-sm" onClick={onEnterCredentials}>{onTest ? 'Add live credentials' : 'Enter PHAR code and API key'}</button>
      </header>
      <ol>
        <Step
          done={Boolean(request)}
          title="Curaleaf account form"
          detail={request ? `Received ${formatRequestDate(request.createdAt)} · signed by ${request.signatureName}` : 'Added by HHH, no form on file'}
        >
          {request ? (
            <>
              <button type="button" className="btn btn-sm" aria-pressed={preview?.kind === 'filled-form'} disabled={busy !== null} onClick={() => void showFile('filled-form')}>
                <FileText size={13} /> {preview?.kind === 'filled-form' ? 'Hide form' : 'View form'}
              </button>
              {request.licenceFilename ? (
                <button type="button" className="btn btn-sm" aria-pressed={preview?.kind === 'licence'} disabled={busy !== null} onClick={() => void showFile('licence')}>
                  <FileText size={13} /> {preview?.kind === 'licence' ? 'Hide licence' : 'Licence'}
                </button>
              ) : null}
            </>
          ) : null}
        </Step>
        <Step
          done={Boolean(worldpaySubmittedAt)}
          title="Worldpay form"
          detail={worldpaySubmittedAt ? `Sent ${formatRequestDate(worldpaySubmittedAt)} · emailed as a PDF, not stored` : 'Not sent yet. Card payments wait for it, activation does not.'}
        />
        <Step
          done={false}
          title="Live PHAR code and API key"
          detail={onTest
            ? `Connected to Curaleaf's test estate (${curaleafCode}). Test credentials do not activate a pharmacy: enter the live ones Curaleaf send.`
            : 'Curaleaf send these to Shaylen once they approve the account. Saving live credentials takes the pharmacy live and opens ordering and payments; its eligibility link is already on.'}
        />
      </ol>
      {error ? <p className="admin-activation__error" role="alert">{error}</p> : null}
      {preview && (preview.kind === 'filled-form' || licenceIsPdf) ? (
        <iframe className="admin-request-preview" title={preview.kind === 'licence' ? 'Controlled drugs licence' : 'Filled Curaleaf account form'} src={preview.url} />
      ) : null}
      {preview?.kind === 'licence' && !licenceIsPdf ? <img className="admin-request-preview" alt="Controlled drugs licence" src={preview.url} /> : null}
    </section>
  );
}

export function DeclinePharmacyPanel({
  organisationId,
  pharmacyName,
  email,
  onCancel,
  onDeclined,
}: {
  organisationId: string;
  pharmacyName: string;
  email: string | null;
  onCancel: () => void;
  onDeclined: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { reasonRef.current?.focus(); }, []);

  const submit = async () => {
    const note = reason.trim();
    if (note.length < 2) {
      setError('Enter a reason the pharmacy can read.');
      reasonRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (!isLocalPortalPreview) await declineNewPharmacy(organisationId, note);
      onDeclined();
    } catch (cause) {
      setError(describeApiError(cause, 'The pharmacy could not be rejected.'));
      setBusy(false);
    }
  };

  return (
    <section className="admin-request-decline" aria-labelledby="admin-decline-title">
      <h3 id="admin-decline-title">Reject {pharmacyName}</h3>
      <p>
        Use this when Curaleaf reject the account. The pharmacy is removed from the overview, its staff can no longer sign in,
        and {email ? <>this reason is emailed to <strong>{email}</strong></> : 'the reason is recorded'}. Its records are kept.
      </p>
      <textarea ref={reasonRef} className="input" rows={3} value={reason} onChange={event => setReason(event.target.value)} aria-label="Reason the pharmacy will be emailed" placeholder="For example: Curaleaf could not open an account for this pharmacy." />
      {error ? <p className="admin-activation__error" role="alert">{error}</p> : null}
      <div className="admin-request-decline__actions">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void submit()}>{busy ? 'Rejecting…' : 'Reject pharmacy'}</button>
      </div>
    </section>
  );
}

/**
 * Suspend stops a live pharmacy using the platform until HHH lifts it: staff are
 * signed out and refused, the eligibility link stops taking patients and the
 * pharmacy leaves the finder. Records are kept and payments in flight still settle.
 */
export function SuspendPharmacyPanel({
  organisationId,
  pharmacyName,
  suspended,
  onCancel,
  onDone,
}: {
  organisationId: string;
  pharmacyName: string;
  suspended: boolean;
  onCancel: () => void;
  onDone: (status: 'paused' | 'live' | 'onboarding') => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { reasonRef.current?.focus(); }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (suspended) {
        const result = isLocalPortalPreview ? { status: 'live' as const } : await liftPharmacySuspension(organisationId);
        onDone(result.status);
      } else {
        if (!isLocalPortalPreview) await suspendPharmacy(organisationId, reason.trim() || undefined);
        onDone('paused');
      }
    } catch (cause) {
      setError(describeApiError(cause, suspended ? 'The suspension could not be lifted.' : 'The pharmacy could not be suspended.'));
      setBusy(false);
    }
  };

  return (
    <section className="admin-request-decline" aria-labelledby="admin-suspend-title">
      <h3 id="admin-suspend-title">{suspended ? `Lift the suspension on ${pharmacyName}` : `Suspend ${pharmacyName}`}</h3>
      {suspended ? (
        <p>
          Staff can sign in again and the eligibility link takes patients again. The pharmacy goes back to live if its live
          Curaleaf credentials are still saved, otherwise it waits for them.
        </p>
      ) : (
        <>
          <p>
            Its staff are signed out and cannot sign in, its eligibility link stops taking patients and it leaves the pharmacy
            finder. Its records are kept and payments already in progress still complete. You can lift this at any time.
          </p>
          <textarea ref={reasonRef} className="input" rows={2} value={reason} onChange={event => setReason(event.target.value)} aria-label="Reason for suspending, kept in the audit log" placeholder="Reason, kept in the audit log (optional)" />
        </>
      )}
      {error ? <p className="admin-activation__error" role="alert">{error}</p> : null}
      <div className="admin-request-decline__actions">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className={`btn btn-sm ${suspended ? 'btn-primary' : 'btn-danger'}`} disabled={busy} onClick={() => void submit()}>
          {busy ? (suspended ? 'Lifting…' : 'Suspending…') : (suspended ? 'Lift suspension' : 'Suspend pharmacy')}
        </button>
      </div>
    </section>
  );
}

/**
 * Not available: the pharmacy is an existing Curaleaf customer (Curaleaf say so by
 * replying to the application). Its staff are signed out and see "may be available to
 * you in the near future", and its eligibility link goes off. HHH can clear it.
 */
export function NotAvailablePanel({
  organisationId,
  pharmacyName,
  notAvailable,
  onCancel,
  onDone,
}: {
  organisationId: string;
  pharmacyName: string;
  notAvailable: boolean;
  onCancel: () => void;
  onDone: (status: 'not_available' | 'live' | 'onboarding') => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { reasonRef.current?.focus(); }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (notAvailable) {
        const result = isLocalPortalPreview ? { status: 'onboarding' as const } : await clearPharmacyNotAvailable(organisationId);
        onDone(result.status === 'live' ? 'live' : 'onboarding');
      } else {
        if (!isLocalPortalPreview) await markPharmacyNotAvailable(organisationId, reason.trim() || undefined);
        onDone('not_available');
      }
    } catch (cause) {
      setError(describeApiError(cause, notAvailable ? 'Not available could not be cleared.' : 'The pharmacy could not be marked Not available.'));
      setBusy(false);
    }
  };

  return (
    <section className="admin-request-decline" aria-labelledby="admin-not-available-title">
      <h3 id="admin-not-available-title">{notAvailable ? `Clear Not available on ${pharmacyName}` : `Mark ${pharmacyName} Not available`}</h3>
      {notAvailable ? (
        <p>
          Staff can sign in again and the eligibility link takes patients again. The pharmacy goes back to awaiting Curaleaf,
          or to live if its live Curaleaf credentials are saved.
        </p>
      ) : (
        <>
          <p>
            For a pharmacy that is already a Curaleaf customer. Its staff are signed out and, when they sign in, see that the
            service may be available to them in the near future. Its eligibility link stops taking patients. You can clear this
            at any time.
          </p>
          <textarea ref={reasonRef} className="input" rows={2} value={reason} onChange={event => setReason(event.target.value)} aria-label="Note, kept in the audit log" placeholder="Note, kept in the audit log (optional)" />
        </>
      )}
      {error ? <p className="admin-activation__error" role="alert">{error}</p> : null}
      <div className="admin-request-decline__actions">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="button" className={`btn btn-sm ${notAvailable ? 'btn-primary' : 'btn-danger'}`} disabled={busy} onClick={() => void submit()}>
          {busy ? 'Saving…' : notAvailable ? 'Clear Not available' : 'Mark Not available'}
        </button>
      </div>
    </section>
  );
}
