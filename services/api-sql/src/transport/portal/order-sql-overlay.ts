import { portalRefundFromSql } from '../../application/orders/paid-refund.js';
import type { OrderLineRecord } from '../../repositories/ports/order-line.port.js';
import type { OrderRecord } from '../../repositories/ports/order.port.js';
import type { PaymentAllocationRecord, QuoteCheckRecord, RefundRecord } from '../../repositories/ports/payment.port.js';
import type { SqlOrderLineRepository } from '../../repositories/sql/order-line.sql.js';
import type { SqlPaymentRepository } from '../../repositories/sql/payment.sql.js';
import { toPortalOrder, type PortalSqlLine } from './pharmacy-contracts.js';

export type OrderSqlChildren = {
  refunds: RefundRecord[];
  lines: OrderLineRecord[];
  quoteChecks?: QuoteCheckRecord[];
  paymentAllocations?: PaymentAllocationRecord[];
};

export function sqlLinesToPortal(lines: OrderLineRecord[]): PortalSqlLine[] {
  return lines.map(line => ({
    packId: line.packId,
    productId: line.packId,
    formulaId: line.formulaId || undefined,
    name: line.formulaName || undefined,
    quantity: Number(line.quantity || 0),
    prescriptionId: line.prescriptionId ?? undefined,
    unitPricePence: Number(line.fixedPatientPricePence || 0),
    wholesalePackPricePence: line.wholesalePackPricePence == null ? undefined : Number(line.wholesalePackPricePence),
  }));
}

export function latestRefund(rows: RefundRecord[]) {
  return [...rows].sort((left, right) => (
    Date.parse(String(right.createdAt || 0)) - Date.parse(String(left.createdAt || 0))
  ))[0] ?? null;
}

export function latestPaymentAllocation(rows: PaymentAllocationRecord[]) {
  return [...rows].sort((left, right) => (
    Date.parse(String(right.updatedAt || right.createdAt || 0)) - Date.parse(String(left.updatedAt || left.createdAt || 0))
  ))[0] ?? null;
}

export function mapPortalOrderFromSql(order: OrderRecord, children?: OrderSqlChildren) {
  const refund = children?.refunds?.length ? latestRefund(children.refunds) : null;
  const paymentAllocation = children?.paymentAllocations?.length
    ? latestPaymentAllocation(children.paymentAllocations)
    : null;
  return toPortalOrder({
    ...order,
    sqlRefund: refund ? portalRefundFromSql(refund) : undefined,
    sqlLines: children?.lines?.length ? sqlLinesToPortal(children.lines) : undefined,
    sqlQuoteChecks: children?.quoteChecks?.length ? children.quoteChecks : undefined,
    sqlPaymentAllocation: paymentAllocation,
  });
}

export async function loadOrganisationOrderChildren(
  organisationId: string,
  paymentRepo: SqlPaymentRepository,
  orderLineRepo: SqlOrderLineRepository,
): Promise<{
  refundsByOrder: Map<string, RefundRecord[]>;
  linesByOrder: Map<string, OrderLineRecord[]>;
  quoteChecksByOrder: Map<string, QuoteCheckRecord[]>;
  paymentAllocationsByOrder: Map<string, PaymentAllocationRecord[]>;
}> {
  const [refunds, lines, quoteChecks, paymentAllocations] = await Promise.all([
    paymentRepo.listTenantRefunds(organisationId, 500).catch(() => [] as RefundRecord[]),
    orderLineRepo.listByOrganisation(organisationId, 500).catch(() => [] as OrderLineRecord[]),
    paymentRepo.listTenantQuoteChecks(organisationId, 2_000).catch(() => [] as QuoteCheckRecord[]),
    paymentRepo.listTenantPaymentAllocations(organisationId, 2_000).catch(() => [] as PaymentAllocationRecord[]),
  ]);
  const refundsByOrder = new Map<string, RefundRecord[]>();
  for (const refund of refunds) {
    const list = refundsByOrder.get(refund.orderId) ?? [];
    list.push(refund);
    refundsByOrder.set(refund.orderId, list);
  }
  const linesByOrder = new Map<string, OrderLineRecord[]>();
  for (const line of lines) {
    const list = linesByOrder.get(line.orderId) ?? [];
    list.push(line);
    linesByOrder.set(line.orderId, list);
  }
  const quoteChecksByOrder = new Map<string, QuoteCheckRecord[]>();
  for (const quoteCheck of quoteChecks) {
    const list = quoteChecksByOrder.get(quoteCheck.orderId) ?? [];
    list.push(quoteCheck);
    quoteChecksByOrder.set(quoteCheck.orderId, list);
  }
  const paymentAllocationsByOrder = new Map<string, PaymentAllocationRecord[]>();
  for (const allocation of paymentAllocations) {
    const list = paymentAllocationsByOrder.get(allocation.orderId) ?? [];
    list.push(allocation);
    paymentAllocationsByOrder.set(allocation.orderId, list);
  }
  return { refundsByOrder, linesByOrder, quoteChecksByOrder, paymentAllocationsByOrder };
}

export async function loadOrderChildren(
  order: OrderRecord,
  paymentRepo: SqlPaymentRepository,
  orderLineRepo: SqlOrderLineRepository,
): Promise<OrderSqlChildren> {
  const [refunds, lines, quoteChecks, paymentAllocations] = await Promise.all([
    paymentRepo.listRefundsByOrderId(order.id, order.organisationId).catch(() => [] as RefundRecord[]),
    orderLineRepo.listByOrderId(order.id).catch(() => [] as OrderLineRecord[]),
    paymentRepo.listQuoteChecksByOrder(order.id, order.organisationId).catch(() => [] as QuoteCheckRecord[]),
    paymentRepo.listPaymentAllocationsByOrder(order.id, order.organisationId).catch(() => [] as PaymentAllocationRecord[]),
  ]);
  return { refunds, lines, quoteChecks, paymentAllocations };
}
