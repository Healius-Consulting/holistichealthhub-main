import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, Coins, ListChecks, RefreshCw, ShieldCheck } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { getPharmacyOverview } from '../shared/api';
import type { PharmacyOverview as PharmacyOverviewContract } from '../shared/contracts';

const kindLabels: Record<PharmacyOverviewContract['priorityItems'][number]['kind'], string> = {
  payment: 'Awaiting payment',
  collection: 'Collection follow-up',
  cancellation: 'Cancellation',
  repeat: 'Repeat prescription',
  supplier: 'Supplier',
};

function ageLabel(kind: PharmacyOverviewContract['priorityItems'][number]['kind'], ageDays: number) {
  if (kind === 'payment') {
    return ageDays === 0 ? 'Sent today' : `${ageDays} day${ageDays === 1 ? '' : 's'} awaiting payment`;
  }
  if (kind === 'repeat') {
    return `Last order ${ageDays} day${ageDays === 1 ? '' : 's'} ago`;
  }
  return `${ageDays} day${ageDays === 1 ? '' : 's'} in queue`;
}

/** Whole pounds on the Overview: the pence belong on the Finance page. */
function pounds(pence: number) {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency', currency: 'GBP', minimumFractionDigits: 0, maximumFractionDigits: 0,
  }).format(Math.round(pence) / 100);
}

function formatAsOf(value: string) {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

const INTEGRATION_STATE_LABELS: Record<PharmacyOverviewContract['integrations'][number]['state'], string> = {
  connected: 'Connected',
  degraded: 'Needs a check',
  unavailable: 'Unavailable',
  'not-configured': 'Not set up',
};

const INTEGRATION_NAMES: Record<PharmacyOverviewContract['integrations'][number]['integration'], string> = {
  curaleaf: 'Curaleaf',
  worldpay: 'Worldpay',
};

function stateLabel(item: PharmacyOverviewContract['integrations'][number]) {
  const label = INTEGRATION_STATE_LABELS[item.state] ?? item.state.replace('-', ' ');
  if (item.state === 'not-configured' || item.environment !== 'test') return label;
  return `${label} (Test)`;
}

/**
 * The check line is the honest part of this chip. "Connected" with nothing behind it
 * was the old lie, so a state with no successful check says so in words.
 */
function integrationCheckLabel(item: PharmacyOverviewContract['integrations'][number]) {
  if (item.checkedAt) return `Last confirmed ${formatAsOf(item.checkedAt)}`;
  if (item.state === 'not-configured') return 'Set up by HHH';
  return 'Never confirmed';
}

export default function PharmacyOverview() {
  const { state, dispatch } = useApp();
  const [overview, setOverview] = useState<PharmacyOverviewContract | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      setOverview(await getPharmacyOverview());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'The operational overview is unavailable.');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openScreen = (screen: 'orders' | 'patients' | 'finance') => {
    dispatch({ type: 'SET_NAVIGATION_TARGET', target: null });
    dispatch({ type: 'SET_SCREEN', screen });
  };

  const openRecord = (target: PharmacyOverviewContract['priorityItems'][number]['recordTarget']) => {
    if (target.kind === 'order') {
      dispatch({ type: 'SET_NAVIGATION_TARGET', target: { kind: 'order', key: target.id } });
      dispatch({ type: 'SET_SCREEN', screen: 'orders' });
      return;
    }
    dispatch({ type: 'SET_NAVIGATION_TARGET', target: { kind: 'patient', id: target.id } });
    dispatch({ type: 'SET_SCREEN', screen: 'patients' });
  };

  if (!overview && refreshing) {
    return (
      <div className="page-body">
        <section className="overview-state" aria-busy="true">
          <span className="spinner" aria-hidden="true" />
          <h2>Loading pharmacy overview</h2>
          <p>Retrieving the authorised operational summary.</p>
        </section>
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="page-body">
        <section className="overview-state" role="alert">
          <AlertTriangle aria-hidden="true" />
          <h2>Overview unavailable</h2>
          <p>{error}</p>
          <button className="btn btn-primary" onClick={() => void load()}>
            <RefreshCw size={16} /> Try again
          </button>
        </section>
      </div>
    );
  }

  const isStale = Date.now() - new Date(overview.asOf).getTime() > 5 * 60 * 1000;
  const ordersQueueTotal = overview.summary.awaitingPayment
    + overview.summary.supplierFulfilment
    + overview.summary.readyForCollection;

  return (
    <div className="page-body secure-overview">
      <header className="secure-overview__header">
        <div>
          {/* The screen already sits behind a server-verified session; announcing that in
              48pt type told staff nothing they could act on. The landmark keeps the
              meaning for assistive technology without spending the top of the page. */}
          <p className="sr-only">Authenticated pharmacy workspace</p>
          <h1>{overview.organisation.tradingName}</h1>
          <div className="secure-overview__identity">
            <span className={`status-badge status-badge--${state.workspaceMode === 'live' ? 'live' : 'training'}`}>
              {state.workspaceMode === 'live' ? 'Live' : 'Training'}
            </span>
            {state.organisations.find(org => org.id === state.currentOrganisationId)?.status === 'paused' ? (
              <span className="status-badge status-badge--paused">Paused</span>
            ) : null}
            <span>As of {formatAsOf(overview.asOf)}</span>
          </div>
        </div>
        <button className="btn btn-secondary" onClick={() => void load()} disabled={refreshing} aria-label="Refresh pharmacy overview">
          <RefreshCw size={16} aria-hidden="true" /> {refreshing ? 'Refreshing' : 'Refresh'}
        </button>
      </header>

      {(error || isStale) && (
        <div className="overview-advisory" role="status">
          <AlertTriangle size={17} aria-hidden="true" />
          <span>{error ?? 'This summary may be stale. Refresh before acting on queue totals.'}</span>
        </div>
      )}

      {overview.enquiries.pendingCount > 0 && (
        <section className="card overview-enquiry-notice" role="status" aria-label="HHH-managed eligibility enquiries">
          <span className="overview-enquiry-notice__icon"><ShieldCheck size={20} aria-hidden="true" /></span>
          <div>
            <p className="section-label">Eligibility enquiry</p>
            <h2>
              {overview.enquiries.pendingCount === 1
                ? 'A new enquiry has been received'
                : `${overview.enquiries.pendingCount} new enquiries have been received`}
            </h2>
            <p>
              HHH admin may accept this pharmacy or move the enquiry.
              Open Patients to see who is currently assigned to you. Referral marks them referred.
            </p>
          </div>
          <span className="status-badge status-badge--intake_live">With HHH admin</span>
        </section>
      )}

      <section className="overview-panel overview-today" aria-label="Today">
        {/* Needs you comes first and owns the attention count. The separate
            "N items need attention today" strip said the same thing one line above
            the list that already showed each item, so it is gone. */}
        <section className="card overview-queue" aria-labelledby="overview-needs-you">
          <div className="section-heading">
            <div>
              <p className="section-label">Needs you</p>
              <h2 id="overview-needs-you">
                <ListChecks size={18} aria-hidden="true" />
                {overview.priorityItems.length === 0
                  ? 'Nothing waiting on you'
                  : `${overview.priorityItems.length} item${overview.priorityItems.length === 1 ? '' : 's'} need attention`}
              </h2>
            </div>
          </div>
          {overview.priorityItems.length === 0 ? (
            <div className="overview-empty">
              <CheckCircle2 aria-hidden="true" />
              <strong>No priority exceptions</strong>
              <span>There are no awaiting payments or aged collections in this summary.</span>
            </div>
          ) : (
            <ul className="overview-priority-list">
              {overview.priorityItems.map(item => (
                <li key={item.id} className={`overview-priority-item overview-priority-item--${item.kind}`}>
                  <div>
                    <span className="overview-kind">{kindLabels[item.kind]}</span>
                    <strong>{item.maskedPatientLabel}</strong>
                    <p className="overview-priority-meta">
                      {item.orderReference && <span>{item.orderReference}</span>}
                      <span>{ageLabel(item.kind, item.ageDays)}</span>
                    </p>
                    <p>{item.summary}</p>
                  </div>
                  <button className="priority-action" onClick={() => openRecord(item.recordTarget)}>
                    {item.actionLabel} <ArrowRight size={14} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Secondary row: the money, and where the rest of the work is sitting.
            Both navigate; neither is a headline metric competing with Needs you. */}
        <div className="overview-secondary">
        {overview.finance ? (
          <section className="card overview-finance" aria-labelledby="overview-finance-title">
            <div className="section-heading">
              <div>
                <p className="section-label">Finance</p>
                <h2 id="overview-finance-title"><Coins size={18} aria-hidden="true" /> Last 30 days</h2>
              </div>
              <span>{overview.finance.realisedCount} realised</span>
            </div>
            <dl className="overview-finance__figures">
              <div>
                <dt>Patient revenue</dt>
                <dd>{pounds(overview.finance.realisedPatientRevenuePence)}</dd>
                <small>Collected orders, refunds deducted</small>
              </div>
              <div>
                <dt>Contribution</dt>
                <dd>{pounds(overview.finance.contributionPence)}</dd>
                {/* Said out loud, because a contribution figure that silently skips
                    uncosted orders reads as smaller trade rather than partial data. */}
                <small>{overview.finance.contributionComplete ? 'All realised orders costed' : 'Some orders not yet costed'}</small>
              </div>
              <div>
                <dt>Paid, awaiting collection</dt>
                <dd>{pounds(overview.finance.pendingPatientRevenuePence)}</dd>
                <small>{overview.finance.pendingCollectionCount} order{overview.finance.pendingCollectionCount === 1 ? '' : 's'}</small>
              </div>
              <div>
                <dt>Awaiting payment</dt>
                <dd>{pounds(overview.finance.awaitingPaymentValuePence)}</dd>
                <small>{overview.finance.awaitingPaymentCount} order{overview.finance.awaitingPaymentCount === 1 ? '' : 's'}</small>
              </div>
            </dl>
            <button type="button" className="overview-finance__link" onClick={() => openScreen('finance')}>
              View finance <ArrowRight size={13} aria-hidden="true" />
            </button>
          </section>
        ) : (
          <section className="card overview-finance" aria-labelledby="overview-finance-title">
            <div className="section-heading">
              <div>
                <p className="section-label">Finance</p>
                <h2 id="overview-finance-title"><Coins size={18} aria-hidden="true" /> Last 30 days</h2>
              </div>
            </div>
            <p className="overview-muted">Figures could not be worked out just now. Refresh, or open Finance for the full ledger.</p>
            <button type="button" className="overview-finance__link" onClick={() => openScreen('finance')}>
              View finance <ArrowRight size={13} aria-hidden="true" />
            </button>
          </section>
        )}

        <section className="card overview-pipeline" aria-labelledby="overview-pipeline-title">
          <div className="section-heading">
            <div>
              <p className="section-label">Pipeline</p>
              <h2 id="overview-pipeline-title">Where the rest is sitting</h2>
            </div>
            <span>{ordersQueueTotal} in the queue</span>
          </div>
          <ul className="overview-pipeline__counts">
            <li>
              <button type="button" onClick={() => openScreen('orders')}>
                <strong>{overview.summary.awaitingPayment}</strong>
                <span>Awaiting payment</span>
              </button>
            </li>
            <li>
              <button type="button" onClick={() => openScreen('orders')}>
                <strong>{overview.summary.supplierFulfilment}</strong>
                <span>With Curaleaf</span>
              </button>
            </li>
            <li>
              <button type="button" onClick={() => openScreen('orders')}>
                <strong>{overview.summary.readyForCollection}</strong>
                <span>Ready to collect</span>
              </button>
            </li>
          </ul>
        </section>
        </div>

        {/* Integrations are a standing fact, not a job. Quiet chips, and the only
            action is to go and look at Settings — no credential editing here. */}
        <section className="overview-integrations" aria-label="Integration health">
          <p className="section-label">Integrations</p>
          <ul className="overview-integrations__chips">
            {overview.integrations.map(item => (
              <li key={item.integration} className={`overview-integration-chip overview-integration-chip--${item.state}`}>
                <span className="overview-integration-chip__name">{INTEGRATION_NAMES[item.integration] ?? item.integration}</span>
                <strong className={`integration-state integration-state--${item.state}`}>{stateLabel(item)}</strong>
                <small>{item.detail ?? integrationCheckLabel(item)}</small>
                <small className="overview-integration-chip__checked">{integrationCheckLabel(item)}</small>
              </li>
            ))}
          </ul>
          <button type="button" className="overview-integrations__link" onClick={() => dispatch({ type: 'SET_SCREEN', screen: 'settings' })}>
            Open Settings <ArrowRight size={13} aria-hidden="true" />
          </button>
        </section>
      </section>
    </div>
  );
}
