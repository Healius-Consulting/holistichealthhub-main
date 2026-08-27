import type { CuraleafShipmentLike } from '../orders/curaleaf-fulfilment.js';
import type { OrderRecord } from '../../repositories/ports/order.port.js';

/**
 * Curaleaf creates a shipment when it dispenses, so that is the moment the SQL shipment
 * row should exist and the moment `dispatchedAt` is actually known. Nothing wrote it
 * there before: the goods-in route upserted the row lazily when the packs arrived, which
 * left `dispatchedAt` null and made in-transit consignments invisible to any SQL
 * shipment query in between.
 *
 * Pure so the identifier and reference resolution can be tested without a database.
 * Returns null when the order carries no purchase order to hang the shipment on — a
 * fabricated reference would be worse than no row.
 */
export function supplierShipmentRowInput(
  order: Pick<OrderRecord, 'id' | 'organisationId' | 'orderNumber' | 'quoteSnapshot'>,
  shipment: CuraleafShipmentLike,
): {
  organisationId: string;
  orderId: string;
  supplierPurchaseOrderId: string;
  supplierShipmentId: string;
  supplierCustomerReference: string | null;
  dispatchedAt: string | null;
} | null {
  const supplierShipmentId = String(shipment.id || '');
  if (!supplierShipmentId) return null;

  const snapshot = order.quoteSnapshot && typeof order.quoteSnapshot === 'object'
    ? order.quoteSnapshot as Record<string, unknown>
    : {};
  const curaleaf = snapshot.curaleaf && typeof snapshot.curaleaf === 'object'
    ? snapshot.curaleaf as Record<string, unknown>
    : {};

  // The event's own purchase order wins; the snapshot is the fallback for a shipment
  // that arrived without one.
  const supplierPurchaseOrderId = String(shipment.purchaseOrderId || curaleaf.purchaseOrderId || curaleaf.id || '');
  if (!supplierPurchaseOrderId) return null;

  const supplierCustomerReference = shipment.purchaseOrderCustomerReference
    ?? shipment.customerReference
    ?? (typeof curaleaf.customerReference === 'string' ? curaleaf.customerReference : null)
    ?? order.orderNumber
    ?? null;

  return {
    organisationId: order.organisationId,
    orderId: order.id,
    supplierPurchaseOrderId,
    supplierShipmentId,
    supplierCustomerReference,
    dispatchedAt: shipment.createdAt ?? null,
  };
}
