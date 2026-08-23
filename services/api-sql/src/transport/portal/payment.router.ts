import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { HttpError } from '../../domain/common/errors.js';
import { executeCuraleafOrderPlacement } from '../../application/integrations/curaleaf.service.js';
import { persistCuraleafPrescriptionIdentity } from '../../application/prescriptions/curaleaf-prescription-record.js';
import { promotePatientAfterCuraleafPlacement } from '../../application/patient-finance/patient-finance.js';
import { createWorldpayHostedSession } from '../../application/integrations/worldpay.service.js';
import { createWorldpayTransactionReference } from '../../application/payments/worldpay-reference.js';
import { SqlIntegrationRepository } from '../../repositories/sql/integration.sql.js';
import { SqlIdentityRepository } from '../../repositories/sql/identity.sql.js';
import { listPharmacyRecipients, pharmacyEmailContext, queueEmailToRecipients } from '../../application/notifications/email-outbox.js';
import { SqlNotificationRepository } from '../../repositories/sql/notification.sql.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { SqlOrderRepository } from '../../repositories/sql/order.sql.js';
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
  amountPence: z.number().int().positive(),
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

async function queuePatientPaymentRequestEmail(input: {
  organisationId: string;
  orderId: string;
  order: { patientId: string; orderNumber: string | null; totalPence: number; currency: string | null };
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
  const integrationRepo = new SqlIntegrationRepository();
  const identityRepo = new SqlIdentityRepository();
  const notificationRepo = new SqlNotificationRepository();
  const organisationRepo = new SqlOrganisationRepository();
  const patientRepo = new SqlPatientRepository();
  const patientFinanceRepo = new SqlPatientFinanceRepository();
  const patientFinanceDeps = { patientRepo, patientFinanceRepo };

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

      const receiptHash = sha256(`${orderId}:${input.reference}:${Date.now()}`);
      const paymentResult = await paymentRepo.createPayment({
        organisationId: scope.organisationId,
        orderId,
        patientId: order.patientId,
        status: 'PAID',
        amountPence: input.amountPence,
        currency: 'GBP',
        route: 'MANUAL',
        receiptHash,
        manualTender: input.tender,
        manualReference: input.reference,
      });

      const now = new Date().toISOString();
      await orderRepo.updateOrderStatus({
        id: orderId,
        organisationId: scope.organisationId,
        status: 'PROCESSING',
        paymentStatus: 'PAID',
        paidAt: now,
      });

      // Automated Curaleaf Placement Workflow
      let curaleafResult: any = null;
      try {
        const connection = await integrationRepo.findConnection(scope.organisationId, 'CURALEAF').catch(() => null);
        if (connection?.secretResourceName) {
          curaleafResult = await executeCuraleafOrderPlacement(connection, {
            ...order,
            status: 'PROCESSING',
            paymentStatus: 'PAID',
            paidAt: now,
          });
        }
      } catch (placementErr) {
        console.warn('[Manual Payment] Curaleaf automated placement note:', placementErr);
      }

      if (curaleafResult?.prescriptionId || curaleafResult?.purchaseOrder) {
        await persistCuraleafPrescriptionIdentity({
          organisationId: scope.organisationId,
          orderId,
          patientId: order.patientId,
          snapshot: order.quoteSnapshot,
          prescriptionId: curaleafResult.prescriptionId,
          prescriberId: curaleafResult.prescriberId,
          purchaseOrder: curaleafResult.purchaseOrder ?? null,
          fulfilmentStatus: curaleafResult.purchaseOrder ? 'SUPPLIER_PROCESSING' : undefined,
        });
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
            amountPence: input.amountPence,
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
          amountPence: input.amountPence,
          currency: 'GBP',
          orderNumber: order.orderNumber,
        },
        ['pharmacy-payment-received', paymentResult.id],
        { organisationId: scope.organisationId, patientId: order.patientId, orderId },
      );

      res.status(200).json({
        id: paymentResult.id,
        status: 'PAID',
        amountPence: input.amountPence,
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

      const connection = await integrationRepo.findConnection(scope.organisationId, 'WORLDPAY').catch(() => null);
      const transactionReference = createWorldpayTransactionReference();

      const successUrl = `https://holistichealthhub.cc/payment/success?ref=${encodeURIComponent(transactionReference)}`;
      const cancelUrl = `https://holistichealthhub.cc/payment/cancelled?ref=${encodeURIComponent(transactionReference)}`;

      const session = await createWorldpayHostedSession(connection, scope.organisationId, {
        orderNumber: order.orderNumber || orderId,
        transactionReference,
        amountPence: order.totalPence,
        currency: order.currency || 'GBP',
        statementNarrative: order.orderNumber || 'HHH Order',
        successUrl,
        cancelUrl,
      });

      const paymentResult = await paymentRepo.createPayment({
        organisationId: scope.organisationId,
        orderId,
        patientId: order.patientId,
        status: 'PENDING',
        amountPence: order.totalPence,
        currency: order.currency || 'GBP',
        route: 'WORLDPAY',
        transactionReference: session.transactionReference,
        hostedPaymentUrl: session.url,
      });

      await queuePatientPaymentRequestEmail({
        organisationId: scope.organisationId,
        orderId,
        order,
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

      const connection = await integrationRepo.findConnection(scope.organisationId, 'WORLDPAY').catch(() => null);
      const transactionReference = createWorldpayTransactionReference();
      const successUrl = `https://holistichealthhub.cc/payment/success?ref=${encodeURIComponent(transactionReference)}`;
      const cancelUrl = `https://holistichealthhub.cc/payment/cancelled?ref=${encodeURIComponent(transactionReference)}`;

      const session = await createWorldpayHostedSession(connection, scope.organisationId, {
        orderNumber: order.orderNumber || orderId,
        transactionReference,
        amountPence: order.totalPence,
        currency: order.currency || 'GBP',
        statementNarrative: order.orderNumber || 'HHH Order',
        successUrl,
        cancelUrl,
      });

      const paymentResult = await paymentRepo.createPayment({
        organisationId: scope.organisationId,
        orderId,
        patientId: order.patientId,
        status: 'PENDING',
        amountPence: order.totalPence,
        currency: order.currency || 'GBP',
        route: 'WORLDPAY',
        transactionReference: session.transactionReference,
        hostedPaymentUrl: session.url,
      });

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
        order,
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
      const scope = assertTenantScope(req.context!);
      const orderId = String(req.params.id || '');
      const input = createPaymentSchema.parse(req.body);

      const order = await orderRepo.findOrderById(orderId, scope.organisationId);
      if (!order) {
        throw new HttpError(404, 'Order not found.', 'NOT_FOUND');
      }

      const transactionReference = input.route === 'WORLDPAY' ? createWorldpayTransactionReference() : null;
      const receiptToken = input.route === 'MANUAL' ? crypto.randomUUID() : null;
      const receiptHash = receiptToken ? sha256(receiptToken) : null;
      const initialStatus = input.route === 'MANUAL' ? 'PAID' : 'PENDING';

      const paymentResult = await paymentRepo.createPayment({
        organisationId: scope.organisationId,
        orderId,
        patientId: order.patientId,
        status: initialStatus,
        amountPence: input.amountPence,
        currency: input.currency,
        route: input.route,
        transactionReference,
        receiptHash,
      });

      if (initialStatus === 'PAID' && paymentResult.id) {
        await paymentRepo.updatePaymentStatus(paymentResult.id, 'PAID', orderId, receiptHash);
      }

      res.status(201).json({
        id: paymentResult.id,
        status: initialStatus,
        worldpayOrderCode: transactionReference,
        receiptToken,
      });
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
      const idempotencyKeyHash = sha256(input.idempotencyKey);

      const stored = (await paymentRepo.listTenantPayments(scope.organisationId, 500)).find(row => row.id === paymentId);
      if (!stored) throw new HttpError(404, 'Payment not found.', 'NOT_FOUND');
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
