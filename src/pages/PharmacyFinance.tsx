import { formatUkDate } from '../utils/ukDates';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { money, useApp } from '../context/AppContext';
import { getPharmacyPrescriptionFinance } from '../shared/api';
import type { PharmacyPrescriptionFinanceReport } from '../shared/contracts';
import { isLocalPortalPreview } from '../dev/localPortalPreview';
import { isOpenPharmacyWorkspace } from '../training/workspace';
import { compactPatientName } from '../utils/patientName';
import './PharmacyFinance.css';

type Period = 'this-month' | 'last-month' | 'last-3' | 'this-year' | 'custom';
type FinanceRow = PharmacyPrescriptionFinanceReport['rows'][number];

const PERIOD_OPTIONS: Array<{ value: Period; short: string; label: string }> = [
  { value: 'this-month', short: 'This month', label: 'This month' },
  { value: 'last-month', short: 'Last month', label: 'Last month' },
  { value: 'last-3', short: 'Last 3 months', label: 'Last 3 months' },
  { value: 'this-year', short: 'This year', label: 'This year' },
  { value: 'custom', short: 'Custom range', label: 'Custom range' },
];

function londonToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function shiftMonth(year: number, month: number, delta: number) {
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

function periodRange(period: Period, customFrom: string, customTo: string) {
  const today = londonToday();
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const pad = (value: number) => String(value).padStart(2, '0');
  if (period === 'last-month') {
    const previous = shiftMonth(year, month, -1);
    const lastDay = new Date(Date.UTC(previous.year, previous.month, 0)).getUTCDate();
    return { from: `${previous.year}-${pad(previous.month)}-01`, to: `${previous.year}-${pad(previous.month)}-${pad(lastDay)}` };
  }
  if (period === 'last-3') {
    const start = shiftMonth(year, month, -2);
    return { from: `${start.year}-${pad(start.month)}-01`, to: today };
  }
  if (period === 'this-year') return { from: `${year}-01-01`, to: today };
  if (period === 'custom') return { from: customFrom || undefined, to: customTo || undefined };
  return { from: `${year}-${pad(month)}-01`, to: today };
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
    pharmacyDeliveryFeesPence: 0,
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
  const range = periodRange(period, '', '');
  return {
    organisationId,
    currency: 'GBP',
    range: { from: range.from ?? null, to: range.to ?? null },
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
    pharmacyDeliveryPence: 0,
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
    pharmacyDeliveryPence: 0,
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
    range: { from: periodRange(period, '', '').from ?? null, to: periodRange(period, '', '').to ?? null },
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
      pharmacyDeliveryFeesPence: 0,
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

function FinancialValue({ value, estimated }: { value: number | null; estimated?: boolean }) {
  if (value === null) return <span className="pharmacy-finance__awaiting">Awaiting quote</span>;
  // A quote-bank figure is today's catalogue price, not the frozen paid quote. Say so
  // in text as well as styling so nobody reads it as a settled cost.
  if (estimated) {
    return (
      <span className="pharmacy-finance__estimated" title="Estimated from the Curaleaf quote bank; no paid quote was frozen on this order.">
        {pounds(value)} <small>est.</small>
      </span>
    );
  }
  return <>{pounds(value)}</>;
}

function eventDate(row: FinanceRow) {
  return new Date(row.recognisedAt ?? row.financialEventAt);
}

function formatDate(value: Date) {
  return formatUkDate(value);
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
    wholesaleEstimatedForCount: costed.filter(row => row.wholesaleEstimated).length,
    paidPrescriptionCount: rows.length,
    patientRevenuePence: rows.reduce((sum, row) => sum + row.patientRevenuePence, 0),
    productRevenuePence: rows.reduce((sum, row) => sum + row.productRevenuePence, 0),
    dispensingFeesPence: rows.reduce((sum, row) => sum + row.dispensingFeePence, 0),
    pharmacyDeliveryFeesPence: rows.reduce((sum, row) => sum + row.pharmacyDeliveryPence, 0),
    wholesaleKnownForCount: costed.length,
    wholesalePendingForCount: rows.length - costed.length,
    wholesaleProductPence: costed.reduce((sum, row) => sum + (row.wholesaleProductPence ?? 0), 0),
    shippingPence: costed.reduce((sum, row) => sum + (row.shippingKnown === false ? 0 : row.shippingPence ?? 0), 0),
    wholesalePence: costed.reduce((sum, row) => sum + (row.wholesalePence ?? 0), 0),
    productMarginPence: costed.reduce((sum, row) => sum + (row.productMarginPence ?? 0), 0),
    totalContributionPence: costed.reduce((sum, row) => sum + (row.totalContributionPence ?? 0), 0),
  };
}

type LedgerRow = FinanceRow & { realised: boolean; pendingCollection: boolean };

export default function PharmacyFinance() {
  const { state, dispatch } = useApp();
  const liveWorkspace = isOpenPharmacyWorkspace(state.workspaceMode);
  const [period, setPeriod] = useState<Period>('this-month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
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
          ? await getPharmacyPrescriptionFinance(periodRange(period, customFrom, customTo))
          : emptyFinanceReport(period, state.currentOrganisationId);
      if (requestVersion.current === version) setReport(nextReport);
    } catch (loadError) {
      if (requestVersion.current === version) {
        setError(loadError instanceof Error ? loadError.message : 'The finance report is unavailable.');
      }
    } finally {
      if (requestVersion.current === version) setLoading(false);
    }
  }, [customFrom, customTo, liveWorkspace, period, state.currentOrganisationId]);

  useEffect(() => { void load(); }, [load]);

  const classifiedRows = useMemo<LedgerRow[]>(() => (report?.rows ?? []).map(row => ({
    ...row,
    ...financeRowFlags(row),
  })), [report]);

  const ledgerRows = useMemo(() => classifiedRows
    .slice()
    .sort((left, right) => eventDate(right).getTime() - eventDate(left).getTime()), [classifiedRows]);

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
    <div className="page-body pharmacy-finance" aria-busy={loading} data-tour="finance">
      <header className="pharmacy-finance__header">
        <div className="pharmacy-finance__intro">
          <p className="section-label">Finance</p>
          <h2>Prescription financials</h2>
          <p>Figures follow the date the patient paid. A refund reduces the period in which it is issued.</p>
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
          {period === 'custom' ? (
            <div className="pharmacy-finance__period" role="group" aria-label="Custom date range">
              <label>From <input type="date" value={customFrom} onChange={event => setCustomFrom(event.target.value)} /></label>
              <label>To <input type="date" value={customTo} onChange={event => setCustomTo(event.target.value)} /></label>
            </div>
          ) : null}
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
          <section className="pharmacy-finance__realised" aria-label={`${periodLabel} summary`} aria-live="polite">
            <dl className="pharmacy-finance__metrics">
              <div className="pharmacy-finance__hero">
                <dt>Revenue</dt>
                <dd>{pounds(totals.revenuePence ?? totals.patientRevenuePence)}</dd>
              </div>
              <div>
                <dt>Gross profit</dt>
                <dd>{pounds(totals.grossProfitPence ?? totals.productMarginPence)}</dd>
                <small>{totals.marginPercent == null ? 'Margin unavailable' : `${totals.marginPercent}% margin`}</small>
              </div>
              <div>
                <dt>Average revenue per patient</dt>
                <dd>{pounds(totals.averageRevenuePerPatientPence ?? 0)}</dd>
                <small>Average gross profit per patient {pounds(totals.averageGrossProfitPerPatientPence ?? 0)}</small>
              </div>
              <div>
                <dt>Average item price</dt>
                <dd>{pounds(totals.averageItemPricePence ?? 0)}</dd>
                <small>Average gross profit per item {pounds(totals.averageGrossProfitPerItemPence ?? 0)}</small>
              </div>
            </dl>
          </section>

          <button
            type="button"
            className="pharmacy-finance__pending-band"
            onClick={() => {
              dispatch({ type: 'SET_NAVIGATION_TARGET', target: { kind: 'order-filter', filter: 'awaiting-payment' } });
              dispatch({ type: 'SET_SCREEN', screen: 'orders' });
            }}
          >
            <div>
              <p className="section-label">Awaiting payment</p>
              <p><strong>{totals.awaitingPaymentCount ?? 0}</strong> order{(totals.awaitingPaymentCount ?? 0) === 1 ? '' : 's'}</p>
            </div>
            <strong className="pharmacy-finance__pending-total">{pounds(totals.awaitingPaymentValuePence ?? 0)}</strong>
          </button>

          <section className="card card-flush pharmacy-finance__ledger">
            <div className="section-heading section-heading--padded">
              <div>
                <p className="section-label">Orders</p>
                <h3>
                  {ledgerRows.length} order{ledgerRows.length === 1 ? '' : 's'} · {periodLabel}
                </h3>
              </div>
              <span>Paid in this period</span>
            </div>

            {ledgerRows.length === 0 ? (
              <div className="pharmacy-finance__state pharmacy-finance__state--empty">
                <h3>{liveWorkspace ? 'No settled orders in this period' : 'Training examples are not paid prescriptions'}</h3>
                <p>{liveWorkspace
                  ? 'Orders appear here once the patient has paid, whether or not they have collected.'
                  : 'Live paid-order totals appear here after HHH flips this workspace live.'}</p>
              </div>
            ) : (
              <div className="pharmacy-finance__table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Revenue</th>
                      <th>Wholesale cost</th>
                      <th>Gross profit</th>
                      <th>Margin %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledgerRows.map(record => {
                      const revenue = record.grossPatientRevenuePence ?? record.patientRevenuePence;
                      const medicine = record.grossProductRevenuePence ?? record.productRevenuePence;
                      const grossProfit = record.wholesaleProductPence == null ? null : medicine - record.wholesaleProductPence;
                      return (
                        <tr key={record.orderId}>
                          <td>
                            <strong title={record.patientName}>{compactPatientName(record.patientName)}</strong>
                            <span>{formatDate(record.paidAt ? new Date(record.paidAt) : eventDate(record))} · {record.orderId}</span>
                          </td>
                          <td data-label="Revenue"><FinancialValue value={revenue} /></td>
                          <td data-label="Wholesale cost"><FinancialValue value={record.wholesaleProductPence} /></td>
                          <td data-label="Gross profit"><FinancialValue value={grossProfit} /></td>
                          <td data-label="Margin %">{medicine > 0 && grossProfit != null ? `${Math.round((grossProfit / medicine) * 1000) / 10}%` : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="pharmacy-finance__footnote">
            Revenue includes delivery. Gross profit is medicines after any discount, less wholesale cost excluding VAT.
            {(totals.refundsIssuedPence ?? 0) > 0 ? ` Refunds issued in this period: ${pounds(totals.refundsIssuedPence ?? 0)}.` : ''}
          </p>
        </>
      )}
    </div>
  );
}
