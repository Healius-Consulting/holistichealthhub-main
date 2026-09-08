import { Router } from 'express';
import { z } from 'zod';
import { assertTenantScope } from '../../security/request-context.js';
import { requireStaff } from '../../security/require-staff.js';
import { requireCsrf } from '../../security/csrf.js';
import { requirePharmacyOperationalWrites } from './require-operational-writes.js';
import { SqlOrderRepository } from '../../repositories/sql/order.sql.js';
import { SqlOrderLineRepository } from '../../repositories/sql/order-line.sql.js';
import { SqlPaymentRepository } from '../../repositories/sql/payment.sql.js';
import { SqlIntegrationRepository } from '../../repositories/sql/integration.sql.js';
import {
  previewPrescriptionRefund, submitPrescriptionRefund, confirmPrescriptionRefund,
  type PrescriptionRefundDeps,
} from '../../application/payments/prescription-refund-service.js';
import { portalRefundFromSql } from '../../application/orders/paid-refund.js';

const requestSchema = z.object({
  previewVersion: z.string().length(64),
  requestId: z.string().uuid(),
  medicines: z.array(z.object({ orderLineId: z.string().uuid(), quantity: z.number().int().positive() })).max(80),
  dispensingPercent: z.number().int(),
  deliveryPercent: z.number().int(),
});

const confirmSchema = z.object({ externalReference: z.string().trim().min(3).max(160) });

export function createPrescriptionRefundRouter(deps: PrescriptionRefundDeps = {
  orderRepo: new SqlOrderRepository(),
  lineRepo: new SqlOrderLineRepository(),
  paymentRepo: new SqlPaymentRepository(),
  integrationRepo: new SqlIntegrationRepository(),
}) {
  const router = Router();
  const route = '/portal/orders/:orderId/prescriptions/:prescriptionId/refunds';

  router.get(`${route}/preview`, requireStaff('pharmacy'), async (req, res, next) => {
    try {
      const scope = assertTenantScope(req.context!);
      res.json(await previewPrescriptionRefund(deps, scope, String(req.params.orderId), String(req.params.prescriptionId)));
    } catch (error) { next(error); }
  });

  router.post(route, requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req, res, next) => {
    try {
      const scope = assertTenantScope(req.context!);
      const input = requestSchema.parse(req.body);
      const { refund, reused } = await submitPrescriptionRefund(deps, scope, String(req.params.orderId), String(req.params.prescriptionId), input);
      res.status(reused ? 200 : 201).json(portalRefundFromSql(refund));
    } catch (error) { next(error); }
  });

  router.post(`${route}/:refundId/confirm`, requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req, res, next) => {
    try {
      const scope = assertTenantScope(req.context!);
      const { externalReference } = confirmSchema.parse(req.body);
      const refund = await confirmPrescriptionRefund(deps, scope, String(req.params.orderId), String(req.params.prescriptionId), String(req.params.refundId), externalReference);
      res.json(portalRefundFromSql(refund));
    } catch (error) { next(error); }
  });

  return router;
}
