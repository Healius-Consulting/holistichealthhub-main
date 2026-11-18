import type { ReactNode } from 'react';
import type { PharmacyTenant } from '../../context/AppContext';
import { formatRequestDate } from './requestFormat';
import type { PerformancePeriod } from '../../utils/performancePeriod';

/**
 * The pharmacy record's Summary tab: what state the account is in and what is
 * left to do (Account), then how it is doing (Performance). Each account row
 * reads label, state, one line of why, and the action that changes it.
 */

export type Tone = 'ok' | 'wait' | 'off' | 'stop';

type AccountRow = {
  label: string;
  value: string;
  tone: Tone;
  detail: string;
  action?: { label: string; onClick: () => void };
};

function activationState(organisation: PharmacyTenant, testPharmacy: boolean): { value: string; tone: Tone; detail: string } {
  if (testPharmacy) return { value: 'Test pharmacy', tone: 'ok', detail: 'Always on, against the Curaleaf and Worldpay sandboxes.' };
  if (organisation.status === 'paused') return { value: 'Suspended', tone: 'stop', detail: 'Staff are locked out and the eligibility link is off until HHH lifts the suspension.' };
  if (organisation.status === 'live') return { value: 'Live', tone: 'ok', detail: 'Live Curaleaf credentials are saved. Patients, orders and payments are real.' };
  return { value: 'Awaiting Curaleaf', tone: 'wait', detail: 'Eligibility is open; ordering and payments open when live Curaleaf credentials are saved, which takes it live.' };
}

function curaleafRow(organisation: PharmacyTenant, testPharmacy: boolean, openCuraleaf: () => void): AccountRow {
  const code = organisation.curaleafPharmacyCode;
  if (organisation.curaleafEnvironment === 'production' && code) {
    return { label: 'Curaleaf', value: 'Live', tone: 'ok', detail: `PHAR code ${code}`, action: { label: 'Manage', onClick: openCuraleaf } };
  }
  if (code) {
    return {
      label: 'Curaleaf',
      value: 'Test',
      tone: testPharmacy ? 'ok' : 'wait',
      detail: testPharmacy ? `Sandbox account ${code}` : `Connected to Curaleaf's test estate (${code}). Replace with live credentials to go live.`,
      action: { label: testPharmacy ? 'Manage' : 'Add live credentials', onClick: openCuraleaf },
    };
  }
  return { label: 'Curaleaf', value: 'Not connected', tone: 'wait', detail: 'Waiting for Curaleaf to send the PHAR code and API key.', action: { label: 'Enter credentials', onClick: openCuraleaf } };
}

function worldpayRow(organisation: PharmacyTenant, formSentAt: string | null, testPharmacy: boolean): AccountRow {
  const form = testPharmacy ? '' : formSentAt ? ` Form sent ${formatRequestDate(formSentAt)}.` : ' Form not sent yet.';
  if (organisation.worldpayState === 'live') return { label: 'Worldpay', value: 'Live', tone: 'ok', detail: `Card payment links are live.${form}` };
  if (organisation.worldpayState === 'test') return { label: 'Worldpay', value: 'Test', tone: 'wait', detail: `Sandbox merchant only.${form}` };
  return { label: 'Worldpay', value: 'Not connected', tone: 'off', detail: `Payments are taken manually until a merchant is connected.${form}` };
}

function Row({ row }: { row: AccountRow }) {
  return (
    <li className="pharmacy-summary__row">
      <span className="pharmacy-summary__label">{row.label}</span>
      <span className="pharmacy-summary__value">
        <span className={`pharmacy-summary__state is-${row.tone}`}>{row.value}</span>
        <small>{row.detail}</small>
      </span>
      {row.action ? <button type="button" className="btn btn-sm" onClick={row.action.onClick}>{row.action.label}</button> : <span aria-hidden="true" />}
    </li>
  );
}


const PERIODS: Array<{ id: PerformancePeriod; label: string; title: string }> = [
  { id: '1m', label: '1M', title: 'Last month' },
  { id: '3m', label: '3M', title: 'Last 3 months' },
  { id: 'all', label: 'All', title: 'Since joining' },
];


function Metric({ label, value, detail }: { label: string; value: ReactNode; detail: string }) {
  return (
    <div className="pharmacy-summary__metric">
      <small>{label}</small>
      <strong>{value}</strong>
      <span>{detail}</span>
    </div>
  );
}

export function PharmacySummary({
  organisation,
  testPharmacy,
  intakeLive,
  worldpayFormSentAt,
  patients,
  fees,
  feesReady,
  formatMoney,
  onOpenPanel,
  period,
  onPeriodChange,
}: {
  organisation: PharmacyTenant;
  testPharmacy: boolean;
  intakeLive: boolean;
  worldpayFormSentAt: string | null;
  patients: { inCare: number | null; inCareLabel: string; declined: number | null; note: string | null; status: 'ready' | 'loading' | 'error' };
  fees: { total: number; firstAmount: number; firstCount: number; annualAmount: number; annualCount: number; patients: number } | null;
  feesReady: boolean;
  formatMoney: (amount: number) => string;
  onOpenPanel: (panel: 'curaleaf' | 'staff' | 'identity') => void;
  period: PerformancePeriod;
  onPeriodChange: (period: PerformancePeriod) => void;
}) {
  const windowed = period !== 'all';
  const windowLabel = period === '1m' ? 'last month' : 'last 3 months';
  const activation = activationState(organisation, testPharmacy);
  const rows: AccountRow[] = [
    { label: 'Activation', ...activation },
    curaleafRow(organisation, testPharmacy, () => onOpenPanel('curaleaf')),
    {
      label: 'Eligibility link',
      value: intakeLive ? 'On' : 'Off',
      tone: intakeLive ? 'ok' : 'off',
      detail: intakeLive
        ? 'Patients can check eligibility through the pharmacy link and QR code.'
        : organisation.status === 'paused' ? 'Off while the pharmacy is suspended.' : 'Off for this pharmacy.',
    },
    worldpayRow(organisation, worldpayFormSentAt, testPharmacy),
  ];
  const pending = (value: number | null) => (value == null ? (patients.status === 'error' ? '—' : '…') : value);
  const money = (amount: number | undefined) => (feesReady ? formatMoney(amount ?? 0) : '…');

  return (
    <div className="pharmacy-summary">
      <section className="pharmacy-summary__card" aria-labelledby="pharmacy-summary-account">
        <header>
          <h3 id="pharmacy-summary-account">Account</h3>
          <span className={`pharmacy-summary__state is-${activation.tone}`}>{activation.value}</span>
        </header>
        <ul>{rows.map(row => <Row key={row.label} row={row} />)}</ul>
      </section>

      <section className="pharmacy-summary__card" aria-labelledby="pharmacy-summary-performance">
        <header>
          <h3 id="pharmacy-summary-performance">Performance</h3>
          <div className="pharmacy-summary__period" role="radiogroup" aria-label="Performance period">
            {PERIODS.map(option => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={period === option.id}
                title={option.title}
                className={period === option.id ? 'is-active' : undefined}
                onClick={() => onPeriodChange(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </header>
        <div className="pharmacy-summary__group">
          <h4 id="pharmacy-summary-patients">Patients</h4>
          <div className="pharmacy-summary__metrics is-patients" aria-labelledby="pharmacy-summary-patients">
            <Metric label="Attributed" value={pending(patients.inCare)} detail={windowed ? `Active in the ${windowLabel}` : patients.inCareLabel} />
            <Metric label="Declined" value={pending(patients.declined)} detail={windowed ? `Closed in the ${windowLabel}` : patients.note || 'Not eligible or withdrew'} />
          </div>
        </div>
        <div className="pharmacy-summary__group">
          <h4 id="pharmacy-summary-revenue">Revenue</h4>
          <div className="pharmacy-summary__metrics is-revenue" aria-labelledby="pharmacy-summary-revenue">
            <Metric label="Referral fees" value={money(fees?.total)} detail={fees?.patients ? `${fees.patients} earning patient${fees.patients === 1 ? '' : 's'}` : 'None'} />
            <Metric label="First dispenses" value={money(fees?.firstAmount)} detail={`${fees?.firstCount ?? 0} × £50`} />
            <Metric label="Annual fees" value={money(fees?.annualAmount)} detail={`${fees?.annualCount ?? 0} × £40`} />
          </div>
        </div>
        <p className="pharmacy-summary__note">Fees accrue on the first collected dispense (£50) and each active anniversary (£40). This is an operational ledger, not an invoice.</p>
      </section>
    </div>
  );
}
