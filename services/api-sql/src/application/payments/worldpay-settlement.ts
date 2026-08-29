import { executeCuraleafOrderPlacement, fetchCuraleafQuote } from '../integrations/curaleaf.service.js';
import { curaleafCancellationBlocksPlacement } from '../orders/quote-review.js';
import { quoteCheckInput, quotePricingPolicy } from '../orders/quote-gate.js';
import { existingCuraleafPurchaseOrder } from '../orders/curaleaf-fulfilment.js';
import { pendingPlacementRxIndexes, snapshotRxList } from '../prescriptions/snapshot-rx.js';
import { persistCuraleafPrescriptionIdentity } from '../prescriptions/curaleaf-prescription-record.js';
import { promotePatientAfterCuraleafPlacement } from '../patient-finance/patient-finance.js';
import type { PatientFinanceDeps } from '../patient-finance/patient-finance.js';
import type { IntegrationRepositoryPort } from '../../repositories/ports/integration.port.js';
import { listPharmacyRecipients, pharmacyEmailContext, queueEmailToRecipients } from '../notifications/email-outbox.js';
import type { OrderRecord, OrderRepositoryPort } from '../../repositories/ports/order.port.js';
import type { PaymentRecord, PaymentRepositoryPort } from '../../repositories/ports/payment.port.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { IdentityRepositoryPort } from '../../repositories/ports/identity.port.js';
import type { OrganisationRepositoryPort } from '../../repositories/ports/organisation.port.js';
import type { PatientRepositoryPort } from '../../repositories/ports/patient.port.js';
import { sha256 } from '../../security/session-utils.js';
import { SqlOrderLineRepository } from '../../repositories/sql/order-line.sql.js';

export type WorldpaySettlementDeps = {
  paymentRepo: PaymentRepositoryPort;
  orderRepo: OrderRepositoryPort;
  integrationRepo: IntegrationRepositoryPort;
  patientFinanceDeps: PatientFinanceDeps;
  patientRepo: PatientRepositoryPort;
  notificationRepo: NotificationRepositoryPort;
  identityRepo: IdentityRepositoryPort;
  organisationRepo: OrganisationRepositoryPort;
};

export async function settlePaidWorldpayPayment(
  payment: PaymentRecord,
  deps: WorldpaySettlementDeps,
) {
  if (payment.status === 'PAID') {
    return { payment, settled: false as const, reason: 'already_paid' as const };
  }
  if (payment.status !== 'PENDING') {
    return { payment, settled: false as const, reason: 'not_pending' as const };
  }

  const order = await deps.orderRepo.findOrderById(payment.orderId, payment.organisationId);
  if (!order || order.archivedAt || String(order.resolutionStatus || '').toUpperCase() === 'RESOLVED'
    || ['CANCELLED', 'COMPLETED'].includes(String(order.status || '').toUpperCase())) {
    return { payment, settled: false as const, reason: 'terminal_order' as const };
  }

  const receiptHash = payment.receiptHash ?? sha256(crypto.randomUUID());
  await deps.paymentRepo.updatePaymentStatus(payment.id, 'PAID', payment.orderId, receiptHash);
  const settled: PaymentRecord = { ...payment, status: 'PAID', receiptHash };
  await deps.paymentRepo.createPaymentAllocation({
    organisationId: payment.organisationId,
    paymentId: payment.id,
    orderId: payment.orderId,
    amountPence: Number(payment.amountPence),
  });
  await queueSettlementEmails(settled, deps).catch(error => {
    console.warn('[Worldpay] settlement notification note:', error);
  });

  return { payment: settled, settled: true as const, reason: 'paid' as const };
}

export function shouldPlaceWorldpayOrderAfterReconcile(previousStatus: string, paymentStatus: string | undefined) {
  return previousStatus === 'PENDING' && paymentStatus === 'PAID';
}

export function paidWorldpayOrderNeedsPlacement(order: Pick<OrderRecord, 'paymentRoute' | 'paymentStatus' | 'paidAt' | 'quoteSnapshot' | 'id' | 'orderNumber'>) {
  if (String(order.paymentRoute || '').toUpperCase() !== 'WORLDPAY') return false;
  if (String(order.paymentStatus || '').toUpperCase() !== 'PAID' && !order.paidAt) return false;
  const prescriptions = snapshotRxList(order.quoteSnapshot);
  if (prescriptions.length > 0) return pendingPlacementRxIndexes(order.quoteSnapshot).length > 0;
  return !existingCuraleafPurchaseOrder(order);
}

export async function placeWorldpayOrderAfterPaidResponse(
  previousStatus: string,
  payment: PaymentRecord,
  deps: WorldpaySettlementDeps,
) {
  if (!shouldPlaceWorldpayOrderAfterReconcile(previousStatus, payment.status)) return;
  try {
    await placeOrderAfterWorldpaySettlement(payment, deps);
  } catch (error) {
    console.warn('[Worldpay] Curaleaf placement after settlement note:', error);
  }
}

const RECENT_PAID_PLACEMENT_WINDOW_MS = 30 * 60 * 1_000;

export async function placePaidWorldpayOrdersStillOpen(
  deps: WorldpaySettlementDeps,
  now = Date.now(),
  limit = 20,
) {
  const orders = await deps.orderRepo.listPaidOpenOrders(200);
  const cutoff = now - RECENT_PAID_PLACEMENT_WINDOW_MS;
  const summary = { checked: 0, placed: 0, skipped: 0, errors: 0 };
  for (const order of orders) {
    if (!paidWorldpayOrderNeedsPlacement(order)) continue;
    const paidAt = Date.parse(String(order.paidAt ?? ''));
    if (Number.isFinite(paidAt) && paidAt < cutoff) continue;
    summary.checked += 1;
    if (summary.checked > limit) break;
    try {
      const payments = await deps.paymentRepo.listPaymentsByOrderId(order.id, order.organisationId);
      const payment = payments.find(row => row.route === 'WORLDPAY' && row.status === 'PAID') ?? null;
      if (!payment) {
        summary.skipped += 1;
        continue;
      }
      await placeOrderAfterWorldpaySettlement(payment, deps);
      summary.placed += 1;
    } catch (error) {
      summary.errors += 1;
      console.warn('[Worldpay] Paid-order Curaleaf placement retry failed', {
        orderId: order.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
  return summary;
}

async function queueSettlementEmails(payment: PaymentRecord, deps: WorldpaySettlementDeps) {
  const order = await deps.orderRepo.findOrderById(payment.orderId, payment.organisationId);
  if (!order) return;
  const [patient, organisation] = await Promise.all([
    deps.patientRepo.findPatientById(payment.organisationId, order.patientId).catch(() => null),
    deps.organisationRepo.findOrganisationById(payment.organisationId).catch(() => null),
  ]);
  if (patient?.email) {
    await queueEmailToRecipients(
      deps.notificationRepo,
      [{ email: patient.email, displayName: patient.firstName || null }],
      'patient_payment_confirmation',
      {
        firstName: patient.firstName || 'Patient',
        amountPence: payment.amountPence,
        medicineTotalPence: order.medicineTotalPence,
        dispensingFeePence: order.dispensingFeePence,
        pharmacyDeliveryPence: order.pharmacyDeliveryPence,
        currency: payment.currency,
        orderNumber: order.orderNumber,
        receiptHash: payment.receiptHash,
        ...pharmacyEmailContext(organisation),
      },
      ['patient-payment-confirmation', payment.id, payment.receiptHash],
      { organisationId: payment.organisationId, patientId: order.patientId, orderId: order.id },
    );
  }
  const pharmacyRecipients = await listPharmacyRecipients(payment.organisationId, {
    identityRepo: deps.identityRepo,
    organisationRepo: deps.organisationRepo,
  });
  await queueEmailToRecipients(
    deps.notificationRepo,
    pharmacyRecipients,
    'pharmacy_payment_received',
    {
      amountPence: payment.amountPence,
      currency: payment.currency,
      orderNumber: order.orderNumber,
    },
    ['pharmacy-payment-received', payment.id],
    { organisationId: payment.organisationId, patientId: order.patientId, orderId: order.id },
  );
}

export async function placeOrderAfterWorldpaySettlement(
  payment: PaymentRecord,
  deps: WorldpaySettlementDeps,
) {
  const order = await deps.orderRepo.findOrderById(payment.orderId, payment.organisationId);
  if (!order) return null;
  if (!paidWorldpayOrderNeedsPlacement({
    ...order,
    paymentRoute: 'WORLDPAY',
    paymentStatus: 'PAID',
    paidAt: order.paidAt ?? new Date().toISOString(),
  })) {
    return null;
  }

  const snapshot = (order.quoteSnapshot && typeof order.quoteSnapshot === 'object' ? order.quoteSnapshot : {}) as Record<string, any>;
  if (curaleafCancellationBlocksPlacement(order.quoteSnapshot)
    || order.status === 'CANCELLED'
    || order.status === 'COMPLETED'
    || order.archivedAt
    || String(order.resolutionStatus || '').toUpperCase() === 'RESOLVED') {
    return null;
  }
  const connection = await deps.integrationRepo.findConnection(payment.organisationId, 'CURALEAF').catch(() => null);
  const baseline = payment.baselineQuoteCheckId
    ? await deps.paymentRepo.findQuoteCheckById(payment.baselineQuoteCheckId, payment.organisationId)
    : null;
  if (!baseline || baseline.phase !== 'PRE_PAYMENT' || payment.basketFingerprint !== baseline.basketFingerprint) {
    await deps.paymentRepo.updatePaymentOutcome({
      id: payment.id,
      orderId: payment.orderId,
      status: 'RECONCILIATION_REQUIRED',
      providerPayload: { reconciliationReason: 'missing_or_mismatched_pre_payment_quote' },
    });
    return null;
  }
  if (!connection?.secretResourceName) return null;
  const lines = await new SqlOrderLineRepository().listByOrderId(order.id);
  const basket = lines.map(line => ({ packId: line.packId, quantity: Number(line.quantity) }));
  const rawQuote = await fetchCuraleafQuote(connection, basket);
  const postCheck = await deps.paymentRepo.createQuoteCheck(quoteCheckInput({
    organisationId: payment.organisationId,
    orderId: order.id,
    paymentId: payment.id,
    phase: 'POST_PAYMENT',
    basket,
    rawQuote,
    baseline,
    dispensingFeePence: Number(order.dispensingFeePence || 0),
    pharmacyDeliveryPence: Number(order.pharmacyDeliveryPence || 0),
    ...quotePricingPolicy(order.quoteSnapshot),
  }));
  if (postCheck.status !== 'MATCHED') {
    const comparison = postCheck.comparison && typeof postCheck.comparison === 'object'
      ? postCheck.comparison as Record<string, unknown>
      : {};
    await deps.orderRepo.updateQuoteSnapshot({
      id: order.id,
      organisationId: order.organisationId,
      quoteSnapshot: {
        ...snapshot,
        quoteReview: {
          status: postCheck.status === 'RECONCILIATION_REQUIRED' ? 'recreate_required' : 'required',
          type: postCheck.status === 'OUT_OF_STOCK' ? 'out_of_stock' : 'patient_price_changed',
          fingerprint: postCheck.quoteFingerprint,
          latestQuote: postCheck.rawQuote,
          differences: comparison.differences ?? [],
          patientDeltaPence: Number(comparison.patientDeltaPence ?? 0),
          checkedAt: postCheck.createdAt,
          baselineQuoteCheckId: baseline.id,
          quoteCheckId: postCheck.id,
        },
      },
      fulfilmentStatus: 'SUPPLIER_PENDING',
    });
    return null;
  }

  let curaleafResult: Awaited<ReturnType<typeof executeCuraleafOrderPlacement>> | null = null;
  curaleafResult = await executeCuraleafOrderPlacement(connection, order);

  if (curaleafResult && ('prescriptionId' in curaleafResult || 'purchaseOrder' in curaleafResult)) {
    const placed = curaleafResult as { prescriptionId?: string; prescriberId?: string; purchaseOrder?: Record<string, unknown> | null };
    if (placed.prescriptionId || placed.purchaseOrder) {
      await persistCuraleafPrescriptionIdentity({
        organisationId: payment.organisationId,
        orderId: order.id,
        patientId: order.patientId,
        snapshot: order.quoteSnapshot,
        prescriptionId: placed.prescriptionId,
        prescriberId: placed.prescriberId,
        purchaseOrder: placed.purchaseOrder ?? null,
        fulfilmentStatus: placed.purchaseOrder ? 'SUPPLIER_PROCESSING' : undefined,
      });
    }
  }

  await promotePatientAfterCuraleafPlacement(deps.patientFinanceDeps, order, curaleafResult).catch(err =>
    console.warn('Patient activation after Curaleaf placement note:', err),
  );

  const skipped = curaleafResult && 'skipped' in curaleafResult ? curaleafResult.skipped : false;
  const purchaseOrderId = curaleafResult && 'purchaseOrder' in curaleafResult
    ? (curaleafResult.purchaseOrder as { id?: string } | null | undefined)?.id
    : undefined;
  const skipReason = curaleafResult && 'reason' in curaleafResult ? String(curaleafResult.reason) : '';

  await deps.orderRepo.appendPlacementEvent({
    organisationId: payment.organisationId,
    orderId: payment.orderId,
    fromState: 'PENDING_PLACEMENT',
    toState: purchaseOrderId ? 'PLACED' : 'PENDING_PLACEMENT',
    reason: purchaseOrderId
      ? `Worldpay payment cleared (${payment.transactionReference}) - Curaleaf Purchase Order ${purchaseOrderId} placed automatically`
      : skipped
        ? `Worldpay payment cleared (${payment.transactionReference}) - Curaleaf placement waiting (${skipReason})`
        : `Worldpay payment cleared (${payment.transactionReference}) - Pharmacy dispensing workflow`,
    externalReference: purchaseOrderId || payment.transactionReference || null,
  });

  return curaleafResult;
}
