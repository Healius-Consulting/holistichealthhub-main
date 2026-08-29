import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import {
  advanceFulfilmentStatus,
  applyPharmacyGoodsReceipt,
  normalisedFulfilmentLines,
  supplierFulfilmentStatus,
} from '../../application/orders/curaleaf-fulfilment.js';
import { HttpError } from '../../domain/common/errors.js';
import { SqlFulfilmentRepository } from '../../repositories/sql/fulfilment.sql.js';
import { SqlNotificationRepository } from '../../repositories/sql/notification.sql.js';
import { SqlOrderRepository } from '../../repositories/sql/order.sql.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { SqlPatientRepository } from '../../repositories/sql/patient.sql.js';
import { queueCollectionReadyEmail } from '../../application/notifications/collection-ready-email.js';
import { curaleafSubOrders, snapshotRxKey, snapshotRxList } from '../../application/prescriptions/snapshot-rx.js';
import { requireCsrf } from '../../security/csrf.js';
import { assertTenantScope } from '../../security/request-context.js';
import { requireStaff } from '../../security/require-staff.js';
import { requirePharmacyOperationalWrites } from './require-operational-writes.js';

const entityIdSchema = z.string().regex(/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i);

const goodsReceiptSchema = z.object({
  orderId: entityIdSchema.optional(),
  receiptNumber: z.string().min(1).max(100).optional(),
  status: z.enum(['COMPLETE', 'DAMAGED', 'DISCREPANCY', 'PARTIAL']).optional(),
  notes: z.string().max(4000).optional(),
  items: z.array(z.object({
    productId: z.string(),
    expectedQuantity: z.number().int().nonnegative().optional(),
    receivedQuantity: z.number().int().nonnegative(),
  })).optional(),
  lines: z.array(z.object({
    productId: z.string(),
    expectedQuantity: z.number().int().nonnegative().optional(),
    receivedQuantity: z.number().int().nonnegative(),
  })).optional(),
});

function snapshotObject(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value as Record<string, any> } : {};
}

export function curaleafScopeForShipment(snapshot: Record<string, any>, shipmentId: string) {
  for (const [rxKey, value] of Object.entries(curaleafSubOrders(snapshot))) {
    const curaleaf = snapshotObject(value);
    const shipmentIds = [
      ...(Array.isArray(curaleaf.shipmentIds) ? curaleaf.shipmentIds : []),
      ...(Array.isArray(curaleaf.shipments) ? curaleaf.shipments.map((shipment: any) => shipment?.id) : []),
    ].map(String);
    if (shipmentIds.includes(shipmentId)) return { rxKey, curaleaf };
  }
  return { rxKey: null as string | null, curaleaf: snapshotObject(snapshot.curaleaf) };
}

function requestedItemsForScope(snapshot: Record<string, any>, rxKey: string | null) {
  if (!rxKey) return snapshot.lineItems || snapshot.items || [];
  const prescriptions = snapshotRxList(snapshot);
  const prescription = prescriptions.find((rx, index) => snapshotRxKey(rx, index) === rxKey);
  return prescription?.items || [];
}

function withCuraleafScope(snapshot: Record<string, any>, rxKey: string | null, curaleaf: Record<string, any>) {
  if (!rxKey) return { ...snapshot, curaleaf };
  return {
    ...snapshot,
    curaleafSubOrders: {
      ...curaleafSubOrders(snapshot),
      [rxKey]: curaleaf,
    },
  };
}


/**
 * Goods-in is the regulated record that stock entered this dispensary, and it names the
 * member of staff who verified it. Both callers below write it before any pack count
 * moves and let a failure here abort the request: booking stock in while silently
 * dropping the receipt would leave verified packs on the shelf with nothing recording
 * who received them. The route used to fall back to a synthetic `gr-<timestamp>` id and
 * still answer 201, so the loss was invisible to the pharmacy.
 */
export function assertGoodsReceiptRecorded(input: {
  shipmentId: string | null | undefined;
  receiptId: string | null | undefined;
}): string {
  if (!input.shipmentId) {
    throw new HttpError(
      409,
      'This consignment is not linked to the order yet, so the goods-in record cannot be saved. Refresh the order and try again.',
      'SHIPMENT_NOT_LINKED',
    );
  }
  if (!input.receiptId) {
    throw new HttpError(
      503,
      'The goods-in record could not be saved, so no stock was booked in. Try again in a moment.',
      'GOODS_RECEIPT_NOT_RECORDED',
    );
  }
  return input.receiptId;
}

/** A receipt short of what the consignment promised is recorded as PARTIAL, not COMPLETE. */
export function goodsReceiptStatus(
  items: Array<{ expectedQuantity?: number; receivedQuantity: number }>,
): 'COMPLETE' | 'PARTIAL' {
  return items.some(item => (item.expectedQuantity ?? item.receivedQuantity) > item.receivedQuantity)
    ? 'PARTIAL'
    : 'COMPLETE';
}

export function createPortalFulfilmentRouter(): Router {
  const router = Router();
  const fulfilmentRepo = new SqlFulfilmentRepository();
  const orderRepo = new SqlOrderRepository();
  const notificationRepo = new SqlNotificationRepository();
  const patientRepo = new SqlPatientRepository();
  const organisationRepo = new SqlOrganisationRepository();

  router.get('/portal/shipments', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const shipments = await fulfilmentRepo.listShipments(scope.organisationId);
      res.status(200).json(shipments);
    } catch (error) {
      next(error);
    }
  });

  router.get('/portal/goods-receipts', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const receipts = await fulfilmentRepo.listGoodsReceipts(scope.organisationId);
      res.status(200).json(receipts);
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/shipments/:shipmentId/goods-receipts', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const supplierShipmentId = String(req.params.shipmentId || '');
      const input = goodsReceiptSchema.parse(req.body || {});
      const itemsPayload = input.items || input.lines || [];
      let targetOrderId = input.orderId && input.orderId !== scope.organisationId ? input.orderId : undefined;

      let sqlShipment = await fulfilmentRepo.findShipmentBySupplierId(scope.organisationId, supplierShipmentId).catch(() => null);
      if (!targetOrderId && sqlShipment?.orderId) targetOrderId = sqlShipment.orderId;
      if (!sqlShipment && targetOrderId) {
        const order = await orderRepo.findOrderById(targetOrderId, scope.organisationId);
        const snapshot = snapshotObject(order?.quoteSnapshot);
        const shipmentScope = curaleafScopeForShipment(snapshot, supplierShipmentId);
        const poId = shipmentScope.curaleaf.purchaseOrderId || shipmentScope.curaleaf.id;
        if (order && poId) {
          sqlShipment = await fulfilmentRepo.upsertSupplierShipment({
            organisationId: scope.organisationId,
            orderId: order.id,
            supplierPurchaseOrderId: String(poId),
            supplierShipmentId,
            supplierCustomerReference: shipmentScope.curaleaf.customerReference || order.orderNumber,
          }).then(async result => (
            result.id
              ? { id: result.id, orderId: order.id, supplierPurchaseOrderId: String(poId), supplierShipmentId, supplierCustomerReference: order.orderNumber, status: 'DISPATCHED', dispatchedAt: null, createdAt: new Date().toISOString() }
              : null
          )).catch(error => {
            console.error('[Goods-in] Supplier shipment row could not be created.', {
              orderId: order.id,
              supplierShipmentId,
              code: error instanceof Error ? error.name : 'UNKNOWN',
            });
            return null;
          });
        }
      }
      if (!targetOrderId) {
        throw new HttpError(404, 'Shipment not found for this pharmacy tenant.', 'NOT_FOUND');
      }

      const notesContent = input.notes
        ? String(input.notes)
        : itemsPayload.length > 0
          ? `Shipment ${supplierShipmentId} items check-in: ${JSON.stringify(itemsPayload)}`
          : `Shipment ${supplierShipmentId} goods receipt verified`;

      const receipt = sqlShipment?.id
        ? await fulfilmentRepo.createGoodsReceipt({
          organisationId: scope.organisationId,
          shipmentId: sqlShipment.id,
          receivedByUid: scope.uid,
          status: goodsReceiptStatus(itemsPayload),
          notes: notesContent,
        }).catch(error => {
          console.error('[Goods-in] Receipt could not be persisted; no stock was booked in.', {
            orderId: targetOrderId,
            supplierShipmentId,
            code: error instanceof Error ? error.name : 'UNKNOWN',
          });
          return null;
        })
        : null;
      // Throws before a single pack count moves. See `assertGoodsReceiptRecorded`.
      const recordId = assertGoodsReceiptRecorded({ shipmentId: sqlShipment?.id, receiptId: receipt?.id });

      const order = await orderRepo.findOrderById(targetOrderId, scope.organisationId);
      if (!order) throw new HttpError(404, 'Order not found.', 'NOT_FOUND');
      const snapshot = snapshotObject(order.quoteSnapshot);
      const shipmentScope = curaleafScopeForShipment(snapshot, supplierShipmentId);
      const curaleaf = shipmentScope.curaleaf;
      const requestedItems = requestedItemsForScope(snapshot, shipmentScope.rxKey);
      const priorLines = normalisedFulfilmentLines({
        purchaseOrder: curaleaf,
        shipments: curaleaf.shipments || [],
        requestedItems,
        priorLines: curaleaf.lines,
      });
      const receiptItems = itemsPayload.map(item => ({
        productId: item.productId,
        receivedQuantity: item.receivedQuantity,
      }));
      const { lines, shipmentStates } = applyPharmacyGoodsReceipt({
        lines: priorLines,
        items: receiptItems,
        shipmentId: supplierShipmentId,
        shipmentStates: curaleaf.shipmentStates || {},
      });
      const anyReceived = lines.some(line => line.received > 0);
      const nextStatus = advanceFulfilmentStatus(
        order.fulfilmentStatus,
        supplierFulfilmentStatus({ purchaseOrder: curaleaf, shipments: curaleaf.shipments || [], lines }),
      );
      /*
       * Goods-in IS the ready-to-collect decision. Pharmacy staff used to check a
       * consignment in and then press a second "mark ready to collect" button, which
       * meant a checked-in order could sit on the shelf with the patient never told.
       * Recording arrival now advances the order and queues the patient's email
       * itself; `queueCollectionReadyEmail` applies the 15:00 London cut-off, and its
       * idempotency key is shared with the shipment-status route so a consignment can
       * only ever notify once.
       */
      await orderRepo.updateQuoteSnapshot({
        id: order.id,
        organisationId: scope.organisationId,
        // Stamped by the dispensary, not the supplier: the collection-email window and
        // the "verified on" line both need the moment the packs were actually booked in.
        quoteSnapshot: withCuraleafScope(snapshot, shipmentScope.rxKey, { ...curaleaf, lines, shipmentStates, ...(anyReceived ? { goodsInAt: new Date().toISOString() } : {}) }),
        fulfilmentStatus: anyReceived
          ? advanceFulfilmentStatus(order.fulfilmentStatus, 'READY_FOR_COLLECTION')
          : nextStatus,
      }).catch(err => console.warn('Order status sync on shipment check-in warning:', err));

      if (anyReceived && receiptItems.some(item => item.receivedQuantity > 0)) {
        const readyPacks = receiptItems.reduce((sum, item) => sum + Math.max(0, item.receivedQuantity), 0);
        const totalPacks = lines.reduce((sum, line) => sum + Math.max(0, Number(line.ordered || 0)), 0);
        await queueCollectionReadyEmail(
          { notificationRepo, patientRepo, organisationRepo },
          {
            organisationId: scope.organisationId,
            orderId: order.id,
            patientId: order.patientId,
            orderNumber: (order as { orderNumber?: string | number | null }).orderNumber ?? null,
            scopeKey: `shipment:${supplierShipmentId}`,
            readyPacks,
            totalPacks,
          },
        ).catch(err => console.warn('Ready-for-collection email warning:', err));
      }

      res.status(201).json({
        id: recordId,
        shipmentId: supplierShipmentId,
        receiptNumber: input.receiptNumber || `REC-${Date.now().toString(36).toUpperCase()}`,
        organisationId: scope.organisationId,
        status: 'goods_receipt_recorded',
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/portal/shipments/:shipmentId/status', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const supplierShipmentId = String(req.params.shipmentId || '');
      const { status, orderId } = req.body || {};

      if (orderId && typeof orderId === 'string') {
        const order = await orderRepo.findOrderById(orderId, scope.organisationId);
        if (order) {
          const snapshot = snapshotObject(order.quoteSnapshot);
          const curaleaf = snapshotObject(snapshot.curaleaf);
          const shipmentStates = { ...(curaleaf.shipmentStates || {}), [supplierShipmentId]: status || 'updated' };
          const lines = Array.isArray(curaleaf.lines) ? curaleaf.lines : [];
          const remainingOpen = lines.some((line: any) => Number(line.remaining || 0) > 0 || Number(line.received || 0) < Number(line.ordered || 0));
          const nextFulfilmentStatus = status === 'collected'
            ? (remainingOpen ? 'PARTIALLY_RECEIVED' : 'COLLECTED')
            : status === 'ready_for_collection'
              ? 'READY_FOR_COLLECTION'
              : undefined;
          await orderRepo.updateQuoteSnapshot({
            id: order.id,
            organisationId: scope.organisationId,
            quoteSnapshot: { ...snapshot, curaleaf: { ...curaleaf, shipmentStates } },
            fulfilmentStatus: nextFulfilmentStatus,
          }).catch(err => console.warn('Shipment status order sync warning:', err));

          // A consignment marked ready must notify the patient too. This route
          // used to record the state and queue nothing.
          if (status === 'ready_for_collection') {
            await queueCollectionReadyEmail(
              { notificationRepo, patientRepo, organisationRepo },
              {
                organisationId: scope.organisationId,
                orderId: order.id,
                patientId: order.patientId,
                orderNumber: (order as { orderNumber?: string | number | null }).orderNumber ?? null,
                scopeKey: `shipment:${supplierShipmentId}`,
              },
            ).catch(err => console.warn('Ready-for-collection email warning:', err));
          }
        }
      }

      res.status(200).json({
        shipmentId: supplierShipmentId,
        organisationId: scope.organisationId,
        status: status || 'updated',
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
