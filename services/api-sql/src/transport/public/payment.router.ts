import { Router, type Request, type Response, type NextFunction } from 'express';
import { HttpError } from '../../domain/common/errors.js';
import { reconcileWorldpayPaymentRecord } from '../../application/payments/worldpay-reconciliation.js';
import { isUsablePublicPaymentLookup, publicPaymentStatusBody, transactionReferenceFromWorldpayWebhook } from '../../application/payments/worldpay-query.js';
import { buildPublicPaymentReceipt } from '../../application/payments/public-receipt.js';
import { SqlIntegrationRepository } from '../../repositories/sql/integration.sql.js';
import { SqlIdentityRepository } from '../../repositories/sql/identity.sql.js';
import { SqlNotificationRepository } from '../../repositories/sql/notification.sql.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { SqlOrderRepository } from '../../repositories/sql/order.sql.js';
import { SqlPatientFinanceRepository } from '../../repositories/sql/patient-finance.sql.js';
import { SqlPatientRepository } from '../../repositories/sql/patient.sql.js';
import { SqlPaymentRepository } from '../../repositories/sql/payment.sql.js';
import { publicPaymentStatusLimiter, publicWebhookLimiter } from '../../security/public-limits.js';
import { sha256 } from '../../security/session-utils.js';

export function createPublicPaymentRouter(): Router {
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
  const settlementDeps = { paymentRepo, orderRepo, integrationRepo, patientFinanceDeps, patientRepo, notificationRepo, identityRepo, organisationRepo };

  // GET /v1/public/payments/status - Check real-time payment clearance status
  router.get('/public/payments/status', publicPaymentStatusLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawRef = String(req.query.ref || req.query.transactionReference || req.query.orderCode || '').trim();
      const rawReceipt = String(req.query.receipt || req.query.receiptHash || '').trim();
      const ref = isUsablePublicPaymentLookup(rawRef) ? rawRef : '';
      const receipt = isUsablePublicPaymentLookup(rawReceipt) ? rawReceipt : '';

      if (!ref && !receipt) {
        throw new HttpError(400, 'Missing reference or receipt parameter.', 'INVALID_PARAMETERS');
      }

      let payment = ref ? await paymentRepo.findPaymentByWorldpayCode(ref) : null;
      if (!payment && receipt) {
        payment = await paymentRepo.findPaymentByReceiptHash(receipt);
        if (!payment && receipt.length !== 64) {
          payment = await paymentRepo.findPaymentByReceiptHash(sha256(receipt));
        }
      }

      if (!payment) {
        res.status(200).json(publicPaymentStatusBody(null, ref || null));
        return;
      }

      if (payment.status === 'PENDING' && payment.route === 'WORLDPAY') {
        await reconcileWorldpayPaymentRecord(payment, settlementDeps);
        const refreshedRef = String(payment.transactionReference || ref).trim();
        if (refreshedRef) {
          payment = await paymentRepo.findPaymentByWorldpayCode(refreshedRef) ?? payment;
        }
      }

      res.status(200).json(publicPaymentStatusBody(payment, ref || receipt || null));
    } catch (error) {
      next(error);
    }
  });

  // GET /v1/public/receipts/:receiptHash - Look up public receipt token
  router.get('/public/receipts/:receiptHash', publicPaymentStatusLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const receiptHash = String(req.params.receiptHash || '').trim().toLowerCase();
      if (!receiptHash || receiptHash.length !== 64 || !/^[a-f0-9]{64}$/.test(receiptHash)) {
        throw new HttpError(404, 'Receipt not found.', 'NOT_FOUND');
      }

      const payment = await paymentRepo.findPaymentByReceiptHash(receiptHash);
      if (!payment) {
        throw new HttpError(404, 'Receipt not found.', 'NOT_FOUND');
      }

      const [order, refunds] = await Promise.all([
        orderRepo.findOrderById(payment.orderId, payment.organisationId).catch(() => null),
        paymentRepo.listRefundsByOrderId(payment.orderId, payment.organisationId).catch(() => []),
      ]);

      res.status(200).json(buildPublicPaymentReceipt({
        payment,
        orderNumber: order?.orderNumber ?? null,
        order: order
          ? {
              medicineTotalPence: order.medicineTotalPence,
              dispensingFeePence: order.dispensingFeePence,
              pharmacyDeliveryPence: order.pharmacyDeliveryPence,
              deliveryPence: order.deliveryPence,
            }
          : null,
        completedRefunds: refunds,
      }));
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/public/payments/worldpay/webhook - Worldpay async payment notification
  router.post('/public/payments/worldpay/webhook', publicWebhookLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const transactionReference = transactionReferenceFromWorldpayWebhook(req.body);
      if (!transactionReference) {
        res.status(200).json({ accepted: true, ignored: true });
        return;
      }

      const payment = await paymentRepo.findPaymentByWorldpayCode(transactionReference);
      if (!payment) {
        console.warn('[Worldpay Webhook] Unmatched payment notification');
        res.status(200).json({ accepted: true, unmatched: true });
        return;
      }

      const outcome = await reconcileWorldpayPaymentRecord(payment, settlementDeps);
      if (outcome.state === 'verification_pending') {
        res.status(200).json({ accepted: true, verificationPending: true });
        return;
      }
      if (outcome.state === 'reconciliation_required') {
        res.status(200).json({ accepted: true, reconciliationRequired: true });
        return;
      }

      res.status(200).json({ accepted: true, reconciled: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
