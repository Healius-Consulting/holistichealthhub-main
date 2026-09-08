import type { PaymentRepositoryPort, RefundRecord } from '../../repositories/ports/payment.port.js';

/** Both manual confirmation and provider reconciliation use the same atomic ledger operation. */
export async function completePrescriptionRefund(
  paymentRepo: PaymentRepositoryPort,
  refund: RefundRecord,
  evidence: { externalReference: string; confirmedByUid: string; verificationStatus: string; verificationPayload?: unknown },
) {
  if (!refund.prescriptionId) throw new Error('Prescription refund scope missing.');
  return paymentRepo.completeRefundAndConsumeAllocation({
    refundId: refund.id, organisationId: refund.organisationId, orderId: refund.orderId,
    paymentId: refund.paymentId, amountPence: Number(refund.amountPence), ...evidence,
  });
}
