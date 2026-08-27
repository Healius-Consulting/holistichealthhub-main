import { quotedCostFromSnapshot } from '../orders/finance-costing.js';
import { financeRevenueBasis, pharmacyFinanceRecognition } from '../../transport/portal/finance-recognition.js';

/**
 * The pharmacy's financial ledger, derived once.
 *
 * Finance and the Overview's thirty-day snapshot both need "what has this
 * pharmacy actually earned", and they have to agree to the penny — a headline
 * on Overview that disagrees with the page it links to destroys trust in both.
 * So there is exactly one implementation of the realisation, refund and costing
 * rules and both surfaces read its rows.
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
  currency?: string | null;
  quoteSnapshot?: unknown;
};

export type PharmacyLedgerRow = ReturnType<typeof buildPharmacyLedgerRows>[number];

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
        (order.totalPence && qty > 0 ? Math.round((Number(order.totalPence) - Number(order.dispensingFeePence || 0)) / qty) : 0)
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
    const grossPatientRevenuePence = revenueBasis.patientRevenuePence;
    const completedRefundPence = flags.refunded || flags.partialRefund ? flags.refundAmountPence : 0;
    const dispensingFeePence = flags.refunded ? 0 : grossDispensingFeePence;
    const productRevenuePence = flags.refunded ? 0 : Math.max(0, grossProductRevenuePence - completedRefundPence);
    const patientRevenuePence = Math.max(0, grossPatientRevenuePence - completedRefundPence);
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
    // Realised rows period on collection; pending on payment; exclusions on payment/cancel.
    const financialEventAt = flags.realised
      ? realisedAt!
      : String(paidEventAt || order.cancelledAt || order.updatedAt || order.createdAt);

    return {
      orderId: order.orderNumber || order.id,
      patientId: order.patientId || '',
      patientName: patientNameById.get(order.patientId || '') || 'Patient record',
      createdAt: String(order.createdAt),
      updatedAt: String(order.updatedAt || order.createdAt),
      recognisedAt: realisedAt,
      refundedAt: flags.refunded ? String(flags.refundConfirmedAt || order.cancelledAt || order.updatedAt) : null,
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
      productRevenuePence,
      dispensingFeePence,
      patientRevenuePence,
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

export function isAwaitingPaymentRow(row: { paymentStatus: string }) {
  return AWAITING_PAYMENT_STATUSES.includes(row.paymentStatus);
}

export const OVERVIEW_FINANCE_PERIOD_DAYS = 30;

/**
 * The thirty-day money headline for the Overview.
 *
 * Same rows, same rules, same arithmetic as the Finance page — this only
 * chooses the window and the handful of figures worth a headline. Contribution
 * is summed over costed rows only, and `contributionComplete` says whether every
 * realised order in the window had a wholesale cost to work from, so the number
 * is never presented as more complete than it is.
 */
export function overviewFinanceSnapshot(
  rows: Array<Pick<PharmacyLedgerRow,
    'financialEventAt' | 'realised' | 'pendingCollection' | 'patientRevenuePence'
    | 'totalContributionPence' | 'wholesaleComplete' | 'paymentStatus'>>,
  now: number = Date.now(),
) {
  const since = new Date(now - OVERVIEW_FINANCE_PERIOD_DAYS * 86_400_000).toISOString().slice(0, 10);
  const inWindow = rows.filter(row => Boolean(row.financialEventAt) && row.financialEventAt.slice(0, 10) >= since);

  const realised = inWindow.filter(row => row.realised);
  const pendingCollection = inWindow.filter(row => row.pendingCollection);
  const awaitingPayment = inWindow.filter(isAwaitingPaymentRow);
  const costed = realised.filter(row => row.wholesaleComplete);

  return {
    period: '30d' as const,
    periodDays: OVERVIEW_FINANCE_PERIOD_DAYS,
    since: `${since}T00:00:00.000Z`,
    realisedPatientRevenuePence: realised.reduce((sum, row) => sum + row.patientRevenuePence, 0),
    realisedCount: realised.length,
    pendingCollectionCount: pendingCollection.length,
    pendingPatientRevenuePence: pendingCollection.reduce((sum, row) => sum + row.patientRevenuePence, 0),
    contributionPence: costed.reduce((sum, row) => sum + (row.totalContributionPence ?? 0), 0),
    // False when some realised orders in the window have no wholesale cost yet.
    contributionComplete: costed.length === realised.length,
    awaitingPaymentCount: awaitingPayment.length,
    awaitingPaymentValuePence: awaitingPayment.reduce((sum, row) => sum + row.patientRevenuePence, 0),
  };
}
