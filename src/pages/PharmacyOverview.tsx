import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, Coins, ListChecks, RefreshCw, ShieldCheck } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { getPharmacyOverview } from '../shared/api';
import type { PharmacyOverview as PharmacyOverviewContract } from '../shared/contracts';
import { isLocalPortalPreview } from '../dev/localPortalPreview';
import { pharmacyWorkspaceStatusLabel, sandboxOverviewForOrganisation, usesSandboxDummyPack } from '../training/workspace';

type PriorityItem = PharmacyOverviewContract['priorityItems'][number];
type PriorityKind = PriorityItem['kind'];

const kindLabels: Record<PriorityKind, string> = {
  payment: 'Awaiting payment',
  collection: 'Collection follow-up',
  cancellation: 'Cancellation',
  repeat: 'Repeat prescription',
  supplier: 'Supplier',
};

/**
 * Worst first. The queue groups by kind, so this is the order staff work down:
 * a supplier cancellation costs the patient their medicine, an aged collection is
 * stock sitting on a shelf, and a repeat is a nudge that can wait until lunchtime.
 */
const KIND_ORDER: PriorityKind[] = ['cancellation', 'collection', 'supplier', 'payment', 'repeat'];

/**
 * One list per kind, in KIND_ORDER, keeping the server's ordering inside a group.
 * Groups the API sent nothing for do not appear at all.
 */
function groupByKind(items: PriorityItem[]): Array<{ kind: PriorityKind; items: PriorityItem[] }> {
  return KIND_ORDER
    .map(kind => ({ kind, items: items.filter(item => item.kind === kind) }))
    .filter(group => group.items.length > 0);
}

function ageLabel(kind: PriorityKind, ageDays: number) {
  if (kind === 'payment') {
    return ageDays === 0 ? 'Sent today' : `${ageDays} day${ageDays === 1 ? '' : 's'} awaiting payment`;
  }
  if (kind === 'repeat') {
    return `Last order ${ageDays} day${ageDays === 1 ? '' : 's'} ago`;
  }
  return `${ageDays} day${ageDays === 1 ? '' : 's'} in queue`;
}

/** Whole pounds on the Overview: the pence belong on the Finance page. */
function pounds(pence: number | null | undefined) {
  if (typeof pence !== 'number' || !Number.isFinite(pence)) return '—';
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
  const organisation = state.organisations.find(org => org.id === state.currentOrganisationId) ?? state.organisations[0];
  const sandboxOverview = usesSandboxDummyPack(organisation, isLocalPortalPreview);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      if (sandboxOverview && organisation) {
        setOverview(sandboxOverviewForOrganisation(organisation));
        return;
      }
      setOverview(await getPharmacyOverview());
    } catch (loadError) {
      if (sandboxOverview && organisation) {
        setOverview(sandboxOverviewForOrganisation(organisation));
        return;
      }
      setError(loadError instanceof Error ? loadError.message : 'The operational overview is unavailable.');
    } finally {
      setRefreshing(false);
    }
  }, [organisation, sandboxOverview]);

  useEffect(() => { void load(); }, [load]);

  const openPatientsHub = () => {
    dispatch({ type: 'SET_NAVIGATION_TARGET', target: { kind: 'patient-lane', lane: 'enquiries' } });
    dispatch({ type: 'SET_SCREEN', screen: 'patients' });
  };

  const openScreen = (screen: 'orders' | 'patients' | 'finance') => {
    dispatch({ type: 'SET_NAVIGATION_TARGET', target: null });
    dispatch({ type: 'SET_SCREEN', screen });
  };

  const openRecord = (target: PriorityItem['recordTarget']) => {
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
      <header className="secure-overview__header" data-tour="overview-identity">
        <div>
          {/* The screen already sits behind a server-verified session; announcing that in
              48pt type told staff nothing they could act on. The landmark keeps the
              meaning for assistive technology without spending the top of the page. */}
          <p className="sr-only">Authenticated pharmacy workspace</p>
          <h1>{overview.organisation.tradingName}</h1>
          <div className="secure-overview__identity">
            <span className={`status-badge status-badge--${state.workspaceMode}`}>
              {pharmacyWorkspaceStatusLabel(state.workspaceMode)}
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
        <section className="card overview-enquiry-notice" role="status" aria-label="HHH-managed eligibility enquiries" data-tour="overview-enquiry">
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
          <div className="overview-enquiry-notice__actions">
            <span className="status-badge status-badge--intake_live">With HHH admin</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={openPatientsHub}>
              Open Patients <ArrowRight size={14} aria-hidden="true" />
            </button>
          </div>
        </section>
      )}

      {overview.finance ? (
        <section className="card overview-finance" aria-labelledby="overview-finance-title">
          <div className="section-heading">
            <div><p className="section-label">Finance</p><h2 id="overview-finance-title"><Coins size={18} aria-hidden="true" /> This month</h2></div>
            <span>{overview.finance.payingPatientCount === 1 ? '1 paying patient' : `${overview.finance.payingPatientCount} paying patients`}</span>
          </div>
          <dl className="overview-finance__figures">
            <div className="overview-finance__hero">
              <dt>Gross profit</dt>
              <dd>{pounds(overview.finance.grossProfitPence)}</dd>
              <small>
                {overview.finance.grossProfitComplete
                  ? 'Patient payments less matching wholesale'
                  : overview.finance.revenueOrderCount > 0
                    ? `Incomplete cost data · ${overview.finance.costedOrderCount} of ${overview.finance.revenueOrderCount} orders costed`
                    : 'Incomplete cost data'}
              </small>
            </div>
            <div>
              <dt>Revenue</dt>
              <dd>{pounds(overview.finance.revenuePence)}</dd>
              <small>Settled payments this month</small>
            </div>
            <div>
              <dt>Average spend</dt>
              <dd>{overview.finance.payingPatientCount === 0 ? pounds(0) : pounds(overview.finance.averageSpendPence)}</dd>
              <small>
                {overview.finance.payingPatientCount === 0
                  ? 'No paying patients'
                  : `Based on ${overview.finance.payingPatientCount} paying patient${overview.finance.payingPatientCount === 1 ? '' : 's'}`}
              </small>
            </div>
            <div className="overview-finance__outstanding">
              <dt>Awaiting payment</dt>
              <dd>{pounds(overview.finance.awaitingPaymentValuePence)}</dd>
              <small>Outstanding · {overview.finance.awaitingPaymentCount} order{overview.finance.awaitingPaymentCount === 1 ? '' : 's'}</small>
            </div>
          </dl>
          <p className="overview-finance__note">Settled cash this month. Finance is the collected-order ledger.</p>
          <button type="button" className="overview-finance__link" onClick={() => openScreen('finance')}>View finance <ArrowRight size={13} aria-hidden="true" /></button>
        </section>
      ) : (
        <section className="card overview-finance" aria-labelledby="overview-finance-title">
          <div className="section-heading"><div><p className="section-label">Finance</p><h2 id="overview-finance-title"><Coins size={18} aria-hidden="true" /> This month</h2></div></div>
          <p className="overview-muted">Figures could not be worked out just now. Refresh, or open Finance for the full ledger.</p>
          <button type="button" className="overview-finance__link" onClick={() => openScreen('finance')}>View finance <ArrowRight size={13} aria-hidden="true" /></button>
        </section>
      )}

      <section className="overview-panel overview-today" aria-label="Today">
        {/* Needs you comes first and owns the attention count. The separate
            "N items need attention today" strip said the same thing one line above
            the list that already showed each item, so it is gone. */}
        <section className="card overview-queue" aria-labelledby="overview-needs-you" data-tour="overview-daily">
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
            <p className="overview-queue__clear">
              <CheckCircle2 size={16} aria-hidden="true" />
              <span>Nothing waiting — no awaiting payments or aged collections in this summary.</span>
            </p>
          ) : (
            /* Grouped by kind so the kind is said once, in the group heading, instead
               of shouted on every row. Each row is one hit target: the whole row is
               the button, and the action label is its accessible name. */
            <div className="overview-queue__groups">
              {groupByKind(overview.priorityItems).map(group => (
                <section
                  key={group.kind}
                  className={`overview-priority-group overview-priority-group--${group.kind}`}
                  aria-label={`${kindLabels[group.kind]} (${group.items.length})`}
                >
                  <p className="overview-priority-group__head">
                    <span className="overview-priority-group__label">{kindLabels[group.kind]}</span>
                    <span className="overview-priority-group__count">{group.items.length}</span>
                  </p>
                  <ul className="overview-priority-list">
                    {group.items.map(item => (
                      <li key={item.id}>
                        <button
                          type="button"
                          className="overview-priority-row"
                          onClick={() => openRecord(item.recordTarget)}
                          aria-label={`${item.actionLabel}: ${item.maskedPatientLabel}${item.orderReference ? `, ${item.orderReference}` : ''}. ${item.summary}`}
                        >
                          <span className="overview-priority-row__identity">
                            <strong>{item.maskedPatientLabel}</strong>
                            {item.orderReference ? (
                              <span className="overview-priority-row__ref">{item.orderReference}</span>
                            ) : null}
                          </span>
                          <span className="overview-priority-row__summary">{item.summary}</span>
                          <span className="overview-priority-row__age">{ageLabel(item.kind, item.ageDays)}</span>
                          <ArrowRight size={14} className="overview-priority-row__go" aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </section>

        {/* Integration health and pipeline share the final row, in mobile source order. */}
        <div className="overview-secondary">
          <section className="card overview-integrations" aria-label="Integration health" data-tour="overview-integrations">
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
            <button type="button" className="overview-integrations__link" onClick={() => dispatch({ type: 'SET_SCREEN', screen: 'settings' })}>Open Settings <ArrowRight size={13} aria-hidden="true" /></button>
          </section>

        <section className="card overview-pipeline" aria-labelledby="overview-pipeline-title" data-tour="overview-pipeline">
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

      </section>
    </div>
  );
}
