import { Router } from 'express';
import { assertTenantScope } from '../../security/request-context.js';
import { requireStaff } from '../../security/require-staff.js';
import { SqlOrderRepository } from '../../repositories/sql/order.sql.js';
import { SqlOrderLineRepository } from '../../repositories/sql/order-line.sql.js';
import { SqlPaymentRepository } from '../../repositories/sql/payment.sql.js';
import { SqlIntegrationRepository } from '../../repositories/sql/integration.sql.js';
import { loadPrescriptionRefundContext, type PrescriptionRefundDeps } from '../../application/payments/prescription-refund-service.js';
import { prescriptionReplacementPreview, resolvePrescriptionReplacement } from '../../application/orders/prescription-replacement.js';

/**
 * What a replacement of one cancelled prescription would carry over. The checkout
 * shows this before the draft is committed, so staff see the medicine value that
 * moves and whether the shared charges stay with a live sibling.
 */
export function createPrescriptionReplacementRouter(deps: PrescriptionRefundDeps = {
  orderRepo: new SqlOrderRepository(),
  lineRepo: new SqlOrderLineRepository(),
  paymentRepo: new SqlPaymentRepository(),
  integrationRepo: new SqlIntegrationRepository(),
}) {
  const router = Router();
  router.get('/portal/orders/:orderId/prescriptions/:prescriptionId/replacement-preview', requireStaff('pharmacy'), async (req, res, next) => {
    try {
      const scope = assertTenantScope(req.context!);
      const context = await loadPrescriptionRefundContext(deps, scope, String(req.params.orderId), String(req.params.prescriptionId));
      res.json(prescriptionReplacementPreview(resolvePrescriptionReplacement(context)));
    } catch (error) { next(error); }
  });
  return router;
}
