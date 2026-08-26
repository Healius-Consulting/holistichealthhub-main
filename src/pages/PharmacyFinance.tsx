import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { money, useApp } from '../context/AppContext';
import { getPharmacyPrescriptionFinance } from '../shared/api';
import type { PharmacyPrescriptionFinanceReport } from '../shared/contracts';
import { isLocalPortalPreview } from '../dev/localPortalPreview';
import { compactPatientName } from '../utils/patientName';
import './PharmacyFinance.css';

type Period = '30' | '90' | '365' | 'all';
type FinanceRow = PharmacyPrescriptionFinanceReport['rows'][number];

const PERIOD_OPTIONS: Array<{ value: Period; short: string; label: string }> = [
  { value: '30', short: '30d', label: 'Last 30 days' },
  { value: '90', short: '90d', label: 'Last 90 days' },
  { value: '365', short: '12m', label: 'Last 12 months' },
  { value: 'all', short: 'All', label: 'All realised prescriptions' },
];

function periodStart(period: Period) {
  if (period === 'all') return undefined;
  return new Date(Date.now() - Number(period) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function emptyTotals(): PharmacyPrescriptionFinanceReport['totals'] {
  return {
    prescriptionCount: 0,
    paidPrescriptionCount: 0,
    pendingCollectionCount: 0,
    pendingPatientRevenuePence: 0,
    pendingPrescriptionCount: 0,
    refundedPrescriptionCount: 0,
    refundedPatientPence: 0,
    refundPendingCount: 0,
    refundPendingPatientPence: 0,
    patientRevenuePence: 0,
    productRevenuePence: 0,
    dispensingFeesPence: 0,
    wholesaleKnownForCount: 0,
    wholesalePendingForCount: 0,
    wholesaleProductPence: 0,
    shippingPence: 0,
    wholesalePence: 0,
    productMarginPence: 0,
    totalContributionPence: 0,
  };
}

function emptyFinanceReport(period: Period, organisationId: string): PharmacyPrescriptionFinanceReport {
  return {
    organisationId,
    currency: 'GBP',
    range: { from: periodStart(period) ?? null, to: null },
    periodCounts: { '30': 0, '90': 0, '365': 0, all: 0 },
    totals: emptyTotals(),
    rows: [],
  };
}

function localPreviewFinanceReport(period: Period): PharmacyPrescriptionFinanceReport {
  const now = new Date().toISOString();
  const realisedRow: FinanceRow = {
    orderId: 'LOCAL-REALISED-01',
    patientId: 'local-patient-1',
    patientName: 'Sample Patient',
    createdAt: now,
    updatedAt: now,
    recognisedAt: now,
    refundedAt: null,
    financialEventAt: now,
    paymentStatus: 'paid',
    fulfilmentStatus: 'collected',
    recognised: true,
    realised: true,
    pendingCollection: false,
    refunded: false,
    refundPending: false,
    productRevenuePence: 10_000,
    dispensingFeePence: 500,
    patientRevenuePence: 10_500,
    wholesaleProductPence: 8_000,
    shippingPence: 500,
    wholesalePence: 8_500,
    productMarginPence: 2_000,
    totalContributionPence: 2_000,
    wholesaleComplete: true,
    lines: [{
      packId: 'local-pack-1',
      name: 'Sample product',
      quantity: 1,
      unitPricePence: 10_000,
      wholesaleUnitPence: 8_000,
      productMarginPence: 2_000,
    }],
  };
  const pendingRow: FinanceRow = {
    ...realisedRow,
    orderId: 'LOCAL-PENDING-01',
    patientId: 'local-patient-2',
    patientName: 'Awaiting Collection',
    recognisedAt: null,
    fulfilmentStatus: 'ready_for_collection',
    recognised: false,
    realised: false,
    pendingCollection: true,
    productRevenuePence: 7_500,
    dispensingFeePence: 500,
    patientRevenuePence: 8_000,
    wholesaleProductPence: 6_000,
    shippingPence: 400,
    wholesalePence: 6_400,
    productMarginPence: 1_500,
    totalContributionPence: 1_600,
  };
  return {
    organisationId: 'local-preview-pharmacy',
    currency: 'GBP',
    range: { from: periodStart(period) ?? null, to: null },
    periodCounts: { '30': 1, '90': 1, '365': 1, all: 1 },
    totals: {
      ...emptyTotals(),
      prescriptionCount: 2,
      paidPrescriptionCount: 1,
      pendingCollectionCount: 1,
      pendingPatientRevenuePence: 8_000,
      patientRevenuePence: 10_500,
      productRevenuePence: 10_000,
      dispensingFeesPence: 500,
      wholesaleKnownForCount: 1,
      wholesaleProductPence: 8_000,
      shippingPence: 500,
      wholesalePence: 8_500,
      productMarginPence: 2_000,
      totalContributionPence: 2_000,
    },
    rows: [realisedRow, pendingRow],
  };
}

function pounds(pence: number) {
  return money(pence / 100);
}

function FinancialValue({ value }: { value: number | null }) {
  if (value === null) return <span className="pharmacy-finance__awaiting">Awaiting quote</span>;
  return <>{pounds(value)}</>;
}

function eventDate(row: FinanceRow) {
  return new Date(row.recognisedAt ?? row.financialEventAt);
}

function formatDate(value: Date) {
  return value.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Prefer API flags; if Firebase deploy lags, derive from fulfilment + recognised. */
function financeRowFlags(row: FinanceRow) {
  if (typeof row.realised === 'boolean') {
    return {
      realised: row.realised,
      pendingCollection: Boolean(row.pendingCollection),
    };
  }
  const retained = Boolean(row.recognised) && !row.refunded && !row.refundPending;
  const collected = String(row.fulfilmentStatus || '').toUpperCase() === 'COLLECTED';
  return {
    realised: retained && collected,
    pendingCollection: retained && !collected,
  };
}

function summariseRealisedRows(rows: FinanceRow[]) {
  const costed = rows.filter(row => row.wholesaleComplete);
  return {
    paidPrescriptionCount: rows.length,
    patientRevenuePence: rows.reduce((sum, row) => sum + row.patientRevenuePence, 0),
    productRevenuePence: rows.reduce((sum, row) => sum + row.productRevenuePence, 0),
    dispensingFeesPence: rows.reduce((sum, row) => sum + row.dispensingFeePence, 0),
    wholesaleKnownForCount: costed.length,
    wholesalePendingForCount: rows.length - costed.length,
    wholesaleProductPence: costed.reduce((sum, row) => sum + (row.wholesaleProductPence ?? 0), 0),
    shippingPence: costed.reduce((sum, row) => sum + (row.shippingPence ?? 0), 0),
    wholesalePence: costed.reduce((sum, row) => sum + (row.wholesalePence ?? 0), 0),
    productMarginPence: costed.reduce((sum, row) => sum + (row.productMarginPence ?? 0), 0),
    totalContributionPence: costed.reduce((sum, row) => sum + (row.totalContributionPence ?? 0), 0),
  };
}

type LedgerRow = FinanceRow & { realised: boolean; pendingCollection: boolean };

export default function PharmacyFinance() {
  const { state } = useApp();
  const liveWorkspace = state.workspaceMode === 'live';
  const [period, setPeriod] = useState<Period>('90');
  const [report, setReport] = useState<PharmacyPrescriptionFinanceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  const load = useCallback(async () => {
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    setLoading(true);
    setError(null);
    try {
      const nextReport = isLocalPortalPreview
        ? localPreviewFinanceReport(period)
        : liveWorkspace
          ? await getPharmacyPrescriptionFinance({ from: periodStart(period) })
          : emptyFinanceReport(period, state.currentOrganisationId);
      if (requestVersion.current === version) setReport(nextReport);
    } catch (loadError) {
      if (requestVersion.current === version) {
        setError(loadError instanceof Error ? loadError.message : 'The finance report is unavailable.');
      }
    } finally {
      if (requestVersion.current === version) setLoading(false);
    }
  }, [liveWorkspace, period, state.currentOrganisationId]);

  useEffect(() => { void load(); }, [load]);

  const classifiedRows = useMemo<LedgerRow[]>(() => (report?.rows ?? []).map(row => ({
    ...row,
    ...financeRowFlags(row),
  })), [report]);

  const ledgerRows = useMemo(() => classifiedRows
    .filter(row => row.realised || row.pendingCollection)
    .sort((left, right) => {
      if (left.pendingCollection !== right.pendingCollection) {
        return left.pendingCollection ? 1 : -1;
      }
      return eventDate(right).getTime() - eventDate(left).getTime();
    }), [classifiedRows]);

  const serverHasCollectionGate = Boolean(
    report
    && (
      typeof report.totals.pendingCollectionCount === 'number'
      || report.rows.some(row => typeof row.realised === 'boolean')
    ),
  );

  const totals = useMemo(() => {
    if (!report) return null;
    if (serverHasCollectionGate) return report.totals;

    const realisedRows = classifiedRows.filter(row => row.realised);
    const pendingRows = classifiedRows.filter(row => row.pendingCollection);
    return {
      ...report.totals,
      ...summariseRealisedRows(realisedRows),
      pendingCollectionCount: pendingRows.length,
      pendingPatientRevenuePence: pendingRows.reduce((sum, row) => sum + row.patientRevenuePence, 0),
    };
  }, [report, classifiedRows, serverHasCollectionGate]);

  const periodLabel = PERIOD_OPTIONS.find(option => option.value === period)?.label ?? 'Selected period';
  const realisedCount = totals?.paidPrescriptionCount ?? 0;

  return (
    <div className="page-body pharmacy-finance" aria-busy={loading}>
      <header className="pharmacy-finance__header">
        <div className="pharmacy-finance__intro">
          <p className="section-label">Finance</p>
          <h2>Realised after patient collection</h2>
          <p>Headline figures include paid orders only once they are fully collected.</p>
        </div>
        <div className="pharmacy-finance__period-wrap">
          <div className="pharmacy-finance__period" role="group" aria-label="Reporting period">
            {PERIOD_OPTIONS.map(option => (
              <button
                key={option.value}
                type="button"
                aria-pressed={period === option.value}
                aria-label={option.label}
                className={period === option.value ? 'is-active' : undefined}
                onClick={() => setPeriod(option.value)}
              >
                {option.short}
              </button>
            ))}
          </div>
          <p className="pharmacy-finance__period-meta">
            {realisedCount} realised · {periodLabel}
          </p>
        </div>
      </header>

      {loading && !report && (
        <section className="pharmacy-finance__state" role="status">
          <span className="spinner" aria-hidden="true" />
          <h2>Loading finance report</h2>
          <p>Calculating realised and pending collection totals.</p>
        </section>
      )}

      {error && (
        <div className="pharmacy-finance__error" role="alert">
          <AlertCircle size={17} aria-hidden="true" />
          <div>
            <strong>Finance report unavailable</strong>
            <span>{error}</span>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
            <RefreshCw size={14} aria-hidden="true" /> Try again
          </button>
        </div>
      )}

      {report && totals && (
        <>
          <section className="pharmacy-finance__realised" aria-label={`${periodLabel} realised summary`} aria-live="polite">
            <p className="section-label">Realised</p>
            <div className="pharmacy-finance__hero">
              <span className="pharmacy-finance__hero-label">Estimated contribution</span>
              <strong className="pharmacy-finance__hero-value">{pounds(totals.totalContributionPence)}</strong>
              <span className="pharmacy-finance__hero-note">
                {totals.wholesalePendingForCount
                  ? `${totals.wholesaleKnownForCount} of ${totals.paidPrescriptionCount} realised orders costed`
                  : 'Patient total − quoted products and shipping'}
              </span>
            </div>
            <dl className="pharmacy-finance__metrics">
              <div>
                <dt>Patient revenue</dt>
                <dd>{pounds(totals.patientRevenuePence)}</dd>
                <small>incl. {pounds(totals.dispensingFeesPence)} dispensing</small>
              </div>
              <div>
                <dt>Quoted cost</dt>
                <dd>{pounds(totals.wholesalePence)}</dd>
                <small>Products {pounds(totals.wholesaleProductPence)} + shipping {pounds(totals.shippingPence)}</small>
              </div>
              <div>
                <dt>Product margin</dt>
                <dd>{pounds(totals.productMarginPence)}</dd>
                <small>Patient product price less quoted product cost</small>
              </div>
            </dl>
          </section>

          <section
            className={`pharmacy-finance__pending-band${totals.pendingCollectionCount ? '' : ' is-empty'}`}
            aria-label="Pending collection"
          >
            {totals.pendingCollectionCount > 0 ? (
              <>
                <div>
                  <p className="section-label">Pending collection</p>
                  <p>
                    <strong>{totals.pendingCollectionCount}</strong>
                    {' '}paid order{totals.pendingCollectionCount === 1 ? '' : 's'} awaiting collection
                  </p>
                </div>
                <strong className="pharmacy-finance__pending-total">{pounds(totals.pendingPatientRevenuePence)}</strong>
              </>
            ) : (
              <p>No paid orders awaiting collection in this period.</p>
            )}
          </section>

          <section className="card card-flush pharmacy-finance__ledger">
            <div className="section-heading section-heading--padded">
              <div>
                <p className="section-label">Orders</p>
                <h3>
                  {ledgerRows.length} order{ledgerRows.length === 1 ? '' : 's'} · {periodLabel}
                </h3>
              </div>
              <span>Realised and awaiting collection</span>
            </div>

            {ledgerRows.length === 0 ? (
              <div className="pharmacy-finance__state pharmacy-finance__state--empty">
                <h3>{liveWorkspace ? 'No realised or pending orders in this period' : 'Training examples are not paid prescriptions'}</h3>
                <p>{liveWorkspace
                  ? 'Paid orders appear as pending until collection, then move into realised totals.'
                  : 'Live paid-order totals appear here after HHH flips this workspace live.'}</p>
              </div>
            ) : (
              <div className="pharmacy-finance__table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Status</th>
                      <th>Patient total</th>
                      <th>Quoted cost</th>
                      <th>Margin</th>
                      <th>Contribution</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledgerRows.map(record => {
                      const pending = record.pendingCollection;
                      return (
                        <tr key={record.orderId} className={pending ? 'is-pending' : 'is-realised'}>
                          <td>
                            <strong title={record.patientName}>{compactPatientName(record.patientName)}</strong>
                            <span>{formatDate(eventDate(record))} · {record.orderId}</span>
                          </td>
                          <td data-label="Status">
                            <span className={`pharmacy-finance__status${pending ? ' is-pending' : ' is-realised'}`}>
                              {pending ? 'Awaiting collection' : 'Realised'}
                            </span>
                          </td>
                          <td data-label="Patient total"><FinancialValue value={record.patientRevenuePence} /></td>
                          <td data-label="Quoted cost"><FinancialValue value={record.wholesalePence} /></td>
                          <td data-label="Margin"><FinancialValue value={record.productMarginPence} /></td>
                          <td data-label="Contribution" className="pharmacy-finance__contribution">
                            {pending
                              ? <span className="pharmacy-finance__awaiting">—</span>
                              : <FinancialValue value={record.totalContributionPence} />}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="pharmacy-finance__footnote">
            Operational estimate for this pharmacy only—not a Curaleaf settlement statement.
            {totals.refundedPrescriptionCount > 0 || totals.refundPendingCount > 0
              ? ` Refunded and refund-pending orders are excluded (${totals.refundedPrescriptionCount} completed / ${totals.refundPendingCount} pending).`
              : ' Refunded and refund-pending orders are excluded.'}
            {' '}Realised patient total for the period: <strong>{pounds(totals.patientRevenuePence)}</strong>.
          </p>
        </>
      )}
    </div>
  );
}
