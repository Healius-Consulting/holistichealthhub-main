export type PublicPaymentReceiptBody = {
  id: string;
  amountPence: number;
  currency: string;
  status: string;
  createdAt: string;
  updatedAt?: string | null;
  orderNumber?: string | null;
  refundedAmountPence?: number | null;
  partial?: boolean;
};

export function buildPublicPaymentReceipt(input: {
  payment: {
    id: string;
    amountPence: number;
    currency: string;
    status: string;
    createdAt: string;
    updatedAt?: string | null;
  };
  orderNumber?: string | null;
  completedRefunds?: Array<{ paymentId: string; amountPence: number | string; status: string }>;
}): PublicPaymentReceiptBody {
  const completed = (input.completedRefunds ?? [])
    .filter(row => String(row.status).toUpperCase() === 'COMPLETED' && row.paymentId === input.payment.id)
    .reduce((sum, row) => sum + Number(row.amountPence || 0), 0);
  const amountPence = Number(input.payment.amountPence || 0);
  const refundedAmountPence = completed > 0 ? completed : null;
  const partial = Boolean(refundedAmountPence != null && refundedAmountPence > 0 && refundedAmountPence < amountPence);
  const paymentStatus = String(input.payment.status || '').toLowerCase();
  const status = paymentStatus === 'refunded' || (refundedAmountPence != null && refundedAmountPence >= amountPence)
    ? 'refunded'
    : paymentStatus;

  return {
    id: input.payment.id,
    amountPence,
    currency: input.payment.currency || 'GBP',
    status,
    createdAt: input.payment.createdAt,
    updatedAt: input.payment.updatedAt ?? null,
    orderNumber: input.orderNumber ?? null,
    refundedAmountPence,
    partial,
  };
}
