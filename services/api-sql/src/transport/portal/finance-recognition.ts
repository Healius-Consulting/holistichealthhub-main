function snapshotObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Paid orders realise only after collection. Open refunds still drop out. */
export function pharmacyFinanceRecognition(order: {
  paymentStatus?: string | null;
  status?: string | null;
  fulfilmentStatus?: string | null;
  paidAt?: string | null;
  totalPence?: number | null;
  resolutionReason?: string | null;
  activeAllocationPence?: number | null;
  quoteSnapshot?: unknown;
}) {
  const payment = String(order.paymentStatus || '').toUpperCase();
  const status = String(order.status || '').toUpperCase();
  const fulfilment = String(order.fulfilmentStatus || '').toUpperCase();
  const refund = snapshotObject(snapshotObject(order.quoteSnapshot).refund);
  const refundStatus = String(refund.status || '').toLowerCase();
  const refundAmountPence = Math.max(0, Number(refund.amountPence || 0));
  const orderTotalPence = Math.max(0, Number(order.totalPence || 0));
  const partialRefund = refundStatus === 'completed'
    && refundAmountPence > 0
    && orderTotalPence > 0
    && refundAmountPence < orderTotalPence;
  const paidOnce = payment === 'PAID' || Boolean(order.paidAt);
  const suppliedReplacementRemainder = String(order.resolutionReason || '').toUpperCase() === 'REPLACED'
    && Math.max(0, Number(order.activeAllocationPence || 0)) > 0;
  const refunded =
    (refundStatus === 'completed' && !partialRefund)
    || payment === 'REFUNDED'
    || status === 'REFUNDED'
    || status === 'CANCELLED_REFUNDED'
    || (paidOnce && payment === 'CANCELLED');
  const refundPending = paidOnce && !refunded && !suppliedReplacementRemainder && refundStatus !== 'completed' && (
    refundStatus === 'pending_confirmation'
    || payment === 'REFUND_REQUIRED'
    || status === 'CANCELLED'
  );
  const retained = paidOnce && !refunded && !refundPending;
  const collected = fulfilment === 'COLLECTED';
  const realised = retained && collected;
  const pendingCollection = retained && !collected;
  return {
    recognised: realised,
    realised,
    pendingCollection,
    refunded,
    partialRefund,
    refundAmountPence,
    refundPending,
    refundConfirmedAt: typeof refund.confirmedAt === 'string' ? refund.confirmedAt : null,
  };
}

export function financeRevenueBasis(input: {
  medicineTotalPence?: number | null;
  dispensingFeePence?: number | null;
  totalPence?: number | null;
  activeAllocationPence?: number | null;
  replacementLinked: boolean;
  sourceRetainsAllocation?: boolean;
}) {
  const grossFee = Math.max(0, Number(input.dispensingFeePence || 0));
  const grossMedicine = Math.max(0, Number(input.medicineTotalPence
    || (Number(input.totalPence || 0) - grossFee)));
  const grossTotal = Math.max(0, Number(input.totalPence || (grossMedicine + grossFee)));
  if (!input.replacementLinked) {
    return { patientRevenuePence: grossTotal, productRevenuePence: grossMedicine, dispensingFeePence: grossFee };
  }
  const patientRevenuePence = Math.max(0, Number(input.activeAllocationPence || 0));
  const dispensingFeePence = input.sourceRetainsAllocation ? 0 : Math.min(grossFee, patientRevenuePence);
  return {
    patientRevenuePence,
    productRevenuePence: Math.max(0, patientRevenuePence - dispensingFeePence),
    dispensingFeePence,
  };
}
