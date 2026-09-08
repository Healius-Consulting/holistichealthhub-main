import { SqlPaymentRepository } from '../services/api-sql/src/repositories/sql/payment.sql.js';
import { SqlOrderRepository } from '../services/api-sql/src/repositories/sql/order.sql.js';
import { SqlOrderLineRepository } from '../services/api-sql/src/repositories/sql/order-line.sql.js';
import { historicalPrescriptionRefundBreakdown } from '../services/api-sql/src/application/payments/prescription-refund-backfill.js';
import { dataConnect } from '../services/api-sql/src/bootstrap/firebase.js';

const organisationId = process.argv.find(value => value.startsWith('--organisation='))?.split('=')[1];
if (!organisationId) throw new Error('Specify --organisation=<tenant UUID>. Defaults to dry run; --apply writes proven breakdowns.');
const apply = process.argv.includes('--apply');
const paymentRepo = new SqlPaymentRepository();
const orderRepo = new SqlOrderRepository();
const lineRepo = new SqlOrderLineRepository();
const refunds = await paymentRepo.listTenantRefunds(organisationId, 10000);
const result = { reviewed: 0, eligible: 0, updated: 0, reconciliationRequired: 0, alreadyScoped: 0, apply };
for (const refund of refunds) {
  if (refund.prescriptionId) { result.alreadyScoped++; continue; }
  result.reviewed++;
  const order = await orderRepo.findOrderById(refund.orderId, organisationId);
  const lines = order ? await lineRepo.listByOrderId(order.id) : [];
  const breakdown = order ? historicalPrescriptionRefundBreakdown(order, lines, refund) : null;
  if (!breakdown) { result.reconciliationRequired++; continue; }
  result.eligible++;
  if (apply) {
    await dataConnect.executeGraphql(`mutation BackfillRefundBreakdown($id: UUID!, $organisationId: UUID!, $prescriptionId: UUID!, $breakdown: Any!) {
      refund_updateMany(where: { id: { eq: $id }, organisationId: { eq: $organisationId }, prescriptionId: { isNull: true }, breakdown: { isNull: true }, status: { eq: COMPLETED } },
        data: { prescriptionId: $prescriptionId, breakdown: $breakdown }) @check(expr: "this == 1", message: "REFUND_BACKFILL_CONFLICT")
    }`, { variables: { id: refund.id, organisationId, prescriptionId: breakdown.prescriptionId, breakdown } });
    result.updated++;
  }
}
console.log(JSON.stringify(result));
