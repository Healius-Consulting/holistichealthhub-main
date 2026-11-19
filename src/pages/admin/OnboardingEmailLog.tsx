import { useCallback, useEffect, useId, useState } from 'react';
import { AlertCircle, Mail } from 'lucide-react';
import {
  describeApiError,
  listOnboardingEmails,
  resendOnboardingEmail,
  type OnboardingEmailKind,
  type OnboardingEmailLogEntry,
} from '../../shared/api';
import { isLocalPortalPreview } from '../../dev/localPortalPreview';
import { LOCAL_PREVIEW_ONBOARDING_EMAILS } from '../../dev/localPharmacyRequests';
import { emailEntryTime, emailStatusLabel, emailStatusTone, failedEmailKinds, summariseEmailLog, type EmailLogRow } from './onboardingAdmin';
import '../../styles/onboarding-admin.css';

/**
 * The send log on a request or branch record: every partner onboarding email,
 * with its status and a Resend for each kind. Failed sends stand out; a failed
 * send never blocked the change that triggered it, so admin resends it from here.
 */

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function detail(entry: OnboardingEmailLogEntry) {
  const time = when(emailEntryTime(entry));
  const to = entry.recipients.length ? ` · to ${entry.recipients.join(', ')}` : '';
  if (entry.status === 'FAILED') return `Failed ${time}${entry.failureCode ? ` (${entry.failureCode})` : ''}${to}`;
  if (entry.status === 'PENDING') return `Queued ${time}${to}`;
  return `${time}${to}`;
}

export function OnboardingEmailLog({ requestId, refreshKey = 0, sendable = [] }: {
  requestId: string;
  refreshKey?: number;
  /** Kinds that apply now (sendableEmailKinds): one never sent gets a Send button. */
  sendable?: OnboardingEmailKind[];
}) {
  const titleId = useId();
  const [entries, setEntries] = useState<OnboardingEmailLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<OnboardingEmailKind | null>(null);
  const [busy, setBusy] = useState<OnboardingEmailKind | null>(null);

  const load = useCallback(async () => {
    setError(null);
    if (isLocalPortalPreview) {
      setEntries(LOCAL_PREVIEW_ONBOARDING_EMAILS[requestId] ?? []);
      return;
    }
    try {
      setEntries((await listOnboardingEmails(requestId)).entries);
    } catch (cause) {
      setError(describeApiError(cause, 'The email log could not be loaded.'));
    }
  }, [requestId]);

  useEffect(() => {
    setEntries(null);
    setNotice(null);
    setConfirming(null);
    void load();
  }, [load, refreshKey]);

  const resend = async (row: EmailLogRow) => {
    setBusy(row.kind);
    setError(null);
    setNotice(null);
    try {
      if (isLocalPortalPreview) {
        const now = new Date().toISOString();
        const recipients = row.latest?.recipients ?? [];
        setEntries(current => [{ id: `preview-${now}`, kind: row.kind, recipients, status: 'PENDING', queuedAt: now, sentAt: null, failedAt: null, failureCode: null }, ...(current ?? [])]);
      } else {
        setEntries((await resendOnboardingEmail(requestId, row.kind)).entries);
      }
      setNotice(`${row.label} queued to send${row.latest ? ' again' : ''}.`);
    } catch (cause) {
      setError(describeApiError(cause, `${row.label} could not be sent again.`));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  const rows = entries ? summariseEmailLog(entries) : [];
  const failed = failedEmailKinds(rows).length;

  return (
    <section className="pharmacy-summary__card onb-email-log" aria-labelledby={titleId}>
      <header>
        <h3 id={titleId}>Onboarding emails</h3>
        {failed ? <span className="onb-email-log__failed-count">{failed} failed</span> : null}
      </header>
      {failed ? (
        <p className="onb-email-log__alert" role="status">
          <AlertCircle size={14} aria-hidden="true" /> {failed === 1 ? 'An email' : `${failed} emails`} did not send. The pharmacy's status was still updated. Resend below.
        </p>
      ) : null}
      {notice ? <p className="onb-email-log__notice" role="status">{notice}</p> : null}
      {error ? (
        <p className="onb-email-log__alert" role="alert">
          <AlertCircle size={14} aria-hidden="true" /> {error}
          {!entries ? <button type="button" className="btn btn-sm" onClick={() => void load()}>Try again</button> : null}
        </p>
      ) : null}
      {!entries ? (error ? null : <p className="onb-email-log__muted">Loading…</p>) : (
        <ul>
          {rows.map(row => {
            const status = row.latest?.status ?? null;
            const earlier = row.history.slice(1);
            return (
              <li key={row.kind} className={`pharmacy-summary__row onb-email-log__row${row.failed ? ' is-failed' : ''}`}>
                <span className="pharmacy-summary__label"><Mail size={13} aria-hidden="true" /> {row.label}</span>
                <span className="pharmacy-summary__value">
                  <span className={`pharmacy-summary__state is-${emailStatusTone(status)}`}>{emailStatusLabel(status)}</span>
                  <small>{row.latest ? detail(row.latest) : row.kind === 'curaleafApplication' ? 'Sent to Curaleaf when the pharmacy accepts the Partner Terms' : 'Not sent yet'}</small>
                  {earlier.length ? (
                    <details className="onb-email-log__history">
                      <summary>{earlier.length} earlier send{earlier.length === 1 ? '' : 's'}</summary>
                      <ul>
                        {earlier.map(entry => (
                          <li key={entry.id}><span className={`pharmacy-summary__state is-${emailStatusTone(entry.status)}`}>{emailStatusLabel(entry.status)}</span> <small>{detail(entry)}</small></li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {confirming === row.kind ? (
                    <span className="onb-email-log__confirm">
                      <span>Send the {row.label} email{row.latest ? ' again' : ''}{row.latest?.recipients.length ? ` to ${row.latest.recipients.join(', ')}` : ''}? It uses the current wording.</span>
                      <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => setConfirming(null)}>Cancel</button>
                      <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => void resend(row)}>{busy === row.kind ? 'Sending…' : 'Yes, resend'}</button>
                    </span>
                  ) : null}
                </span>
                {(row.latest || sendable.includes(row.kind)) && confirming !== row.kind ? (
                  <button type="button" className={`btn btn-sm${row.failed ? ' btn-primary' : ''}`} disabled={busy !== null} onClick={() => setConfirming(row.kind)}>{row.latest ? 'Resend' : 'Send'}</button>
                ) : <span aria-hidden="true" />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
