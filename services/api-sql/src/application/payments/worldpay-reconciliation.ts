import { queryWorldpayPayment } from '../integrations/worldpay.service.js';
import type { IntegrationRepositoryPort } from '../../repositories/ports/integration.port.js';
import type { OrderRepositoryPort } from '../../repositories/ports/order.port.js';
import type { PaymentRecord, PaymentRepositoryPort } from '../../repositories/ports/payment.port.js';
import { worldpayIdentityMatches, worldpayStatusToSql, type WorldpayPaymentStatus } from './worldpay-query.js';
import { placePaidWorldpayOrdersStillOpen, placeWorldpayOrderAfterPaidResponse, shouldPlaceWorldpayOrderAfterReconcile, settlePaidWorldpayPayment, type WorldpaySettlementDeps } from './worldpay-settlement.js';
import { sha256 } from '../../security/session-utils.js';

const PAYMENT_QUERY_LAG_GRACE_MS = 2 * 60 * 1_000;

export type WorldpayReconciliationDeps = WorldpaySettlementDeps & {
  paymentRepo: PaymentRepositoryPort;
  orderRepo: OrderRepositoryPort;
  integrationRepo: IntegrationRepositoryPort;
};

export type WorldpayReconciliationOutcome =
  | { state: 'verification_pending'; reason: string }
  | { state: 'reconciliation_required'; reason: string }
  | { state: 'reconciled'; paymentStatus: string; providerStatus: string | null };

function payloadObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function worldpayPaymentDisposition(input: {
  localPaymentStatus: string;
  providerPaymentStatus: WorldpayPaymentStatus;
  order?: { status?: string | null; cancelledAt?: string | null; archivedAt?: string | null; resolutionStatus?: string | null } | null;
}) {
  const terminalOrder = input.order?.status === 'CANCELLED'
    || input.order?.status === 'COMPLETED'
    || Boolean(input.order?.cancelledAt)
    || Boolean(input.order?.archivedAt)
    || String(input.order?.resolutionStatus || '').toUpperCase() === 'RESOLVED';
  const latePaymentAfterCancellation = Boolean(terminalOrder && input.providerPaymentStatus === 'paid');
  const retiredLinkPaid = input.localPaymentStatus === 'CANCELLED' && input.providerPaymentStatus === 'paid';
  const providerReportsRefund = input.providerPaymentStatus === 'refund_required' || input.providerPaymentStatus === 'refunded';
  return {
    latePaymentAfterCancellation,
    retiredLinkPaid,
    providerReportsRefund,
    nextStatus: latePaymentAfterCancellation || retiredLinkPaid || providerReportsRefund
      ? 'refund_required'
      : input.providerPaymentStatus,
  };
}

export async function reconcileWorldpayPaymentRecord(
  payment: PaymentRecord,
  deps: WorldpayReconciliationDeps,
): Promise<WorldpayReconciliationOutcome> {
  const transactionReference = String(payment.transactionReference ?? '').trim();
  if (!payment.organisationId || !transactionReference || !payment.orderId) {
    await deps.paymentRepo.updatePaymentOutcome({
      id: payment.id,
      orderId: payment.orderId,
      status: 'RECONCILIATION_REQUIRED',
      providerPayload: { ...payloadObject(payment.providerPayload), reconciliationReason: 'incomplete_payment_record' },
    });
    return { state: 'reconciliation_required', reason: 'The local payment record is incomplete.' };
  }

  const connection = await deps.integrationRepo.findConnection(payment.organisationId, 'WORLDPAY').catch(() => null);
  const queried = await queryWorldpayPayment(connection, payment.organisationId, transactionReference);
  if (!queried.queried) {
    return { state: 'verification_pending', reason: queried.reason };
  }

  const provider = queried.query;
  if (!provider.found) {
    const linkExpiry = Date.parse(String(payment.linkExpiresAt ?? ''));
    if (Number.isFinite(linkExpiry) && Date.now() > linkExpiry + PAYMENT_QUERY_LAG_GRACE_MS) {
      await deps.paymentRepo.updatePaymentOutcome({
        id: payment.id,
        orderId: payment.orderId,
        status: 'EXPIRED',
        providerPayload: { ...payloadObject(payment.providerPayload), providerStatus: 'paymentLinkExpired' },
      });
      return { state: 'reconciled', paymentStatus: 'EXPIRED', providerStatus: 'paymentLinkExpired' };
    }
    return { state: 'verification_pending', reason: 'Payment Queries has not indexed this payment yet.' };
  }

  if (!worldpayIdentityMatches({
    query: provider,
    transactionReference,
    amountPence: Number(payment.amountPence),
    currency: payment.currency,
    expectedEntityId: queried.expectedEntityId,
  })) {
    await deps.paymentRepo.updatePaymentOutcome({
      id: payment.id,
      orderId: payment.orderId,
      status: 'RECONCILIATION_REQUIRED',
      providerPayload: {
        ...payloadObject(payment.providerPayload),
        reconciliationReason: 'Worldpay reference, amount, currency or merchant entity did not match.',
        providerResponse: provider.payment,
      },
    });
    return { state: 'reconciliation_required', reason: 'Worldpay reference, amount, currency or merchant entity did not match the local payment.' };
  }

  const order = await deps.orderRepo.findOrderById(payment.orderId, payment.organisationId);
  // Provider refund events open/advance the staff refund gate; they never close it
  // without the pharmacy's recorded reference and exact verification route.
  const { latePaymentAfterCancellation, retiredLinkPaid, providerReportsRefund, nextStatus } = worldpayPaymentDisposition({
    localPaymentStatus: payment.status,
    providerPaymentStatus: provider.paymentStatus,
    order,
  });

  if (nextStatus === 'refund_required' && (latePaymentAfterCancellation || retiredLinkPaid)) {
    const siblings = await deps.paymentRepo.listPaymentsByOrderId(payment.orderId, payment.organisationId);
    const anotherSettledPayment = siblings.some(row => row.id !== payment.id && ['PAID', 'REFUND_REQUIRED', 'REFUNDED'].includes(row.status));
    await deps.paymentRepo.cancelPendingPaymentsForOrder(payment.orderId, payment.organisationId);
    await deps.paymentRepo.createRefund({
      organisationId: payment.organisationId,
      orderId: payment.orderId,
      paymentId: payment.id,
      amountPence: Number(payment.amountPence),
      currency: payment.currency,
      cause: retiredLinkPaid ? 'late_payment_on_retired_link' : 'late_payment_after_order_resolution',
      route: 'WORLDPAY',
      status: 'PENDING_CONFIRMATION',
      idempotencyKey: sha256(`${payment.organisationId}:late-worldpay:${payment.id}`),
    });
    await deps.paymentRepo.updatePaymentOutcome({
      id: payment.id,
      orderId: payment.orderId,
      status: 'REFUND_REQUIRED',
      updateOrderPaymentStatus: !anotherSettledPayment,
      providerPayload: {
        ...payloadObject(payment.providerPayload),
        providerPaymentId: provider.paymentId,
        providerStatus: provider.providerStatus,
        latePaymentAfterCancellation,
        retiredLinkPaid,
        providerResponse: provider.payment,
      },
    });
    return { state: 'reconciled', paymentStatus: 'REFUND_REQUIRED', providerStatus: provider.providerStatus };
  }

  if (nextStatus === 'paid' && payment.status === 'PENDING') {
    await settlePaidWorldpayPayment(payment, deps);
    return { state: 'reconciled', paymentStatus: 'PAID', providerStatus: provider.providerStatus };
  }

  if (nextStatus === 'pending') {
    return { state: 'verification_pending', reason: 'Worldpay has not reached a settlement state yet.' };
  }

  await deps.paymentRepo.updatePaymentOutcome({
    id: payment.id,
    orderId: payment.orderId,
    status: worldpayStatusToSql(nextStatus),
    providerPayload: {
      ...payloadObject(payment.providerPayload),
      providerPaymentId: provider.paymentId,
      providerStatus: provider.providerStatus,
      latePaymentAfterCancellation,
      retiredLinkPaid,
      providerRefundState: providerReportsRefund ? provider.paymentStatus : null,
      providerResponse: provider.payment,
    },
  });

  return {
    state: 'reconciled',
    paymentStatus: worldpayStatusToSql(nextStatus),
    providerStatus: provider.providerStatus,
  };
}

export async function reconcilePendingWorldpayPayments(
  deps: WorldpayReconciliationDeps,
  limit = 200,
) {
  const candidates = await deps.paymentRepo.listPendingWorldpayPayments(limit);
  const summary = { checked: candidates.length, reconciled: 0, pending: 0, attention: 0, errors: 0 };
  for (const payment of candidates) {
    try {
      const previousStatus = payment.status;
      const outcome = await reconcileWorldpayPaymentRecord(payment, deps);
      if (outcome.state === 'reconciled') {
        summary.reconciled += 1;
        if (shouldPlaceWorldpayOrderAfterReconcile(previousStatus, outcome.paymentStatus)) {
          await placeWorldpayOrderAfterPaidResponse('PENDING', { ...payment, status: 'PAID' }, deps);
        }
      }
      else if (outcome.state === 'verification_pending') summary.pending += 1;
      else summary.attention += 1;
    } catch (error) {
      summary.errors += 1;
      console.error('Worldpay payment reconciliation failed', {
        paymentId: payment.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
  const placement = await placePaidWorldpayOrdersStillOpen(deps).catch(error => {
    console.error('Worldpay paid-order placement sweep failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return { checked: 0, placed: 0, skipped: 0, errors: 1 };
  });
  return { ...summary, placement };
}
