import { weightedMarginPercent } from '../../domain/commercial/rules.js';
import { quotedCostFromSnapshot } from '../orders/finance-costing.js';
import { financeRevenueBasis, pharmacyFinanceRecognition } from '../../transport/portal/finance-recognition.js';

/**
 * The pharmacy's financial ledger, derived once.
 *
 * Finance (collected-order realisation) and Overview (settled cash this month)
 * both read these rows so refund, allocation and costing arithmetic stay in one
 * place. They answer different questions on purpose: Overview is cash in the
 * calendar month; Finance is the collected-order ledger.
 */

export type PharmacyLedgerOrder = {
  id: string;
  orderNumber?: string | null;
  patientId?: string | null;
  createdAt: unknown;
  updatedAt?: unknown;
  paidAt?: string | null;
  collectedAt?: string | null;
  cancelledAt?: string | null;
  paymentStatus?: string | null;
  fulfilmentStatus?: string | null;
  status?: string | null;
  resolutionReason?: string | null;
  redoOfId?: string | null;
  totalPence?: number | null;
  medicineTotalPence?: number | null;
  dispensingFeePence?: number | null;
  pharmacyDeliveryPence?: number | null;
  currency?: string | null;
  quoteSnapshot?: unknown;
};

export type PharmacyLedgerRow = ReturnType<typeof buildPharmacyLedgerRows>[number];

export function allocatePatientRevenueAfterRefund(input: {
  productRevenuePence: number;
  pharmacyDeliveryPence: number;
  dispensingFeePence: number;
  refundPence: number;
  fullyRefunded?: boolean;
}) {
  if (input.fullyRefunded) {
    return { productRevenuePence: 0, pharmacyDeliveryPence: 0, dispensingFeePence: 0, patientRevenuePence: 0 };
  }
  const productRevenuePence = Math.max(0, input.productRevenuePence - input.refundPence);
  const deliveryRefundPence = Math.max(0, input.refundPence - input.productRevenuePence);
  const pharmacyDeliveryPence = Math.max(0, input.pharmacyDeliveryPence - deliveryRefundPence);
  const dispensingRefundPence = Math.max(0, deliveryRefundPence - input.pharmacyDeliveryPence);
  const dispensingFeePence = Math.max(0, input.dispensingFeePence - dispensingRefundPence);
  return {
    productRevenuePence,
    pharmacyDeliveryPence,
    dispensingFeePence,
    patientRevenuePence: productRevenuePence + pharmacyDeliveryPence + dispensingFeePence,
  };
}

export function buildPharmacyLedgerRows(input: {
  orders: PharmacyLedgerOrder[];
  patientNameById: Map<string, string>;
  activeAllocationByOrder: Map<string, number>;
  bankWholesalePenceByPackId: Map<string, number>;
}) {
  const { orders, patientNameById, activeAllocationByOrder, bankWholesalePenceByPackId } = input;
  return orders.map(order => {
    const activeAllocationPence = activeAllocationByOrder.get(order.id) ?? 0;
    const replacementLinked = Boolean(order.redoOfId || String(order.resolutionReason || '').toUpperCase() === 'REPLACED');
    const sourceRetainsAllocation = Boolean(order.redoOfId && (activeAllocationByOrder.get(order.redoOfId) ?? 0) > 0);
    const flags = pharmacyFinanceRecognition({ ...order, activeAllocationPence });
    const snapshot = (order.quoteSnapshot ?? {}) as any;
    const quoted = quotedCostFromSnapshot(snapshot, { bankWholesalePenceByPackId });
    const rawLines = snapshot?.lineItems || snapshot?.items || snapshot?.prescriptions?.flatMap((rx: any) => rx.items) || [];
    const lines = Array.isArray(rawLines) ? rawLines.map((item: any) => {
      const qty = Number(item.quantity || item.qty || 1);
      const packId = String(item.productId || item.packId || item.id || '');
      const unitPrice = Number(
        item.unitPricePence ||
        item.retailPence ||
        item.patientPackPricePence ||
        (item.patientPackPrice ? Math.round(Number(item.patientPackPrice) * 100) : 0) ||
        (order.totalPence && qty > 0 ? Math.round((Number(order.totalPence) - Number(order.dispensingFeePence || 0) - Number(order.pharmacyDeliveryPence || 0)) / qty) : 0)
      );
      const wholesaleUnit = quoted.prices.get(packId) ?? null;
      return {
        packId,
        name: String(item.name || item.formulaName || 'Curaleaf item'),
        quantity: qty,
        unitPricePence: unitPrice,
        wholesaleUnitPence: wholesaleUnit,
        productMarginPence: wholesaleUnit === null ? null : (unitPrice - wholesaleUnit) * qty,
      };
    }) : [];

    const revenueBasis = financeRevenueBasis({
      ...order,
      activeAllocationPence,
      replacementLinked,
      sourceRetainsAllocation,
    });
    const grossProductRevenuePence = revenueBasis.productRevenuePence;
    const grossDispensingFeePence = revenueBasis.dispensingFeePence;
    const grossPharmacyDeliveryPence = revenueBasis.pharmacyDeliveryPence;
    const grossPatientRevenuePence = revenueBasis.patientRevenuePence;
    const completedRefundPence = flags.refunded || flags.partialRefund ? flags.refundAmountPence : 0;
    const { productRevenuePence, pharmacyDeliveryPence, dispensingFeePence, patientRevenuePence } = allocatePatientRevenueAfterRefund({
      productRevenuePence: grossProductRevenuePence,
      pharmacyDeliveryPence: grossPharmacyDeliveryPence,
      dispensingFeePence: grossDispensingFeePence,
      refundPence: completedRefundPence,
      fullyRefunded: flags.refunded,
    });
    const wholesaleProductPence = quoted.wholesaleProductPence;
    const shippingPence = quoted.shippingPence;
    const wholesalePence = quoted.wholesalePence;
    const productMarginPence = quoted.wholesaleComplete ? productRevenuePence - wholesaleProductPence! : null;
    // A quote-bank row has no delivery cost, so its contribution is product-only and
    // is labelled an estimate rather than passed off as the frozen paid figure.
    const totalContributionPence = quoted.wholesaleComplete ? patientRevenuePence - wholesalePence! : null;

    const paidEventAt = order.paidAt ? String(order.paidAt) : null;
    const collectedEventAt = order.collectedAt ? String(order.collectedAt) : null;
    const realisedAt = flags.realised
      ? String(collectedEventAt || paidEventAt || order.updatedAt || order.createdAt)
      : null;
    // Finance still periods realised rows on collection; Overview cash events
    // use paidAt / refundedAt instead. Unpaid rows fall back to createdAt.
    const financialEventAt = flags.realised
      ? realisedAt!
      : String(paidEventAt || order.cancelledAt || order.updatedAt || order.createdAt);
    const refundSettledAt = (flags.refunded || flags.partialRefund)
      ? String(flags.refundConfirmedAt || order.cancelledAt || order.updatedAt || '')
      : null;

    return {
      orderId: order.orderNumber || order.id,
      patientId: order.patientId || '',
      patientName: patientNameById.get(order.patientId || '') || 'Patient record',
      createdAt: String(order.createdAt),
      updatedAt: String(order.updatedAt || order.createdAt),
      recognisedAt: realisedAt,
      paidAt: paidEventAt,
      refundedAt: refundSettledAt || null,
      financialEventAt,
      paymentStatus: String(order.paymentStatus).toLowerCase(),
      fulfilmentStatus: String(order.fulfilmentStatus).toLowerCase(),
      recognised: flags.recognised,
      realised: flags.realised,
      pendingCollection: flags.pendingCollection,
      refunded: flags.refunded,
      partialRefund: flags.partialRefund,
      refundAmountPence: completedRefundPence,
      refundPending: flags.refundPending,
      grossPatientRevenuePence,
      grossProductRevenuePence,
      productRevenuePence,
      pharmacyDeliveryPence,
      dispensingFeePence,
      patientRevenuePence,
      packCount: lines.reduce((sum, line) => sum + Math.max(0, Number(line.quantity) || 0), 0),
      wholesaleProductPence,
      shippingPence,
      wholesalePence,
      productMarginPence,
      totalContributionPence,
      wholesaleComplete: quoted.wholesaleComplete,
      wholesaleCostBasis: quoted.costBasis,
      wholesaleEstimated: quoted.costBasis === 'quote_bank',
      shippingKnown: quoted.shippingKnown,
      lines,
    };
  });
}

/** Payment states that mean the pharmacy is still waiting to be paid. */
const AWAITING_PAYMENT_STATUSES = ['pending', 'awaiting_manual_payment', 'awaiting_payment'];
const FAILED_PAYMENT_STATUSES = ['failed', 'none'];

export function isAwaitingPaymentRow(row: { paymentStatus: string }) {
  return AWAITING_PAYMENT_STATUSES.includes(row.paymentStatus);
}

export const OVERVIEW_FINANCE_TIME_ZONE = 'Europe/London';

type LondonClock = { year: number; month: number; day: number; hour: number; minute: number };

function londonClock(instant: Date): LondonClock {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: OVERVIEW_FINANCE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

function londonOffsetMinutes(instant: Date) {
  const clock = londonClock(instant);
  const asUtc = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute);
  return Math.round((asUtc - Math.floor(instant.getTime() / 60000) * 60000) / 60000);
}

function londonWallClockToInstant(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const firstGuess = new Date(naive - londonOffsetMinutes(new Date(naive)) * 60000);
  return new Date(naive - londonOffsetMinutes(firstGuess) * 60000);
}

/**
 * Current calendar month in the pharmacy operating timezone: 00:00 on the 1st
 * through now. A completed month would run through the last millisecond of its
 * final day; Overview always asks for the live month.
 */
function parseLondonDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** Inclusive London calendar dates. `to` runs through the end of that day. */
export function londonDateRangeBounds(from?: string, to?: string, now: number = Date.now()) {
  const clock = londonClock(new Date(now));
  const startDate = (from && parseLondonDate(from)) || { year: clock.year, month: clock.month, day: 1 };
  const endDate = (to && parseLondonDate(to)) || { year: clock.year, month: clock.month, day: clock.day };
  const start = londonWallClockToInstant(startDate.year, startDate.month, startDate.day);
  const following = new Date(Date.UTC(endDate.year, endDate.month - 1, endDate.day + 1));
  const endExclusive = londonWallClockToInstant(following.getUTCFullYear(), following.getUTCMonth() + 1, following.getUTCDate());
  return { startMs: start.getTime(), endMs: endExclusive.getTime() - 1 };
}

export function thisMonthBounds(now: number = Date.now()) {
  const clock = londonClock(new Date(now));
  const periodStart = londonWallClockToInstant(clock.year, clock.month, 1);
  const nextMonth = clock.month === 12
    ? londonWallClockToInstant(clock.year + 1, 1, 1)
    : londonWallClockToInstant(clock.year, clock.month + 1, 1);
  const periodEndMs = Math.min(now, nextMonth.getTime() - 1);
  return {
    timezone: OVERVIEW_FINANCE_TIME_ZONE,
    periodStart: periodStart.toISOString(),
    periodEnd: new Date(periodEndMs).toISOString(),
    startMs: periodStart.getTime(),
    endMs: periodEndMs,
  };
}

function instantInWindow(value: string | null | undefined, startMs: number, endMs: number) {
  const text = String(value || '').trim();
  if (!text) return false;
  const time = Date.parse(text);
  return Number.isFinite(time) && time >= startMs && time <= endMs;
}

function hasSettledPayment(row: { paidAt?: string | null; paymentStatus: string }) {
  if (!String(row.paidAt || '').trim()) return false;
  return !FAILED_PAYMENT_STATUSES.includes(row.paymentStatus);
}

type OverviewFinanceRow = Pick<PharmacyLedgerRow,
  'orderId' | 'patientId' | 'createdAt' | 'paidAt' | 'refundedAt' | 'paymentStatus'
  | 'grossPatientRevenuePence' | 'refundAmountPence' | 'patientRevenuePence'
  | 'wholesalePence' | 'wholesaleComplete'> & {
  grossProductRevenuePence?: number;
  wholesaleProductPence?: number | null;
  packCount?: number;
};

function medicineBasis(row: { grossProductRevenuePence?: number; grossPatientRevenuePence?: number }) {
  if (typeof row.grossProductRevenuePence === 'number') return row.grossProductRevenuePence;
  return Number(row.grossPatientRevenuePence || 0);
}

function productWholesale(row: { wholesaleComplete?: boolean; wholesaleProductPence?: number | null; wholesalePence?: number | null }) {
  if (!row.wholesaleComplete) return null;
  if (typeof row.wholesaleProductPence === 'number') return row.wholesaleProductPence;
  return row.wholesalePence == null ? null : Number(row.wholesalePence);
}

/**
 * Settled-cash headline for any window. Payments count on paidAt, refunds on
 * refundedAt, and a refund never restates the month it was earned in.
 * Gross profit is medicines after discount, less wholesale excluding VAT.
 * Delivery is in revenue and out of gross profit.
 */
export function settlementFinanceSnapshot(rows: OverviewFinanceRow[], startMs: number, endMs: number) {
  const payments = rows.filter(row => hasSettledPayment(row) && instantInWindow(row.paidAt, startMs, endMs));
  const refunds = rows.filter(row => Number(row.refundAmountPence || 0) > 0 && instantInWindow(row.refundedAt, startMs, endMs));
  const awaitingPayment = rows.filter(row => (
    isAwaitingPaymentRow(row) && instantInWindow(row.createdAt, startMs, endMs)
  ));

  const paymentPence = payments.reduce((sum, row) => sum + Number(row.grossPatientRevenuePence || 0), 0);
  const refundPence = refunds.reduce((sum, row) => sum + Number(row.refundAmountPence || 0), 0);
  const revenuePence = paymentPence - refundPence;

  const paymentMedicine = payments.reduce((sum, row) => sum + medicineBasis(row), 0);
  const refundMedicine = refunds.reduce((sum, row) => sum + Math.min(Number(row.refundAmountPence || 0), medicineBasis(row)), 0);
  const medicineRevenuePence = paymentMedicine - refundMedicine;
  const costedPayments = payments.filter(row => productWholesale(row) != null);
  const wholesaleProductPence = costedPayments.reduce((sum, row) => sum + Number(productWholesale(row) || 0), 0);
  const grossProfitPence = medicineRevenuePence - wholesaleProductPence;
  const packCount = payments.reduce((sum, row) => sum + Math.max(0, Number(row.packCount) || 0), 0);

  const netByPatient = new Map<string, number>();
  for (const row of payments) {
    const key = String(row.patientId || '').trim() || `order:${row.orderId}`;
    netByPatient.set(key, (netByPatient.get(key) ?? 0) + Number(row.grossPatientRevenuePence || 0));
  }
  for (const row of refunds) {
    const key = String(row.patientId || '').trim() || `order:${row.orderId}`;
    netByPatient.set(key, (netByPatient.get(key) ?? 0) - Number(row.refundAmountPence || 0));
  }
  const payingNets = [...netByPatient.values()].filter(net => net > 0);
  const payingPatientCount = payingNets.length;
  const payingSpendPence = payingNets.reduce((sum, net) => sum + net, 0);
  const averageSpendPence = payingPatientCount === 0 ? 0 : Math.round(payingSpendPence / payingPatientCount);
  const averageGrossProfitPerPatientPence = payingPatientCount === 0 ? 0 : Math.round(grossProfitPence / payingPatientCount);

  return {
    revenuePence,
    revenueOrderCount: payments.length,
    medicineRevenuePence,
    grossProfitPence,
    marginPercent: weightedMarginPercent(grossProfitPence, medicineRevenuePence),
    grossProfitComplete: costedPayments.length === payments.length,
    costedOrderCount: costedPayments.length,
    averageSpendPence,
    averageRevenuePerPatientPence: averageSpendPence,
    averageGrossProfitPerPatientPence,
    packCount,
    averageItemPricePence: packCount === 0 ? 0 : Math.round(medicineRevenuePence / packCount),
    averageGrossProfitPerItemPence: packCount === 0 ? 0 : Math.round(grossProfitPence / packCount),
    payingPatientCount,
    awaitingPaymentCount: awaitingPayment.length,
    awaitingPaymentValuePence: awaitingPayment.reduce((sum, row) => sum + Number(row.patientRevenuePence || row.grossPatientRevenuePence || 0), 0),
    refundPence,
  };
}

function percentChange(current: number, previous: number) {
  if (!(previous > 0)) return null;
  return Math.round(((current - previous) / previous) * 100);
}

/** Days 1–N of the previous calendar month, matching the clock time of `now`. */
export function previousMonthLikeForLikeBounds(now: number = Date.now()) {
  const clock = londonClock(new Date(now));
  const prevMonth = clock.month === 1 ? 12 : clock.month - 1;
  const prevYear = clock.month === 1 ? clock.year - 1 : clock.year;
  const lastDay = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();
  const day = Math.min(clock.day, lastDay);
  const start = londonWallClockToInstant(prevYear, prevMonth, 1);
  const end = londonWallClockToInstant(prevYear, prevMonth, day, clock.hour, clock.minute);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

function monthKey(instantMs: number) {
  const clock = londonClock(new Date(instantMs));
  return `${clock.year}-${String(clock.month).padStart(2, '0')}`;
}

/**
 * Overview money headline: settled cash this calendar month.
 *
 * Payments count on paidAt, refunds on refundedAt, unpaid links stay outstanding.
 * Collection is not a gate. Wholesale is taken only for orders whose payment
 * landed in the window, and missing cost never counts as £0.
 */
export function overviewFinanceSnapshot(
  rows: OverviewFinanceRow[],
  now: number = Date.now(),
) {
  const bounds = thisMonthBounds(now);
  const current = settlementFinanceSnapshot(rows, bounds.startMs, bounds.endMs);
  const priorBounds = previousMonthLikeForLikeBounds(now);
  const prior = settlementFinanceSnapshot(rows, priorBounds.startMs, priorBounds.endMs);
  const thisKey = monthKey(now);
  const byMonth = new Map<string, number>();
  for (const row of rows) {
    if (!hasSettledPayment(row) || !row.paidAt) continue;
    const paid = Date.parse(row.paidAt);
    if (!Number.isFinite(paid)) continue;
    const key = monthKey(paid);
    byMonth.set(key, (byMonth.get(key) ?? 0) + Number(row.grossPatientRevenuePence || 0));
  }
  const bestPrior = [...byMonth.entries()]
    .filter(([key]) => key < thisKey)
    .reduce((best, [, value]) => Math.max(best, value), 0);
  const hadPriorMonth = [...byMonth.keys()].some(key => key < thisKey);

  return {
    period: 'this_month' as const,
    timezone: bounds.timezone,
    periodStart: bounds.periodStart,
    periodEnd: bounds.periodEnd,
    ...current,
    comparison: {
      revenuePercent: percentChange(current.revenuePence, prior.revenuePence),
      grossProfitPercent: percentChange(current.grossProfitPence, prior.grossProfitPence),
      averageRevenuePercent: percentChange(current.averageRevenuePerPatientPence, prior.averageRevenuePerPatientPence),
    },
    recordRevenueMonth: hadPriorMonth && current.revenuePence > bestPrior,
  };
}
