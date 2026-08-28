/** Direct pharmacy cancellation is an unpaid-order operation. Unknown states fail closed. */
export function orderMoneyWasTaken(order: { paymentStatus?: unknown; paidAt?: unknown }) {
  if (order.paidAt) return true;
  return ['PAID', 'REFUND_REQUIRED', 'REFUNDED'].includes(String(order.paymentStatus || '').toUpperCase());
}

export function orderAllowsManualCancellation(order: { paymentStatus?: unknown; paidAt?: unknown }) {
  if (orderMoneyWasTaken(order)) return false;
  return ['NONE', 'PENDING', 'FAILED'].includes(String(order.paymentStatus || '').toUpperCase());
}
