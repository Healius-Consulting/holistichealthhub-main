/**
 * Commercial rules from the 27 Sep 2026 pharmacy pack.
 * Patient status, line prices, discounts and medicines-only margin live here
 * so Overview, Financials and Create order cannot drift apart.
 */

export const MAX_PRICE_UPLIFT_PCT = 0.10;
export const INACTIVE_AFTER_MS = 56 * 24 * 60 * 60 * 1000;

export type DiscountMode = 'amount' | 'percent';

export function maxPatientPricePence(rrpPence: number, upliftPct = MAX_PRICE_UPLIFT_PCT) {
  const rrp = Math.max(0, Math.round(rrpPence));
  return Math.round(rrp * (1 + upliftPct));
}

/** Null when the price is inside the cap and the wholesale floor. */
export function linePriceError(pricePence: number, rrpPence: number, wholesalePence: number, upliftPct = MAX_PRICE_UPLIFT_PCT) {
  const price = Math.round(pricePence);
  const floor = Math.max(0, Math.round(wholesalePence));
  const cap = maxPatientPricePence(rrpPence, upliftPct);
  if (price > cap) return 'Price cannot exceed the catalogue price by more than 10%.';
  if (price < floor) return 'Price cannot be below wholesale cost.';
  return null;
}

/**
 * Last charged price, never above the current cap. A risen RRP does not lift
 * the saved price. A fallen RRP pulls a saved price down to the new cap.
 */
export function prefillPatientPricePence(input: {
  savedPence: number | null;
  rrpPence: number;
  wholesalePence: number;
  upliftPct?: number;
}) {
  const cap = maxPatientPricePence(input.rrpPence, input.upliftPct);
  const floor = Math.max(0, Math.round(input.wholesalePence));
  const base = input.savedPence == null ? Math.round(input.rrpPence) : Math.round(input.savedPence);
  return Math.min(cap, Math.max(floor, base));
}

export function discountFromInput(medicinesPence: number, input: { mode: DiscountMode; amountPence?: number; percent?: number }) {
  const medicines = Math.max(0, Math.round(medicinesPence));
  if (input.mode === 'percent') {
    const percent = Number(input.percent ?? 0);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
    return Math.round((medicines * percent) / 100);
  }
  const amount = Math.round(input.amountPence ?? 0);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.min(medicines, amount);
}

export function discountFloorError(medicinesPence: number, discountPence: number, wholesalePence: number) {
  const net = Math.max(0, Math.round(medicinesPence)) - Math.max(0, Math.round(discountPence));
  if (net < Math.max(0, Math.round(wholesalePence))) return 'Discount would take medicines below wholesale cost.';
  return null;
}

/** Share of an order discount that belongs to the refunded lines, by price. */
export function proportionalDiscountShare(linePricePence: number, medicinesSubtotalPence: number, discountPence: number) {
  const subtotal = Math.max(0, Math.round(medicinesSubtotalPence));
  const discount = Math.max(0, Math.round(discountPence));
  if (subtotal <= 0 || discount <= 0) return 0;
  return Math.round((Math.max(0, Math.round(linePricePence)) / subtotal) * discount);
}

export function medicinesGrossProfitPence(medicineRevenuePence: number, wholesaleExVatPence: number) {
  return Math.round(medicineRevenuePence) - Math.round(wholesaleExVatPence);
}

/** Null when there is no medicine revenue to divide by. Not an average of order percentages. */
export function weightedMarginPercent(grossProfitPence: number, medicineRevenuePence: number) {
  if (!(medicineRevenuePence > 0)) return null;
  return Math.round((grossProfitPence / medicineRevenuePence) * 1000) / 10;
}

export function applyStaffLinePrices<T extends { packId: string; quantity: number; unitPricePence?: number }>(input: {
  lines: T[];
  quoteItems: Array<{ packId: string; patientPence: number; wholesalePence: number }>;
  discountPence: number;
  pharmacyDeliveryPence: number;
}): { error: string } | { lines: T[]; medicineTotalPence: number; totalPence: number; discountPence: number; wholesalePence: number } {
  let grossMedicine = 0;
  let wholesale = 0;
  const lines = input.lines.map(line => {
    const quote = input.quoteItems.find(item => item.packId === line.packId);
    if (!quote) return line;
    const price = line.unitPricePence && line.unitPricePence > 0 ? line.unitPricePence : quote.patientPence;
    grossMedicine += price * line.quantity;
    wholesale += quote.wholesalePence * line.quantity;
    return { ...line, unitPricePence: price };
  });
  for (const line of lines) {
    const quote = input.quoteItems.find(item => item.packId === line.packId);
    if (!quote || !line.unitPricePence) continue;
    const error = linePriceError(line.unitPricePence, quote.patientPence, quote.wholesalePence);
    if (error) return { error };
  }
  const discount = Math.max(0, Math.round(input.discountPence));
  const floor = discountFloorError(grossMedicine, discount, wholesale);
  if (floor) return { error: floor };
  const medicineTotalPence = grossMedicine - discount;
  return {
    lines,
    medicineTotalPence,
    discountPence: discount,
    wholesalePence: wholesale,
    totalPence: medicineTotalPence + Math.max(0, Math.round(input.pharmacyDeliveryPence)),
  };
}

export function patientTotalPence(medicinePence: number, discountPence: number, deliveryPence: number) {
  return Math.max(0, Math.round(medicinePence) - Math.max(0, Math.round(discountPence))) + Math.max(0, Math.round(deliveryPence));
}

export function inactiveFromLastPayment(lastPaidAt: string | null | undefined, asOf: Date) {
  if (!lastPaidAt) return false;
  const paid = Date.parse(lastPaidAt);
  if (!Number.isFinite(paid)) return false;
  return asOf.getTime() >= paid + INACTIVE_AFTER_MS;
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

export type RetentionWindowId = 'W1' | 'W2' | 'W3' | 'W4' | 'W5';

export function retentionWindows(settings: RetentionWindowSettings = DEFAULT_RETENTION_WINDOWS) {
  const windows: Array<{ id: RetentionWindowId; startDay: number; endDay: number }> = [
    { id: 'W1', startDay: 0, endDay: Math.max(0, settings.w2StartDay - 1) },
    { id: 'W2', startDay: settings.w2StartDay, endDay: settings.w2EndDay },
  ];
  for (let step = 1; step <= 3; step += 1) {
    const center = settings.w2StartDay + step * settings.quarterlyEveryDays;
    const tolerance = settings.quarterlyToleranceDays;
    windows.push({
      id: `W${step + 2}` as RetentionWindowId,
      startDay: center - tolerance,
      endDay: center + tolerance,
    });
  }
  return windows;
}

function dayNumber(fromIso: string, toIso: string) {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.floor((to - from) / (24 * 60 * 60 * 1000));
}

/**
 * Infer at most one appointment per window. Qualified once three windows are met.
 * A closed window with no prescription is At risk. Cadence is not a displayed date.
 */
export function inferRetention(input: {
  periodStart: string;
  prescriptionDates: string[];
  asOf: string;
  settings?: RetentionWindowSettings;
}): { status: RetentionStatus; met: RetentionWindowId[]; periodStart: string } {
  const settings = input.settings ?? DEFAULT_RETENTION_WINDOWS;
  const windows = retentionWindows(settings);
  const asOfDay = dayNumber(input.periodStart, input.asOf) ?? 0;
  const met = new Set<RetentionWindowId>();
  for (const date of input.prescriptionDates) {
    const day = dayNumber(input.periodStart, date);
    if (day == null || day < 0) continue;
    const window = windows.find(item => day >= item.startDay && day <= item.endDay);
    if (window) met.add(window.id);
  }
  const missed = windows.some(window => asOfDay > window.endDay && !met.has(window.id));
  const status: RetentionStatus = met.size >= 3 ? 'Qualified' : missed ? 'At risk' : 'On track';
  return { status, met: [...met], periodStart: input.periodStart };
}
