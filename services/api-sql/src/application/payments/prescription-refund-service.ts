import { randomUUID, createHash } from 'node:crypto';
import { HttpError } from '../../domain/common/errors.js';
import type { OrderRepositoryPort } from '../../repositories/ports/order.port.js';
import type { OrderLineRepositoryPort } from '../../repositories/ports/order-line.port.js';
import type { IntegrationRepositoryPort } from '../../repositories/ports/integration.port.js';
import type { PaymentRepositoryPort, RefundRecord } from '../../repositories/ports/payment.port.js';
import { submitWorldpayRefund, queryWorldpayPayment } from '../integrations/worldpay.service.js';
import { verifyWorldpayRefund } from './worldpay-query.js';
import {
  prescriptionRefundPreview, composePrescriptionRefund, prescriptionRefundTotal, refundConflict,
  type PrescriptionRefundInput,
} from './prescription-refund.js';
import { completePrescriptionRefund } from './prescription-refund-completion.js';

/** Provider calls are injected so the refund lifecycle can be exercised without Worldpay. */
export type PrescriptionRefundDeps = {
  orderRepo: Pick<OrderRepositoryPort, 'findOrderById'>;
  lineRepo: Pick<OrderLineRepositoryPort, 'listByOrderId'>;
  paymentRepo: PaymentRepositoryPort;
  integrationRepo: Pick<IntegrationRepositoryPort, 'findConnection'>;
  submitRefund?: typeof submitWorldpayRefund;
  queryPayment?: typeof queryWorldpayPayment;
};

export type PrescriptionRefundScope = { organisationId: string; uid: string };

/** Uncertain provider outcomes keep the reservation; the refund is never resubmitted as a new one. */
const UNCERTAIN_WORLDPAY_CODES = [
  'WORLDPAY_TIMEOUT', 'WORLDPAY_UNAVAILABLE', 'WORLDPAY_REFUND_QUERY_UNAVAILABLE', 'WORLDPAY_REFUND_OUTCOME_UNKNOWN',
];

export const prescriptionRefundIdempotencyKey = (orderId: string, requestId: string) => `prescription-refund:${orderId}:${requestId}`;

export function hashPrescriptionRefundRequest(input: PrescriptionRefundInput) {
  return createHash('sha256').update(JSON.stringify({
    ...input, medicines: [...input.medicines].sort((a, b) => a.orderLineId.localeCompare(b.orderLineId)),
  })).digest('hex');
}

/**
 * Every read is tenant-scoped, so another organisation's order is a 404 rather than a
 * refundable record. The order, its lines, payments and refunds are loaded together
 * because the preview's balance depends on all four.
 */
export async function loadPrescriptionRefundContext(
  deps: PrescriptionRefundDeps, scope: PrescriptionRefundScope, orderId: string, prescriptionId: string,
) {
  const order = await deps.orderRepo.findOrderById(orderId, scope.organisationId);
  if (!order) throw new HttpError(404, 'Order not found.', 'NOT_FOUND');
  const [payments, lines, refunds] = await Promise.all([
    deps.paymentRepo.listPaymentsByOrderId(orderId, scope.organisationId),
    deps.lineRepo.listByOrderId(orderId),
    deps.paymentRepo.listRefundsByOrderId(orderId, scope.organisationId),
  ]);
  if (!lines.some(line => line.prescriptionId === prescriptionId)) throw new HttpError(404, 'Prescription not found on this order.', 'NOT_FOUND');
  const settled = payments.filter(row => ['PAID', 'REFUND_REQUIRED', 'REFUNDED'].includes(row.status));
  if (settled.length !== 1) refundConflict('The settled payment needs reconciliation.');
  const payment = settled[0]!;
  const allocations = await deps.paymentRepo.listPaymentAllocations(payment.id, scope.organisationId);
  return { order, payment, lines, refunds, allocations, prescriptionId };
}

export async function previewPrescriptionRefund(
  deps: PrescriptionRefundDeps, scope: PrescriptionRefundScope, orderId: string, prescriptionId: string,
) {
  return prescriptionRefundPreview(await loadPrescriptionRefundContext(deps, scope, orderId, prescriptionId));
}

async function submitToWorldpay(
  deps: PrescriptionRefundDeps, scope: PrescriptionRefundScope, refund: RefundRecord,
  payment: { transactionReference?: string | null; currency: string },
) {
  const requestReference = `refund-${refund.id}`;
  const transactionReference = String(payment.transactionReference || '');
  // Stamp an uncertain outcome before network I/O. A crashed request never submits twice.
  await deps.paymentRepo.markRefundVerification({
    id: refund.id, status: 'VERIFICATION_PENDING', confirmedByUid: scope.uid, externalReference: requestReference,
    verificationStatus: 'worldpay_submission_outcome_unknown',
    verificationPayload: { requestReference, transactionReference },
  });
  try {
    const connection = await deps.integrationRepo.findConnection(scope.organisationId, 'WORLDPAY');
    const submitted = await (deps.submitRefund ?? submitWorldpayRefund)({
      connection, organisationId: scope.organisationId, transactionReference,
      amountPence: Number(refund.amountPence), currency: payment.currency, reference: requestReference, full: false,
    });
    await deps.paymentRepo.markRefundVerification({
      id: refund.id, status: 'VERIFICATION_PENDING', confirmedByUid: scope.uid,
      externalReference: submitted.commandId || submitted.reference, verificationStatus: 'worldpay_refund_submitted',
      verificationPayload: { requestReference: submitted.reference, commandId: submitted.commandId, transactionReference },
    });
  } catch (error) {
    const code = error instanceof HttpError ? error.code : 'WORLDPAY_REFUND_OUTCOME_UNKNOWN';
    const uncertain = UNCERTAIN_WORLDPAY_CODES.includes(String(code));
    await deps.paymentRepo.markRefundVerification({
      id: refund.id, status: uncertain ? 'VERIFICATION_PENDING' : 'PENDING_CONFIRMATION',
      confirmedByUid: scope.uid, externalReference: requestReference,
      verificationStatus: uncertain ? 'worldpay_submission_outcome_unknown' : 'worldpay_api_unavailable',
      verificationPayload: { requestReference, transactionReference, errorCode: code },
    });
  }
}

/**
 * A repeated request id returns the refund it already reserved instead of taking the
 * money twice; the same id carrying a different breakdown is a client bug, not a retry.
 */
export async function submitPrescriptionRefund(
  deps: PrescriptionRefundDeps, scope: PrescriptionRefundScope,
  orderId: string, prescriptionId: string, input: PrescriptionRefundInput,
): Promise<{ refund: RefundRecord; reused: boolean }> {
  const data = await loadPrescriptionRefundContext(deps, scope, orderId, prescriptionId);
  const idempotencyKey = prescriptionRefundIdempotencyKey(data.order.id, input.requestId);
  const prior = await deps.paymentRepo.findRefundByIdempotencyKey(idempotencyKey, scope.organisationId);
  if (prior) {
    const breakdown = prior.breakdown as { requestHash?: string } | null;
    if (prior.prescriptionId !== data.prescriptionId || breakdown?.requestHash !== hashPrescriptionRefundRequest(input)) {
      refundConflict('This refund request was already used for a different breakdown.', 'REFUND_REQUEST_CONFLICT');
    }
    return { refund: prior, reused: true };
  }
  const breakdown = composePrescriptionRefund(prescriptionRefundPreview(data), input);
  const refund = await deps.paymentRepo.reservePrescriptionRefund({
    id: randomUUID(), organisationId: scope.organisationId, orderId: data.order.id, paymentId: data.payment.id,
    prescriptionId: data.prescriptionId, amountPence: prescriptionRefundTotal(breakdown), currency: data.payment.currency,
    route: data.payment.route, idempotencyKey, confirmedByUid: scope.uid, breakdown,
    orderVersion: data.order.version, orderUpdatedAt: data.order.updatedAt, paymentVersion: data.payment.version,
  });
  if (data.payment.route === 'WORLDPAY') await submitToWorldpay(deps, scope, refund, data.payment);
  const saved = await deps.paymentRepo.findRefundByIdempotencyKey(idempotencyKey, scope.organisationId);
  return { refund: saved ?? refund, reused: false };
}

/**
 * Manual confirmation and provider reconciliation share one completion path, so a
 * repeated confirmation of a completed refund reports it rather than consuming the
 * allocation again.
 */
export async function confirmPrescriptionRefund(
  deps: PrescriptionRefundDeps, scope: PrescriptionRefundScope,
  orderId: string, prescriptionId: string, refundId: string, externalReference: string,
): Promise<RefundRecord> {
  const data = await loadPrescriptionRefundContext(deps, scope, orderId, prescriptionId);
  const refund = data.refunds.find(row => row.id === refundId && row.prescriptionId === data.prescriptionId);
  if (!refund) throw new HttpError(404, 'Refund not found.', 'NOT_FOUND');
  if (refund.status === 'COMPLETED') {
    if (refund.externalReference !== externalReference) refundConflict('The confirmed reference differs.', 'REFUND_REFERENCE_CONFLICT');
    return refund;
  }
  let verificationStatus = 'manual_reference_recorded';
  let verificationPayload: unknown = null;
  if (data.payment.route === 'WORLDPAY') {
    const connection = await deps.integrationRepo.findConnection(scope.organisationId, 'WORLDPAY');
    const transactionReference = String(data.payment.transactionReference || '');
    const queried = await (deps.queryPayment ?? queryWorldpayPayment)(connection, scope.organisationId, transactionReference);
    if (!queried.queried) refundConflict('Worldpay confirmation is unavailable. The refund remains reserved.', 'REFUND_VERIFICATION_PENDING');
    const verified = verifyWorldpayRefund({
      query: queried.query, transactionReference, paymentId: queried.query.paymentId,
      paymentAmountPence: Number(data.payment.amountPence), refundAmountPence: Number(refund.amountPence),
      currency: data.payment.currency, expectedEntityId: queried.expectedEntityId, externalReference,
    });
    if (!verified.verified) refundConflict('Worldpay has not confirmed this refund’s exact reference and amount. The refund remains reserved.', 'REFUND_VERIFICATION_PENDING');
    verificationStatus = 'worldpay_partial_refund_verified';
    verificationPayload = { providerEvidence: verified.evidence };
  }
  await completePrescriptionRefund(deps.paymentRepo, refund, { externalReference, confirmedByUid: scope.uid, verificationStatus, verificationPayload });
  const saved = (await deps.paymentRepo.listRefundsByOrderId(data.order.id, scope.organisationId)).find(row => row.id === refund.id);
  return saved ?? { ...refund, status: 'COMPLETED', externalReference };
}
