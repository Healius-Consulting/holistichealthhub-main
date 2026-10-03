/** Client copy of the commercial rules. Keep in step with services/api-sql/src/domain/commercial/rules.ts. */

export const MAX_PRICE_UPLIFT_PCT = 0.1;
export const INACTIVE_AFTER_MS = 56 * 24 * 60 * 60 * 1000;

export function maxPatientPricePence(rrpPence: number) {
  return Math.round(Math.max(0, Math.round(rrpPence)) * (1 + MAX_PRICE_UPLIFT_PCT));
}

export function linePriceError(pricePence: number, rrpPence: number, wholesalePence: number) {
  const price = Math.round(pricePence);
  const floor = Math.max(0, Math.round(wholesalePence));
  const cap = maxPatientPricePence(rrpPence);
  if (price > cap) return 'Price cannot exceed the catalogue price by more than 10%.';
  if (price < floor) return 'Price cannot be below wholesale cost.';
  return null;
}

/** Pound steps offered beside a patient price. The bounds stay linePriceError's. */
export const PATIENT_PRICE_NUDGE_POUNDS = [1, 5, 10] as const;

/**
 * Move a patient price by whole pounds, then stop on the same floor and cap
 * linePriceError already enforces. A step never invents a wider band.
 */
export function nudgePatientPricePence(currentPence: number, deltaPounds: number, rrpPence: number, wholesalePence: number) {
  const next = Math.round(currentPence) + Math.round(deltaPounds) * 100;
  const floor = Math.max(0, Math.round(wholesalePence));
  const cap = maxPatientPricePence(rrpPence);
  return Math.min(cap, Math.max(floor, next));
}

export function prefillPatientPricePence(savedPence: number | null, rrpPence: number, wholesalePence: number) {
  const cap = maxPatientPricePence(rrpPence);
  const floor = Math.max(0, Math.round(wholesalePence));
  const base = savedPence == null ? Math.round(rrpPence) : Math.round(savedPence);
  return Math.min(cap, Math.max(floor, base));
}

export function discountPence(medicinesPence: number, discount: { mode: 'amount' | 'percent'; amount: number } | null | undefined) {
  const medicines = Math.max(0, Math.round(medicinesPence));
  if (!discount || !(discount.amount > 0)) return 0;
  if (discount.mode === 'percent') return Math.min(medicines, Math.round((medicines * Math.min(100, discount.amount)) / 100));
  return Math.min(medicines, Math.round(discount.amount));
}

export function discountFloorError(medicinesPence: number, discountAmount: number, wholesalePence: number) {
  if (Math.max(0, medicinesPence) - Math.max(0, discountAmount) < Math.max(0, wholesalePence)) {
    return 'Discount would take medicines below wholesale cost.';
  }
  return null;
}

export function basketMarginTone(marginPct: number | null): 'is-good' | 'is-amber' | 'is-muted' | '' {
  if (marginPct === null || !Number.isFinite(marginPct)) return '';
  if (marginPct >= 25) return 'is-good';
  if (marginPct >= 15) return 'is-amber';
  return 'is-muted';
}

export function formatGlanceMargin(profitPounds: number, medicinePounds: number) {
  if (!(medicinePounds > 0)) return `£${profitPounds.toFixed(2)}`;
  const percent = Math.round((profitPounds / medicinePounds) * 1000) / 10;
  const label = Number.isInteger(percent) ? String(percent) : percent.toFixed(1);
  return `£${profitPounds.toFixed(2)} · ${label}% margin`;
}

export function patientTotalBreakdown(medicinePounds: number, discountPounds: number, deliveryPounds: number) {
  const parts = [`£${medicinePounds.toFixed(2)} medicines`];
  if (discountPounds > 0) parts.push(`− £${discountPounds.toFixed(2)} discount`);
  if (deliveryPounds > 0) parts.push(`+ £${deliveryPounds.toFixed(2)} delivery`);
  return parts.join(' ');
}

export type CommercialStatus = 'Referred' | 'Active' | 'Inactive' | 'Declined';

export function commercialPatientStatus(input: {
  declined: boolean;
  referred: boolean;
  submittedToCuraleaf: boolean;
  lastPaidAt: number | null;
  submittedAfterLastPayment: boolean;
  now?: number;
}): CommercialStatus {
  if (input.declined) return 'Declined';
  const now = input.now ?? Date.now();
  if (input.submittedToCuraleaf) {
    const lapsed = input.lastPaidAt != null && now >= input.lastPaidAt + INACTIVE_AFTER_MS && !input.submittedAfterLastPayment;
    return lapsed ? 'Inactive' : 'Active';
  }
  return input.referred ? 'Referred' : 'Declined';
}

export type RetentionWindowSettings = {
  w2StartDay: number;
  w2EndDay: number;
  quarterlyEveryDays: number;
  quarterlyToleranceDays: number;
};

export const DEFAULT_RETENTION_WINDOWS: RetentionWindowSettings = {
  w2StartDay: 21,
  w2EndDay: 60,
  quarterlyEveryDays: 90,
  quarterlyToleranceDays: 30,
};

export type RetentionStatus = 'On track' | 'At risk' | 'Qualified';

export function inferRetention(input: {
  periodStart: string;
  prescriptionDates: string[];
  asOf: string;
  settings?: RetentionWindowSettings;
}): { status: RetentionStatus; met: string[] } {
  const settings = input.settings ?? DEFAULT_RETENTION_WINDOWS;
  const windows = [
    { id: 'W1', startDay: 0, endDay: Math.max(0, settings.w2StartDay - 1) },
    { id: 'W2', startDay: settings.w2StartDay, endDay: settings.w2EndDay },
  ];
  for (let step = 1; step <= 3; step += 1) {
    const center = settings.w2StartDay + step * settings.quarterlyEveryDays;
    windows.push({ id: `W${step + 2}`, startDay: center - settings.quarterlyToleranceDays, endDay: center + settings.quarterlyToleranceDays });
  }
  const dayNumber = (fromIso: string, toIso: string) => {
    const from = Date.parse(fromIso);
    const to = Date.parse(toIso);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
    return Math.floor((to - from) / 86_400_000);
  };
  const asOfDay = dayNumber(input.periodStart, input.asOf) ?? 0;
  const met = new Set<string>();
  for (const date of input.prescriptionDates) {
    const day = dayNumber(input.periodStart, date);
    if (day == null || day < 0) continue;
    const window = windows.find(item => day >= item.startDay && day <= item.endDay);
    if (window) met.add(window.id);
  }
  const missed = windows.some(window => asOfDay > window.endDay && !met.has(window.id));
  const status: RetentionStatus = met.size >= 3 ? 'Qualified' : missed ? 'At risk' : 'On track';
  return { status, met: [...met] };
}
