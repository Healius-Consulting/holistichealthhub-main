import { queryWorldpayPayment } from '../integrations/worldpay.service.js';
import type { IntegrationRepositoryPort } from '../../repositories/ports/integration.port.js';
import type { OrderRecord, OrderRepositoryPort } from '../../repositories/ports/order.port.js';
import type { PaymentRecord, PaymentRepositoryPort } from '../../repositories/ports/payment.port.js';
import { verifyWorldpayRefund, worldpayIdentityMatches, worldpayStatusToSql, type WorldpayPaymentQuery, type WorldpayPaymentStatus } from './worldpay-query.js';
import { placePaidWorldpayOrdersStillOpen, placeWorldpayOrderAfterPaidResponse, shouldPlaceWorldpayOrderAfterReconcile, settlePaidWorldpayPayment, type WorldpaySettlementDeps } from './worldpay-settlement.js';
import { sha256 } from '../../security/session-utils.js';
import { dispatchEmailEvent } from '../notifications/email-dispatch.js';
import { pharmacyEmailContext } from '../notifications/email-outbox.js';

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

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function reconcilePreparedWorldpayRefund(
  payment: PaymentRecord,
  provider: WorldpayPaymentQuery,
  expectedEntityId: string,
  order: OrderRecord,
  deps: WorldpayReconciliationDeps,
): Promise<WorldpayReconciliationOutcome | null> {
  const refunds = await deps.paymentRepo.listRefundsByOrderId(payment.orderId, payment.organisationId);
  const refund = refunds.find(row => {
    const verificationPayload = payloadObject(row.verificationPayload);
    return row.paymentId === payment.id
      && row.route === 'WORLDPAY'
      && ['VERIFICATION_PENDING', 'RECONCILIATION_REQUIRED'].includes(String(row.status).toUpperCase())
      && Boolean(payloadString(verificationPayload, 'requestReference'));
  });
  if (!refund) return null;

  const verificationPayload = payloadObject(refund.verificationPayload);
  const requestReference = payloadString(verificationPayload, 'requestReference') ?? String(refund.externalReference || '');
  const commandId = payloadString(verificationPayload, 'commandId');
  if (!['refund_required', 'refunded'].includes(provider.paymentStatus)) {
    const preparedAt = Date.parse(String(refund.createdAt || ''));
    const evidenceOverdue = Number.isFinite(preparedAt) && Date.now() - preparedAt > 30 * 60 * 1_000;
    await deps.paymentRepo.markRefundVerification({
      id: refund.id,
      status: evidenceOverdue ? 'RECONCILIATION_REQUIRED' : 'VERIFICATION_PENDING',
      externalReference: refund.externalReference,
      confirmedByUid: refund.confirmedByUid,
      verificationStatus: evidenceOverdue ? 'worldpay_refund_not_observed' : 'worldpay_refund_not_visible_yet',
      verificationPayload: { ...verificationPayload, providerStatus: provider.providerStatus },
    });
    return evidenceOverdue
      ? { state: 'reconciliation_required', reason: 'Worldpay has not reported the submitted refund.' }
      : { state: 'verification_pending', reason: 'Worldpay has not indexed the submitted refund yet.' };
  }
  const verification = verifyWorldpayRefund({
    query: provider,
    transactionReference: String(payment.transactionReference || ''),
    paymentId: provider.paymentId,
    paymentAmountPence: Number(payment.amountPence),
    refundAmountPence: Number(refund.amountPence),
    currency: refund.currency || payment.currency,
    expectedEntityId,
    externalReference: requestReference,
    alternateReferences: commandId ? [commandId] : [],
  });

  if (!verification.verified) {
    await deps.paymentRepo.markRefundVerification({
      id: refund.id,
      status: verification.pending ? 'VERIFICATION_PENDING' : 'RECONCILIATION_REQUIRED',
      externalReference: refund.externalReference,
      confirmedByUid: refund.confirmedByUid,
      verificationStatus: verification.reason,
      verificationPayload: { ...verificationPayload, providerStatus: provider.providerStatus },
    });
    return verification.pending
      ? { state: 'verification_pending', reason: 'Worldpay has not completed the prepared refund yet.' }
      : { state: 'reconciliation_required', reason: 'Worldpay refund evidence did not match the prepared refund.' };
  }

  if (!refund.confirmedByUid) {
    await deps.paymentRepo.markRefundVerification({
      id: refund.id,
      status: 'RECONCILIATION_REQUIRED',
      externalReference: refund.externalReference,
      verificationStatus: 'refund_staff_actor_missing',
      verificationPayload,
    });
    return { state: 'reconciliation_required', reason: 'The prepared refund has no staff audit identity.' };
  }

  const allocations = await deps.paymentRepo.listPaymentAllocations(payment.id, payment.organisationId);
  if (!allocations.some(row => row.orderId === payment.orderId && row.status === 'ACTIVE')) {
    await deps.paymentRepo.markRefundVerification({
      id: refund.id,
      status: 'RECONCILIATION_REQUIRED',
      externalReference: refund.externalReference,
      confirmedByUid: refund.confirmedByUid,
      verificationStatus: 'active_payment_allocation_missing',
      verificationPayload,
    });
    return { state: 'reconciliation_required', reason: 'The active payment allocation is missing.' };
  }

  const fullyRefunded = Number(refund.amountPence) >= Number(payment.amountPence);
  await deps.paymentRepo.completeRefundAndConsumeAllocation({
    refundId: refund.id,
    organisationId: payment.organisationId,
    orderId: payment.orderId,
    paymentId: payment.id,
    amountPence: Number(refund.amountPence),
    externalReference: String(refund.externalReference || commandId || requestReference),
    confirmedByUid: refund.confirmedByUid,
    verificationStatus: fullyRefunded ? 'worldpay_refund_verified' : 'worldpay_partial_refund_verified',
    verificationPayload: { ...verificationPayload, providerStatus: provider.providerStatus, providerEvidence: verification.evidence },
  });
  await deps.orderRepo.markRefundResolution({
    orderId: payment.orderId,
    organisationId: payment.organisationId,
    fullyRefunded,
  });
  await deps.paymentRepo.updatePaymentOutcome({
    id: payment.id,
    orderId: payment.orderId,
    status: fullyRefunded ? 'REFUNDED' : 'PAID',
    providerPayload: {
      ...payloadObject(payment.providerPayload),
      providerPaymentId: provider.paymentId,
      providerStatus: provider.providerStatus,
      verifiedRefundId: refund.id,
    },
    updateOrderPaymentStatus: false,
  });
  const snapshot = payloadObject(order.quoteSnapshot);
  await deps.orderRepo.updateQuoteSnapshot({
    id: order.id,
    organisationId: order.organisationId,
    quoteSnapshot: {
      ...snapshot,
      ...(refund.cause === 'replacement_price_changed' ? { quoteReview: null } : {}),
      refund: {
        ...payloadObject(snapshot.refund),
        id: refund.id,
        status: 'completed',
        amountPence: Number(refund.amountPence),
        partial: !fullyRefunded,
        method: 'worldpay_api',
        externalReference: String(refund.externalReference || commandId || requestReference),
        confirmedAt: new Date().toISOString(),
        confirmedBy: refund.confirmedByUid,
      },
    },
  });
  const [patient, organisation] = await Promise.all([
    deps.patientRepo.findPatientById(payment.organisationId, order.patientId).catch(() => null),
    deps.organisationRepo.findOrganisationById(payment.organisationId).catch(() => null),
  ]);
  if (patient?.email) {
    await dispatchEmailEvent('payment.refunded', {
      notificationRepo: deps.notificationRepo,
      organisationRepo: deps.organisationRepo,
      organisationId: payment.organisationId,
      patientId: order.patientId,
      orderId: order.id,
      to: { email: patient.email, displayName: patient.firstName || null },
      payload: {
        firstName: patient.firstName || 'Patient',
        amountPence: Number(refund.amountPence),
        currency: refund.currency || payment.currency,
        orderNumber: order.orderNumber,
        ...pharmacyEmailContext(organisation),
      },
      keyParts: ['patient-refunded', order.id, refund.id],
    }).catch(error => console.warn('[Worldpay] refund notification note:', error instanceof Error ? error.message : 'Unknown error'));
  }
  return { state: 'reconciled', paymentStatus: fullyRefunded ? 'REFUNDED' : 'PAID', providerStatus: provider.providerStatus };
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
  const preparedRefundOutcome = order
    ? await reconcilePreparedWorldpayRefund(payment, provider, queried.expectedEntityId, order, deps)
    : null;
  if (preparedRefundOutcome) return preparedRefundOutcome;
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
