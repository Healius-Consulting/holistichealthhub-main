import { orderMoneyWasTaken } from '../orders/paid-refund.js';
import {
  applyShipmentSnapshot,
  curaleafEntityRecord,
  curaleafEventKey,
  curaleafEventKinds,
  curaleafRequiresSupplierCancel,
  cursorAfterIso,
  eventPollBackoffSeconds,
  isCuraleafPrescriberRejected,
  isCuraleafTerminalRejection,
  orderMatchesCancelledPrescription,
  orderMatchesCancelledPurchaseOrder,
  orderMatchesRejectedPrescriber,
  shipmentBelongsToOrder,
  stampCuraleafCancellationOnSnapshot,
  stampCuraleafRejectionOnSnapshot,
  supplierCancellationAlreadyConfirmed,
  type CuraleafEventKind,
} from '../integrations/curaleaf-events.js';
import { listPharmacyRecipients, queueEmailToRecipients } from '../notifications/email-outbox.js';
import { curaleafApiRequest } from '../integrations/curaleaf.service.js';
import { persistCuraleafPrescriptionIdentity } from '../prescriptions/curaleaf-prescription-record.js';
import type { CuraleafPurchaseOrderLike, CuraleafShipmentLike } from '../orders/curaleaf-fulfilment.js';
import type { IdentityRepositoryPort } from '../../repositories/ports/identity.port.js';
import type { IntegrationConnectionRecord } from '../../repositories/ports/integration.port.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { OrganisationRepositoryPort } from '../../repositories/ports/organisation.port.js';
import type { OrderRepositoryPort } from '../../repositories/ports/order.port.js';
import type { PrescriptionRepositoryPort } from '../../repositories/ports/prescription.port.js';
import { resolveOrdersForCuraleafEntity } from './poll-curaleaf-match.js';
import { SqlWorkerEventRepository } from '../../repositories/sql/worker-event.sql.js';

export type CuraleafPollDeps = {
  orderRepo: OrderRepositoryPort;
  notificationRepo: NotificationRepositoryPort;
  identityRepo: IdentityRepositoryPort;
  organisationRepo: OrganisationRepositoryPort;
  prescriptionRepo?: PrescriptionRepositoryPort;
  events?: SqlWorkerEventRepository;
};

async function sqlOrderIdsForPurchaseOrder(
  organisationId: string,
  purchaseOrderId: string,
  deps: CuraleafPollDeps,
) {
  if (!deps.prescriptionRepo || !purchaseOrderId) return [];
  return deps.prescriptionRepo.findOrderIdsBySupplierPurchaseOrderId(organisationId, purchaseOrderId);
}

async function sqlOrderIdsForPrescription(
  organisationId: string,
  prescriptionId: string,
  deps: CuraleafPollDeps,
) {
  if (!deps.prescriptionRepo || !prescriptionId) return [];
  return deps.prescriptionRepo.findOrderIdsBySupplierPrescriptionId(organisationId, prescriptionId);
}

async function persistSupplierCancellation(
  order: {
    id: string;
    organisationId: string;
    patientId?: string | null;
    orderNumber?: string | null;
    quoteSnapshot?: unknown;
    paymentStatus?: string | null;
    paidAt?: string | null;
    totalPence?: number | null;
    paymentRoute?: string | null;
  },
  deps: CuraleafPollDeps,
  input: {
    source: 'prescriber' | 'prescription' | 'purchase_order';
    purchaseOrderId?: string | null;
    prescriptionId?: string | null;
    prescriberId?: string | null;
    entityId: string;
    summary: string;
    afterPharmacyCall?: boolean;
  },
) {
  if (supplierCancellationAlreadyConfirmed(order.quoteSnapshot)) return;
  const nextSnapshot = input.afterPharmacyCall
    ? stampCuraleafCancellationOnSnapshot(order.quoteSnapshot, {
      action: 'confirmed',
      purchaseOrderId: input.purchaseOrderId,
      prescriptionId: input.prescriptionId,
      prescriptionState: input.source === 'prescription' ? 'CANCELLED' : null,
      reference: input.source === 'purchase_order' ? 'curaleaf_po_cancelled' : `curaleaf_${input.source}_cancelled`,
      note: 'Curaleaf cancelled the order after pharmacy contact.',
    })
    : stampCuraleafRejectionOnSnapshot(order.quoteSnapshot, {
      source: input.source,
      purchaseOrderId: input.purchaseOrderId,
      prescriptionId: input.prescriptionId,
      prescriberId: input.prescriberId,
      note: input.summary,
    });
  await deps.orderRepo.updateQuoteSnapshot({
    id: order.id,
    organisationId: order.organisationId,
    quoteSnapshot: nextSnapshot,
    fulfilmentStatus: 'EXCEPTION',
  });
  await deps.orderRepo.updateOrderStatus({
    id: order.id,
    organisationId: order.organisationId,
    status: 'CANCELLED',
    paymentStatus: orderMoneyWasTaken(order) ? 'REFUND_REQUIRED' : 'CANCELLED',
    cancelledAt: new Date().toISOString(),
  });
  const recipients = await listPharmacyRecipients(order.organisationId, deps);
  await queueEmailToRecipients(
    deps.notificationRepo,
    recipients,
    'pharmacy_order_cancelled',
    {
      orderNumber: order.orderNumber,
      summary: input.summary,
    },
    ['pharmacy-order-cancelled', order.id, input.entityId, input.source],
    { organisationId: order.organisationId, patientId: order.patientId, orderId: order.id },
  );
}

function pharmacyAlreadyAskedCuraleafToCancel(snapshot: unknown) {
  const cancellation = snapshot && typeof snapshot === 'object'
    ? (snapshot as { curaleafCancellation?: { status?: unknown } }).curaleafCancellation
    : null;
  return ['contact_required', 'awaiting_confirmation'].includes(String(cancellation?.status || ''));
}

async function pollKind(
  connection: IntegrationConnectionRecord,
  kind: CuraleafEventKind,
  deps: CuraleafPollDeps,
) {
  const events = deps.events ?? new SqlWorkerEventRepository();
  const cursorKey = `worker:curaleaf-cursor:${connection.organisationId}:${kind}`;
  const cursor = await events.find(cursorKey);
  const after = cursorAfterIso(cursor?.transactionReference ?? cursor?.payloadHash);
  const page = await curaleafApiRequest<{ events?: Array<Record<string, unknown>> }>(
    connection,
    `${curaleafEventKinds[kind].route}?${new URLSearchParams({ after })}`,
  );
  if (!Array.isArray(page.events)) throw new Error(`Curaleaf returned an invalid ${kind} event page.`);
  let newest = Date.parse(after);
  let processed = 0;
  for (const event of page.events) {
    const entityId = event[curaleafEventKinds[kind].idField];
    const lastUpdated = event.lastUpdated;
    if (typeof entityId !== 'string' || typeof lastUpdated !== 'string' || !Number.isFinite(Date.parse(lastUpdated))) {
      throw new Error(`Curaleaf returned an invalid ${kind} event.`);
    }
    newest = Math.max(newest, Date.parse(lastUpdated));
    const eventKey = curaleafEventKey(connection.organisationId, kind, entityId, lastUpdated);
    if (await events.find(eventKey)) {
      newest = Math.max(newest, Date.parse(lastUpdated));
      continue;
    }
    if (kind !== 'product') {
      const raw = await curaleafApiRequest<unknown>(
        connection,
        `${curaleafEventKinds[kind].detailRoute}${encodeURIComponent(entityId)}/`,
      );
      const record = curaleafEntityRecord(raw, kind);
      if (kind === 'purchaseOrder' && isCuraleafTerminalRejection(record.state)) {
        const purchaseOrder = record as CuraleafPurchaseOrderLike;
        const sqlIds = await sqlOrderIdsForPurchaseOrder(connection.organisationId, String(purchaseOrder.id || ''), deps);
        const orders = await resolveOrdersForCuraleafEntity(
          connection.organisationId,
          sqlIds,
          deps,
          order => orderMatchesCancelledPurchaseOrder(order, purchaseOrder),
        );
        for (const order of orders) {
          const afterPharmacyCall = pharmacyAlreadyAskedCuraleafToCancel(order.quoteSnapshot);
          await persistSupplierCancellation(order, deps, {
            source: 'purchase_order',
            purchaseOrderId: String(record.id || ''),
            entityId: String(record.id || ''),
            summary: afterPharmacyCall
              ? 'Curaleaf cancelled the purchase order. Refund or replace the paid order.'
              : 'Curaleaf rejected the purchase order. Refund or replace the paid order.',
            afterPharmacyCall,
          });
        }
      } else if (kind === 'purchaseOrder') {
        const purchaseOrder = record as CuraleafPurchaseOrderLike;
        const sqlIds = await sqlOrderIdsForPurchaseOrder(connection.organisationId, String(purchaseOrder.id || ''), deps);
        const orders = await resolveOrdersForCuraleafEntity(
          connection.organisationId,
          sqlIds,
          deps,
          order => orderMatchesCancelledPurchaseOrder(order, purchaseOrder),
        );
        const lockedFulfilment = new Set([
          'PARTIALLY_DISPATCHED_TO_PHARMACY',
          'DISPATCHED_TO_PHARMACY',
          'PARTIALLY_RECEIVED',
          'RECEIVED',
          'READY_FOR_COLLECTION',
          'COLLECTED',
        ]);
        for (const order of orders) {
          const snapshot = order.quoteSnapshot && typeof order.quoteSnapshot === 'object'
            ? order.quoteSnapshot as Record<string, unknown>
            : {};
          const prior = snapshot.curaleaf && typeof snapshot.curaleaf === 'object'
            ? snapshot.curaleaf as Record<string, unknown>
            : {};
          const poState = String(purchaseOrder.state || purchaseOrder.purchaseOrderState || 'CREATED').toUpperCase();
          const fulfilmentStatus = lockedFulfilment.has(String(order.fulfilmentStatus || ''))
            ? undefined
            : poState === 'FULLY_ALLOCATED'
              ? 'SUPPLIER_ALLOCATED'
              : 'SUPPLIER_PROCESSING';
          await persistCuraleafPrescriptionIdentity({
            organisationId: order.organisationId,
            orderId: order.id,
            patientId: order.patientId,
            snapshot: order.quoteSnapshot,
            prescriptionId: typeof prior.prescriptionId === 'string' ? prior.prescriptionId : null,
            prescriberId: typeof prior.prescriberId === 'string' ? prior.prescriberId : null,
            purchaseOrder: record,
            customerReferenceFallback: order.orderNumber,
            fulfilmentStatus,
          });
        }
      }
      if (kind === 'prescription' && isCuraleafTerminalRejection(record.state)) {
        const sqlIds = await sqlOrderIdsForPrescription(connection.organisationId, String(record.id || ''), deps);
        const orders = await resolveOrdersForCuraleafEntity(
          connection.organisationId,
          sqlIds,
          deps,
          order => orderMatchesCancelledPrescription(order, record),
        );
        for (const order of orders) {
          const afterPharmacyCall = pharmacyAlreadyAskedCuraleafToCancel(order.quoteSnapshot);
          await persistSupplierCancellation(order, deps, {
            source: 'prescription',
            prescriptionId: String(record.id || ''),
            entityId: String(record.id || ''),
            summary: afterPharmacyCall
              ? 'Curaleaf cancelled the prescription after pharmacy contact. Refund or replace the paid order.'
              : 'Curaleaf rejected the prescription. Refund or replace the paid order.',
            afterPharmacyCall,
          });
        }
      }
      if (kind === 'prescriber' && isCuraleafPrescriberRejected(record.state)) {
        const orders = await deps.orderRepo.listTenantOrders(connection.organisationId, 500);
        for (const order of orders) {
          if (!orderMatchesRejectedPrescriber(order, record)) continue;
          if (curaleafRequiresSupplierCancel(order.quoteSnapshot)) continue;
          await persistSupplierCancellation(order, deps, {
            source: 'prescriber',
            prescriberId: String(record.id || ''),
            entityId: String(record.id || ''),
            summary: 'Curaleaf rejected the prescriber. Refund or replace the paid order.',
          });
        }
      }
      if (kind === 'shipment') {
        const shipment = record as CuraleafShipmentLike;
        const sqlIds = await sqlOrderIdsForPurchaseOrder(
          connection.organisationId,
          String(shipment.purchaseOrderId || ''),
          deps,
        );
        const orders = await resolveOrdersForCuraleafEntity(
          connection.organisationId,
          sqlIds,
          deps,
          order => shipmentBelongsToOrder(order, shipment),
        );
        for (const order of orders) {
          const next = applyShipmentSnapshot(order, shipment);
          await deps.orderRepo.updateQuoteSnapshot({
            id: order.id,
            organisationId: order.organisationId,
            quoteSnapshot: next.snapshot,
            fulfilmentStatus: next.fulfilmentStatus,
          });
          if (
            next.fulfilmentStatus !== order.fulfilmentStatus &&
            ['PARTIALLY_DISPATCHED_TO_PHARMACY', 'DISPATCHED_TO_PHARMACY'].includes(next.fulfilmentStatus)
          ) {
            const recipients = await listPharmacyRecipients(order.organisationId, deps);
            await queueEmailToRecipients(
              deps.notificationRepo,
              recipients,
              'pharmacy_order_dispatched',
              {
                orderNumber: order.orderNumber,
                summary: next.fulfilmentStatus === 'PARTIALLY_DISPATCHED_TO_PHARMACY'
                  ? 'A partial order has been dispatched.'
                  : 'An order has been dispatched.',
              },
              ['pharmacy-order-dispatched', order.id, shipment.id, next.fulfilmentStatus],
              { organisationId: order.organisationId, patientId: order.patientId, orderId: order.id },
            );
          }
        }
      }
    }
    await events.remember({
      eventKey,
      integration: 'CURALEAF',
      organisationId: connection.organisationId,
      payloadHash: lastUpdated,
      status: 'SUCCEEDED',
    });
    processed += 1;
  }
  await events.upsertCursor({
    eventKey: cursorKey,
    integration: 'CURALEAF',
    organisationId: connection.organisationId,
    cursorAt: new Date(Number.isFinite(newest) ? newest : Date.now()).toISOString(),
  });
  return { kind, events: page.events.length, processed };
}

export async function pollCuraleafEvents(
  connection: IntegrationConnectionRecord,
  deps: CuraleafPollDeps,
) {
  const results = [];
  for (const kind of Object.keys(curaleafEventKinds) as CuraleafEventKind[]) {
    results.push(await pollKind(connection, kind, deps));
  }
  return { organisationId: connection.organisationId, results, completedAt: new Date().toISOString() };
}

export { eventPollBackoffSeconds };
