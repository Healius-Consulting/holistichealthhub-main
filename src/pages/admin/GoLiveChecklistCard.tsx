import { useEffect, useState } from 'react';
import { describeApiError, getAdminGoLiveChecklist } from '../../shared/api';
import { ownerLabel, sectionSummary, type GoLiveChecklist } from '../../shared/goLiveChecklist';
import { formatRequestDate } from './requestFormat';
import '../../components/GoLiveChecklist.css';

/**
 * Admin view of a branch's go-live checklist (2.5): completion per section, and every
 * item with who ticked it and when. Read-only: the pharmacy ticks its own items.
 */
export function GoLiveChecklistCard({ organisationId }: { organisationId: string }) {
  const [checklist, setChecklist] = useState<GoLiveChecklist | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setChecklist(null);
    setError(null);
    getAdminGoLiveChecklist(organisationId)
      .then(view => { if (!cancelled) setChecklist(view); })
      .catch(reason => { if (!cancelled) setError(describeApiError(reason, 'The go-live checklist could not be loaded.')); });
    return () => { cancelled = true; };
  }, [organisationId]);

  return (
    <section className="pharmacy-summary__card go-live-admin" aria-labelledby="go-live-admin-title">
      <header>
        <h3 id="go-live-admin-title">Go-live checklist</h3>
        {checklist ? (
          <span className="go-live-admin__percents">
            {(['required', 'optional'] as const).map(section => {
              const summary = sectionSummary(checklist, section);
              return <span key={section} className={`pharmacy-summary__state is-${summary.percent === 100 ? 'ok' : 'wait'}`}>{section === 'required' ? 'Required' : 'Optional'} {summary.percent}%</span>;
            })}
          </span>
        ) : null}
      </header>
      {error ? <p className="go-live-checklist__error" role="alert">{error}</p> : null}
      {!checklist && !error ? <p className="go-live-checklist__loading">Loading…</p> : null}
      {checklist ? (
        <table className="go-live-admin__table">
          <thead>
            <tr><th scope="col">Item</th><th scope="col">Owner</th><th scope="col">Status</th><th scope="col">Ticked by</th></tr>
          </thead>
          <tbody>
            {checklist.items.map(item => (
              <tr key={item.key} className={item.done ? 'is-done' : undefined}>
                <td>
                  <small>{item.section === 'required' ? 'Required' : 'Optional'}</small>
                  {item.label}
                </td>
                <td>{ownerLabel(item.owners)}</td>
                <td>{item.done ? `Done${item.doneAt ? ` ${formatRequestDate(item.doneAt)}` : ''}` : item.kind === 'link' ? 'Form not sent' : 'Open'}</td>
                <td>
                  {item.kind === 'auto'
                    ? 'Automatic'
                    : item.tickedAt
                      ? `${item.tickedByName || item.tickedByUid || 'Unknown'}, ${formatRequestDate(item.tickedAt)}${item.done ? '' : ' (unticked)'}`
                      : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
