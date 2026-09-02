import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { HttpError } from '../../domain/common/errors.js';
import { assertCuraleafTestPaymentAllowed } from '../../domain/organisation/curaleaf-payment-lock.js';
import { executeCuraleafOrderPlacement } from '../../application/integrations/curaleaf.service.js';
import { fetchCuraleafQuote } from '../../application/integrations/curaleaf.service.js';
import { quoteCheckInput, quoteGateAllowsPayment, quotePricingPolicy } from '../../application/orders/quote-gate.js';
import { stampPaidQuoteOnSnapshot } from '../../application/orders/finance-costing.js';
import { promotePatientAfterCuraleafPlacement } from '../../application/patient-finance/patient-finance.js';
import { createWorldpayHostedSession } from '../../application/integrations/worldpay.service.js';
import { createWorldpayTransactionReference } from '../../application/payments/worldpay-reference.js';
import { SqlIntegrationRepository } from '../../repositories/sql/integration.sql.js';
import { SqlIdentityRepository } from '../../repositories/sql/identity.sql.js';
import { listPharmacyRecipients, pharmacyEmailContext, queueEmailToRecipients } from '../../application/notifications/email-outbox.js';
import { SqlNotificationRepository } from '../../repositories/sql/notification.sql.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { SqlOrderRepository } from '../../repositories/sql/order.sql.js';
import { SqlOrderLineRepository } from '../../repositories/sql/order-line.sql.js';
import { SqlPatientFinanceRepository } from '../../repositories/sql/patient-finance.sql.js';
import { SqlPatientRepository } from '../../repositories/sql/patient.sql.js';
import { SqlPaymentRepository } from '../../repositories/sql/payment.sql.js';
import { requireCsrf } from '../../security/csrf.js';
import { assertTenantScope } from '../../security/request-context.js';
import { requireStaff } from '../../security/require-staff.js';
import { sha256 } from '../../security/session-utils.js';
import { requirePharmacyOperationalWrites } from './require-operational-writes.js';

const manualPaymentSchema = z.object({
  organisationId: z.string().optional(),
  amountPence: z.number().int().positive().optional(),
  tender: z.enum(['cash', 'epos', 'bank_transfer', 'other']).default('cash'),
  reference: z.string().min(1).max(255),
  notes: z.string().max(1000).optional(),
});

const worldpaySessionSchema = z.object({
  organisationId: z.string().optional(),
});

const createPaymentSchema = z.object({
  amountPence: z.number().int().positive(),
  currency: z.string().default('GBP'),
  route: z.enum(['MANUAL', 'WORLDPAY']).default('MANUAL'),
});

function quoteGateError(status: string) {
  if (status === 'OUT_OF_STOCK') return new HttpError(409, 'One or more items are out of stock. Recheck the order before taking payment.', 'QUOTE_OUT_OF_STOCK');
  return new HttpError(409, 'The Curaleaf quote did not match this order. Payment is blocked for reconciliation.', 'QUOTE_RECONCILIATION_REQUIRED');
}

function assertOrderCanTakePayment(order: {
  status?: string | null;
  paymentStatus?: string | null;
  archivedAt?: string | null;
  resolutionStatus?: string | null;
}) {
  if (order.archivedAt || String(order.resolutionStatus || '').toUpperCase() === 'RESOLVED') {
    throw new HttpError(409, 'This order has already been resolved.', 'ORDER_ALREADY_RESOLVED');
  }
  if (['CANCELLED', 'COMPLETED'].includes(String(order.status || '').toUpperCase())) {
    throw new HttpError(409, 'A terminal order cannot take another payment.', 'ORDER_PAYMENT_TERMINAL');
  }
  if (['PAID', 'REFUND_REQUIRED', 'REFUNDED'].includes(String(order.paymentStatus || '').toUpperCase())) {
    throw new HttpError(409, 'This order already has a settled payment.', 'ORDER_ALREADY_PAID');
  }
}

function settledPayment<T extends { status: string }>(payments: T[]) {
  return payments.find(payment => ['PAID', 'REFUND_REQUIRED', 'REFUNDED'].includes(String(payment.status).toUpperCase())) ?? null;
}

async function queuePatientPaymentRequestEmail(input: {
  organisationId: string;
  orderId: string;
  order: { patientId: string; orderNumber: string | null; totalPence: number; medicineTotalPence: number; dispensingFeePence: number; pharmacyDeliveryPence: number; currency: string | null };
  paymentId: string;
  paymentUrl: string | undefined;
  notificationRepo: SqlNotificationRepository;
  organisationRepo: SqlOrganisationRepository;
  patientRepo: SqlPatientRepository;
}) {
  const [patient, organisation] = await Promise.all([
    input.patientRepo.findPatientById(input.organisationId, input.order.patientId).catch(() => null),
    input.organisationRepo.findOrganisationById(input.organisationId).catch(() => null),
  ]);
  if (!patient?.email || !input.paymentUrl || !input.paymentId) return;
  await queueEmailToRecipients(
    input.notificationRepo,
    [{ email: patient.email, displayName: patient.firstName || null }],
    'patient_payment_request',
    {
      firstName: patient.firstName || 'Patient',
      amountPence: input.order.totalPence,
      medicineTotalPence: input.order.medicineTotalPence,
      dispensingFeePence: input.order.dispensingFeePence,
      pharmacyDeliveryPence: input.order.pharmacyDeliveryPence,
      currency: input.order.currency || 'GBP',
      orderNumber: input.order.orderNumber,
      paymentUrl: input.paymentUrl,
      ...pharmacyEmailContext(organisation),
    },
    ['patient-payment-request', input.paymentId],
    { organisationId: input.organisationId, patientId: input.order.patientId, orderId: input.orderId },
  );
}

const refundSchema = z.object({
  amountPence: z.number().int().positive(),
  reason: z.string().min(1).max(500),
  idempotencyKey: z.string().min(8).max(128),
});

export function createPortalPaymentRouter(): Router {
  const router = Router();
  const paymentRepo = new SqlPaymentRepository();
  const orderRepo = new SqlOrderRepository();
  const orderLineRepo = new SqlOrderLineRepository();
  const integrationRepo = new SqlIntegrationRepository();

  /**
   * A hosted payment session that came back is the strongest evidence Worldpay
   * is working, so it feeds the Overview's integration chip. Fire-and-forget:
   * health bookkeeping must never fail a payment the patient is waiting on.
   */
  function noteVendorSuccess(organisationId: string, integration: 'CURALEAF' | 'WORLDPAY') {
    void integrationRepo.recordSuccessfulCall(organisationId, integration).catch(error => {
      console.warn(`Could not record ${integration} success for ${organisationId}:`, error);
    });
  }
  const identityRepo = new SqlIdentityRepository();
  const notificationRepo = new SqlNotificationRepository();
  const organisationRepo = new SqlOrganisationRepository();
  const patientRepo = new SqlPatientRepository();
  const patientFinanceRepo = new SqlPatientFinanceRepository();
  const patientFinanceDeps = { patientRepo, patientFinanceRepo };

  const createPrePaymentQuote = async (order: Awaited<ReturnType<SqlOrderRepository['findOrderById']>>, organisationId: string) => {
    if (!order) throw new HttpError(404, 'Order not found.', 'NOT_FOUND');
    const lines = await orderLineRepo.listByOrderId(order.id);
    const basket = lines.map(line => ({ packId: line.packId, quantity: Number(line.quantity) }));
    if (!basket.length) throw new HttpError(409, 'This order has no persisted order lines to quote.', 'QUOTE_BASKET_MISSING');
    const [connection, organisation] = await Promise.all([
      integrationRepo.findConnection(organisationId, 'CURALEAF').catch(() => null),
      organisationRepo.findOrganisationById(organisationId),
    ]);
    if (!organisation) throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
    assertCuraleafTestPaymentAllowed(organisation, connection?.environment);
    if (!connection?.secretResourceName) throw new HttpError(409, 'A live Curaleaf connection is required before payment.', 'QUOTE_UNAVAILABLE');
    const rawQuote = await fetchCuraleafQuote(connection, basket);
    const check = await paymentRepo.createQuoteCheck(quoteCheckInput({
      organisationId,
      orderId: order.id,
      phase: 'PRE_PAYMENT',
      basket,
      rawQuote,
      dispensingFeePence: Number(order.dispensingFeePence || 0),
      pharmacyDeliveryPence: Number(order.pharmacyDeliveryPence || 0),
      ...quotePricingPolicy(order.quoteSnapshot),
    }));
    await orderRepo.updateQuoteSnapshot({
      id: order.id,
      organisationId,
      quoteSnapshot: {
        // Every payment route passes through here, so this is the one place that can
        // guarantee the paid Curaleaf quote is frozen before money moves.
        ...stampPaidQuoteOnSnapshot(order.quoteSnapshot, rawQuote),
        paymentQuote: {
          id: check.id,
          phase: check.phase,
          status: check.status,
          basketFingerprint: check.basketFingerprint,
          quoteFingerprint: check.quoteFingerprint,
          patientTotalPence: Number(check.patientTotalPence),
          wholesaleTotalPence: Number(check.wholesaleTotalPence),
          shippingPence: Number(check.shippingPence),
          taxPence: Number(check.taxPence),
          checkedAt: check.createdAt,
        },
      },
    });
    if (!quoteGateAllowsPayment(check)) throw quoteGateError(check.status);
    return check;
  };

  // POST /v1/portal/orders/:id/payments/manual - Record manual pharmacy payment
  router.post('/portal/orders/:id/payments/manual', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const orderId = String(req.params.id || '');
      const input = manualPaymentSchema.parse(req.body);

      const order = await orderRepo.findOrderById(orderId, scope.organisationId);
      if (!order) {
        throw new HttpError(404, 'Order not found.', 'NOT_FOUND');
      }

      const receiptHash = sha256(`${scope.organisationId}:${orderId}:${input.tender}:${input.reference.trim()}`);
      const existingReceipt = await paymentRepo.findPaymentByReceiptHash(receiptHash);
      if (existingReceipt?.organisationId === scope.organisationId && existingReceipt.orderId === orderId && existingReceipt.status === 'PAID') {
        res.status(200).json({
          id: existingReceipt.id,
          status: 'PAID',
          amountPence: Number(existingReceipt.amountPence),
          tender: input.tender,
          reference: input.reference,
          reused: true,
        });
        return;
      }
      assertOrderCanTakePayment(order);
      const priorPayments = await paymentRepo.listPaymentsByOrderId(orderId, scope.organisationId);
      if (settledPayment(priorPayments)) throw new HttpError(409, 'This order already has a settled payment.', 'ORDER_ALREADY_PAID');

      const baseline = await createPrePaymentQuote(order, scope.organisationId);
      const quoteSnapshotWithBaseline = {
        // Freeze the paid per-pack quote if order creation never did. Without this the
        // order pays a real Curaleaf cost that finance can only ever call "awaiting quote".
        ...stampPaidQuoteOnSnapshot(order.quoteSnapshot, baseline.rawQuote),
        paymentQuote: {
          id: baseline.id,
          phase: baseline.phase,
          status: baseline.status,
          basketFingerprint: baseline.basketFingerprint,
          quoteFingerprint: baseline.quoteFingerprint,
          patientTotalPence: Number(baseline.patientTotalPence),
          wholesaleTotalPence: Number(baseline.wholesaleTotalPence),
          shippingPence: Number(baseline.shippingPence),
          taxPence: Number(baseline.taxPence),
          checkedAt: baseline.createdAt,
        },
      };
      const gatedAmountPence = Number(baseline.patientTotalPence);
      if (input.amountPence != null && input.amountPence !== gatedAmountPence) {
        throw new HttpError(409, 'The entered amount does not match the current Curaleaf quote.', 'PAYMENT_AMOUNT_MISMATCH');
      }
      const paymentResult = await paymentRepo.createPayment({
        organisationId: scope.organisationId,
        orderId,
        patientId: order.patientId,
        status: 'PAID',
        amountPence: gatedAmountPence,
        currency: 'GBP',
        route: 'MANUAL',
        receiptHash,
        manualTender: input.tender,
        manualReference: input.reference,
        baselineQuoteCheckId: baseline.id,
        basketFingerprint: baseline.basketFingerprint,
      });

      if (!paymentResult.id) throw new HttpError(503, 'The payment could not be stored.', 'PAYMENT_RECORD_MISSING');
      await paymentRepo.createPaymentAllocation({
        organisationId: scope.organisationId,
        paymentId: paymentResult.id,
        orderId,
        amountPence: gatedAmountPence,
      });

      const now = new Date().toISOString();
      await orderRepo.updateOrderStatus({
        id: orderId,
        organisationId: scope.organisationId,
        status: 'PROCESSING',
        paymentStatus: 'PAID',
        paidAt: now,
      });

      // Post-payment quote is a separate immutable gate before supplier placement.
      let curaleafResult: any = null;
      try {
        const connection = await integrationRepo.findConnection(scope.organisationId, 'CURALEAF').catch(() => null);
        if (connection?.secretResourceName) {
          const lines = await orderLineRepo.listByOrderId(orderId);
          const basket = lines.map(line => ({ packId: line.packId, quantity: Number(line.quantity) }));
          const rawQuote = await fetchCuraleafQuote(connection, basket);
          const postCheck = await paymentRepo.createQuoteCheck(quoteCheckInput({
            organisationId: scope.organisationId,
            orderId,
            paymentId: paymentResult.id,
            phase: 'POST_PAYMENT',
            basket,
            rawQuote,
            baseline,
            dispensingFeePence: Number(order.dispensingFeePence || 0),
            pharmacyDeliveryPence: Number(order.pharmacyDeliveryPence || 0),
            ...quotePricingPolicy(order.quoteSnapshot),
          }));
          if (postCheck.status === 'MATCHED') {
            curaleafResult = await executeCuraleafOrderPlacement(connection, {
              ...order,
              status: 'PROCESSING',
              paymentStatus: 'PAID',
              paidAt: now,
            });
          } else {
            await orderRepo.updateQuoteSnapshot({
              id: orderId,
              organisationId: scope.organisationId,
              quoteSnapshot: {
                ...quoteSnapshotWithBaseline,
                quoteReview: {
                  status: postCheck.status === 'OUT_OF_STOCK' ? 'required' : postCheck.status === 'REVIEW_REQUIRED' ? 'required' : 'recreate_required',
                  type: postCheck.status === 'OUT_OF_STOCK' ? 'out_of_stock' : 'patient_price_changed',
                  fingerprint: postCheck.quoteFingerprint,
                  baselineQuoteCheckId: baseline.id,
                  quoteCheckId: postCheck.id,
                  latestQuote: postCheck.rawQuote,
                  differences: (postCheck.comparison as { differences?: unknown[] } | null)?.differences ?? [],
                  patientDeltaPence: Number((postCheck.comparison as { patientDeltaPence?: number } | null)?.patientDeltaPence ?? 0),
                  checkedAt: postCheck.createdAt,
                },
              },
              fulfilmentStatus: 'SUPPLIER_PENDING',
            });
          }
        } else {
          throw new Error('Curaleaf connection unavailable for post-payment quote.');
        }
      } catch (placementErr) {
        await orderRepo.updateQuoteSnapshot({
          id: orderId,
          organisationId: scope.organisationId,
          quoteSnapshot: {
            ...quoteSnapshotWithBaseline,
            quoteReview: {
              status: 'recreate_required',
              type: 'patient_price_changed',
              fingerprint: baseline.quoteFingerprint,
              baselineQuoteCheckId: baseline.id,
              latestQuote: null,
              differences: [{ category: 'supplier_cost', field: 'postPaymentQuote', previous: 'required', latest: 'unavailable' }],
              patientDeltaPence: 0,
              checkedAt: new Date().toISOString(),
              attentionReason: 'post_payment_quote_unavailable',
            },
          },
          fulfilmentStatus: 'SUPPLIER_PENDING',
        });
        await orderRepo.appendPlacementEvent({
          organisationId: scope.organisationId,
          orderId,
          fromState: 'PENDING_PLACEMENT',
          toState: 'PENDING_PLACEMENT',
          reason: 'Payment recorded; placement blocked because the post-payment Curaleaf quote could not be verified',
          actorUid: scope.uid,
        });
        console.warn('[Manual Payment] Curaleaf automated placement note:', placementErr instanceof Error ? placementErr.message : 'Unknown error');
      }

      await promotePatientAfterCuraleafPlacement(patientFinanceDeps, order, curaleafResult).catch(err =>
        console.warn('Patient activation after Curaleaf placement note:', err),
      );

      await orderRepo.appendPlacementEvent({
        organisationId: scope.organisationId,
        orderId,
        fromState: 'PENDING_PLACEMENT',
        toState: curaleafResult?.purchaseOrder?.id ? 'PLACED' : 'PENDING_PLACEMENT',
        reason: curaleafResult?.purchaseOrder?.id
          ? `Manual payment recorded (${input.tender}: ${input.reference}) - Curaleaf Purchase Order ${curaleafResult.purchaseOrder.id} placed automatically`
          : curaleafResult?.skipped
            ? `Manual payment recorded (${input.tender}: ${input.reference}) - Curaleaf placement waiting (${curaleafResult.reason})`
            : `Manual payment recorded (${input.tender}: ${input.reference})`,
        externalReference: curaleafResult?.purchaseOrder?.id || curaleafResult?.prescriptionId || input.reference,
        actorUid: scope.uid,
      });

      const [patient, organisation] = await Promise.all([
        patientRepo.findPatientById(scope.organisationId, order.patientId).catch(() => null),
        organisationRepo.findOrganisationById(scope.organisationId).catch(() => null),
      ]);
      if (patient?.email) {
        await queueEmailToRecipients(
          notificationRepo,
          [{ email: patient.email, displayName: patient.firstName || null }],
          'patient_payment_confirmation',
          {
            firstName: patient.firstName || 'Patient',
            amountPence: gatedAmountPence,
            medicineTotalPence: order.medicineTotalPence,
            dispensingFeePence: order.dispensingFeePence,
            pharmacyDeliveryPence: order.pharmacyDeliveryPence,
            currency: 'GBP',
            orderNumber: order.orderNumber,
            receiptHash,
            ...pharmacyEmailContext(organisation),
          },
          ['patient-payment-confirmation', paymentResult.id, receiptHash],
          { organisationId: scope.organisationId, patientId: order.patientId, orderId },
        );
      }
      const pharmacyRecipients = await listPharmacyRecipients(scope.organisationId, { identityRepo, organisationRepo });
      await queueEmailToRecipients(
        notificationRepo,
        pharmacyRecipients,
        'pharmacy_payment_received',
        {
          amountPence: gatedAmountPence,
          currency: 'GBP',
          orderNumber: order.orderNumber,
        },
        ['pharmacy-payment-received', paymentResult.id],
        { organisationId: scope.organisationId, patientId: order.patientId, orderId },
      );

      res.status(200).json({
        id: paymentResult.id,
        status: 'PAID',
        amountPence: gatedAmountPence,
        paidAt: now,
        tender: input.tender,
        reference: input.reference,
        curaleaf: curaleafResult,
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/portal/orders/:id/payments/worldpay-session - Create Worldpay checkout session
  router.post('/portal/orders/:id/payments/worldpay-session', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const orderId = String(req.params.id || '');
      worldpaySessionSchema.parse(req.body);

      const order = await orderRepo.findOrderById(orderId, scope.organisationId);
      if (!order) {
        throw new HttpError(404, 'Order not found.', 'NOT_FOUND');
      }

      assertOrderCanTakePayment(order);
      const priorPayments = await paymentRepo.listPaymentsByOrderId(orderId, scope.organisationId);
      if (settledPayment(priorPayments)) throw new HttpError(409, 'This order already has a settled payment.', 'ORDER_ALREADY_PAID');

      const baseline = await createPrePaymentQuote(order, scope.organisationId);
      const reusable = priorPayments.find(payment => (
        payment.route === 'WORLDPAY'
        && payment.status === 'PENDING'
        && Number(payment.amountPence) === Number(baseline.patientTotalPence)
        && payment.currency === (order.currency || 'GBP')
        && payment.basketFingerprint === baseline.basketFingerprint
        && Boolean(payment.hostedPaymentUrl)
        && (!payment.linkExpiresAt || Date.parse(payment.linkExpiresAt) > Date.now())
      ));
      if (reusable) {
        res.status(200).json({
          paymentId: reusable.id,
          transactionReference: reusable.transactionReference,
          provider: { url: reusable.hostedPaymentUrl, _links: { redirect: { href: reusable.hostedPaymentUrl } } },
          linkExpiresAt: reusable.linkExpiresAt,
          reused: true,
        });
        return;
      }
      const connection = await integrationRepo.findConnection(scope.organisationId, 'WORLDPAY').catch(() => null);
      const transactionReference = createWorldpayTransactionReference();

      const successUrl = `https://holistichealthhub.live/payment/success?ref=${encodeURIComponent(transactionReference)}`;
      const cancelUrl = `https://holistichealthhub.live/payment/cancelled?ref=${encodeURIComponent(transactionReference)}`;

      const session = await createWorldpayHostedSession(connection, scope.organisationId, {
        orderNumber: order.orderNumber || orderId,
        transactionReference,
        amountPence: Number(baseline.patientTotalPence),
        currency: order.currency || 'GBP',
        statementNarrative: order.orderNumber || 'HHH Order',
        successUrl,
        cancelUrl,
      });
      noteVendorSuccess(scope.organisationId, 'WORLDPAY');

      const paymentResult = await paymentRepo.createPayment({
        organisationId: scope.organisationId,
        orderId,
        patientId: order.patientId,
        status: 'PENDING',
        amountPence: Number(baseline.patientTotalPence),
        currency: order.currency || 'GBP',
        route: 'WORLDPAY',
        transactionReference: session.transactionReference,
        hostedPaymentUrl: session.url,
        linkExpiresAt: session.expiresAt,
        baselineQuoteCheckId: baseline.id,
        basketFingerprint: baseline.basketFingerprint,
      });

      if (!paymentResult.id) throw new HttpError(503, 'The Worldpay payment link could not be stored.', 'PAYMENT_RECORD_MISSING');
      await paymentRepo.bindPaymentQuote({ paymentId: paymentResult.id, baselineQuoteCheckId: baseline.id, basketFingerprint: baseline.basketFingerprint });

      await queuePatientPaymentRequestEmail({
        organisationId: scope.organisationId,
        orderId,
        order: { ...order, totalPence: Number(baseline.patientTotalPence) },
        paymentId: paymentResult.id || '',
        paymentUrl: session.url,
        notificationRepo,
        organisationRepo,
        patientRepo,
      });

      res.status(200).json({
        paymentId: paymentResult.id || '',
        transactionReference: session.transactionReference,
        provider: {
          url: session.url,
          _links: {
            redirect: {
              href: session.url,
            },
          },
        },
        linkExpiresAt: session.expiresAt,
        reused: false,
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/portal/orders/:id/payment-links/resend - Resend/refresh payment link
  router.post('/portal/orders/:id/payment-links/resend', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const orderId = String(req.params.id || '');

      const order = await orderRepo.findOrderById(orderId, scope.organisationId);
      if (!order) {
        throw new HttpError(404, 'Order not found.', 'NOT_FOUND');
      }

      assertOrderCanTakePayment(order);
      const priorPayments = await paymentRepo.listPaymentsByOrderId(orderId, scope.organisationId);
      if (settledPayment(priorPayments)) throw new HttpError(409, 'This order already has a settled payment.', 'ORDER_ALREADY_PAID');

      const baseline = await createPrePaymentQuote(order, scope.organisationId);
      const connection = await integrationRepo.findConnection(scope.organisationId, 'WORLDPAY').catch(() => null);
      const transactionReference = createWorldpayTransactionReference();
      const successUrl = `https://holistichealthhub.live/payment/success?ref=${encodeURIComponent(transactionReference)}`;
      const cancelUrl = `https://holistichealthhub.live/payment/cancelled?ref=${encodeURIComponent(transactionReference)}`;

      const session = await createWorldpayHostedSession(connection, scope.organisationId, {
        orderNumber: order.orderNumber || orderId,
        transactionReference,
        amountPence: Number(baseline.patientTotalPence),
        currency: order.currency || 'GBP',
        statementNarrative: order.orderNumber || 'HHH Order',
        successUrl,
        cancelUrl,
      });
      noteVendorSuccess(scope.organisationId, 'WORLDPAY');

      const paymentResult = await paymentRepo.createPayment({
        organisationId: scope.organisationId,
        orderId,
        patientId: order.patientId,
        status: 'PENDING',
        amountPence: Number(baseline.patientTotalPence),
        currency: order.currency || 'GBP',
        route: 'WORLDPAY',
        transactionReference: session.transactionReference,
        hostedPaymentUrl: session.url,
        linkExpiresAt: session.expiresAt,
        baselineQuoteCheckId: baseline.id,
        basketFingerprint: baseline.basketFingerprint,
      });

      if (!paymentResult.id) throw new HttpError(503, 'The Worldpay payment link could not be stored.', 'PAYMENT_RECORD_MISSING');
      await paymentRepo.bindPaymentQuote({ paymentId: paymentResult.id, baselineQuoteCheckId: baseline.id, basketFingerprint: baseline.basketFingerprint });

      await orderRepo.appendPlacementEvent({
        organisationId: scope.organisationId,
        orderId,
        fromState: 'PENDING_PLACEMENT',
        toState: 'PENDING_PLACEMENT',
        reason: `Re-issued Worldpay checkout link (${session.transactionReference})`,
        externalReference: session.transactionReference,
        actorUid: scope.uid,
      });

      await queuePatientPaymentRequestEmail({
        organisationId: scope.organisationId,
        orderId,
        order: { ...order, totalPence: Number(baseline.patientTotalPence) },
        paymentId: paymentResult.id || '',
        paymentUrl: session.url,
        notificationRepo,
        organisationRepo,
        patientRepo,
      });

      res.status(200).json({
        paymentId: paymentResult.id || '',
        transactionReference: session.transactionReference,
        provider: {
          url: session.url,
          _links: {
            redirect: {
              href: session.url,
            },
          },
        },
        linkExpiresAt: session.expiresAt,
      });
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/portal/orders/:id/payments - Record payment or generate payment link
  router.post('/portal/orders/:id/payments', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertTenantScope(req.context!);
      createPaymentSchema.parse(req.body);
      throw new HttpError(410, 'Use the quote-gated manual payment or Worldpay session endpoint.', 'PAYMENT_ENDPOINT_RETIRED');
    } catch (error) {
      next(error);
    }
  });

  // GET /v1/portal/payments - List tenant payments
  router.get('/portal/payments', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const payments = await paymentRepo.listTenantPayments(scope.organisationId);
      res.status(200).json(payments);
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/portal/payments/:id/refunds - Issue idempotent refund
  router.post('/portal/payments/:id/refunds', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const paymentId = String(req.params.id || '');
      const input = refundSchema.parse(req.body);
      const idempotencyKeyHash = sha256(`${scope.organisationId}:${input.idempotencyKey}`);

      const stored = (await paymentRepo.listTenantPayments(scope.organisationId, 500)).find(row => row.id === paymentId);
      if (!stored) throw new HttpError(404, 'Payment not found.', 'NOT_FOUND');
      const order = await orderRepo.findOrderById(stored.orderId, scope.organisationId);
      if (!order) throw new HttpError(404, 'Order not found.', 'NOT_FOUND');
      if (order.archivedAt || String(order.resolutionStatus || '').toUpperCase() === 'RESOLVED') {
        throw new HttpError(409, 'This order has already been resolved and cannot start another refund.', 'ORDER_ALREADY_RESOLVED');
      }
      if (!['PAID', 'REFUND_REQUIRED'].includes(stored.status)) {
        throw new HttpError(409, 'Only a settled payment can be prepared for refund.', 'PAYMENT_NOT_SETTLED');
      }
      const existingIdempotentRefund = await paymentRepo.findRefundByIdempotencyKey(idempotencyKeyHash, scope.organisationId);
      if (existingIdempotentRefund) {
        if (existingIdempotentRefund.paymentId !== paymentId || existingIdempotentRefund.orderId !== stored.orderId) {
          throw new HttpError(409, 'This idempotency key is already bound to another refund.', 'REFUND_IDEMPOTENCY_CONFLICT');
        }
        res.status(200).json({ id: existingIdempotentRefund.id, status: String(existingIdempotentRefund.status).toLowerCase(), reused: true });
        return;
      }
      const priorRefunds = await paymentRepo.listRefundsByOrderId(stored.orderId, scope.organisationId);
      const alreadyRefundedPence = priorRefunds
        .filter(row => ['PENDING_CONFIRMATION', 'VERIFICATION_PENDING', 'COMPLETED'].includes(String(row.status).toUpperCase()))
        .reduce((total, row) => total + Number(row.amountPence || 0), 0);
      if (alreadyRefundedPence + input.amountPence > Number(stored.amountPence)) {
        throw new HttpError(409, 'Refunds cannot exceed the settled payment.', 'REFUND_AMOUNT_EXCEEDS_PAYMENT');
      }
      const refundResult = await paymentRepo.createRefund({
        organisationId: scope.organisationId,
        orderId: stored.orderId,
        paymentId,
        amountPence: input.amountPence,
        currency: stored.currency || 'GBP',
        cause: input.reason,
        route: stored.route,
        status: 'PENDING_CONFIRMATION',
        idempotencyKey: idempotencyKeyHash,
      });

      res.status(201).json({ id: refundResult.id, status: 'refund_pending_confirmation' });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
