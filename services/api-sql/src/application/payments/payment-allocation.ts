export function refundedAllocationState(activeAmountPence: number, refundAmountPence: number) {
  if (!Number.isInteger(activeAmountPence) || activeAmountPence <= 0) {
    throw new Error('Active payment allocation not found for refund.');
  }
  if (!Number.isInteger(refundAmountPence) || refundAmountPence <= 0 || refundAmountPence > activeAmountPence) {
    throw new Error('Refund exceeds the active payment allocation.');
  }
  const amountPence = activeAmountPence - refundAmountPence;
  return {
    amountPence,
    status: amountPence === 0 ? 'REFUNDED' as const : 'ACTIVE' as const,
  };
}
