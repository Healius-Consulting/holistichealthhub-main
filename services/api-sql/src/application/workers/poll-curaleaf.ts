import {
  applyCancelledPurchaseOrderSnapshot,
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
  stampCuraleafAttentionOnSnapshot,
  supplierCancellationAlreadyConfirmed,
  type CuraleafEventKind,
} from '../integrations/curaleaf-events.js';
import { advanceFulfilmentStatus } from '../orders/curaleaf-fulfilment.js';
import { listPharmacyRecipients, queueEmailToRecipients } from '../notifications/email-outbox.js';
import { curaleafApiRequest } from '../integrations/curaleaf.service.js';
import { persistCuraleafPrescriptionIdentity } from '../prescriptions/curaleaf-prescription-record.js';
import { recordVerifiedPrescriberInDirectory } from '../prescriptions/verified-prescriber-directory.js';
import type { CuraleafPurchaseOrderLike, CuraleafShipmentLike } from '../orders/curaleaf-fulfilment.js';
import { supplierShipmentRowInput } from './poll-curaleaf-shipment-row.js';
import type { FulfilmentRepositoryPort } from '../../repositories/ports/fulfilment.port.js';
import type { IdentityRepositoryPort } from '../../repositories/ports/identity.port.js';
import type { IntegrationConnectionRecord } from '../../repositories/ports/integration.port.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { OrganisationRepositoryPort } from '../../repositories/ports/organisation.port.js';
import type { OrderRepositoryPort } from '../../repositories/ports/order.port.js';
import type { PrescriptionRepositoryPort } from '../../repositories/ports/prescription.port.js';
import { resolveOrdersForCuraleafEntity } from './poll-curaleaf-match.js';
import { SqlWorkerEventRepository } from '../../repositories/sql/worker-event.sql.js';
import { SqlPrescriptionSerialRepository } from '../../repositories/sql/serial-use.sql.js';

export type CuraleafPollDeps = {
  orderRepo: OrderRepositoryPort;
  /** Optional so existing callers and tests keep working without a fulfilment store. */
  fulfilmentRepo?: FulfilmentRepositoryPort;
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
    purchaseOrder?: CuraleafPurchaseOrderLike | null;
  },
) {
  if (supplierCancellationAlreadyConfirmed(order.quoteSnapshot)) return;
  const cancellationStamped = stampCuraleafCancellationOnSnapshot(order.quoteSnapshot, {
      action: 'confirmed',
      purchaseOrderId: input.purchaseOrderId,
      prescriptionId: input.prescriptionId,
      prescriptionState: input.source === 'prescription' ? 'CANCELLED' : null,
      reference: input.source === 'purchase_order' ? 'curaleaf_po_cancelled' : `curaleaf_${input.source}_cancelled`,
      note: input.afterPharmacyCall
        ? 'Curaleaf cancelled the order after pharmacy contact.'
        : 'Curaleaf reported the supplier record as cancelled.',
    });
  const baseSnapshot = input.source === 'purchase_order' && input.purchaseOrder
    ? applyCancelledPurchaseOrderSnapshot(cancellationStamped, input.purchaseOrder)
    : stampCuraleafAttentionOnSnapshot(cancellationStamped, {
      source: input.source,
      code: input.source === 'prescriber' ? 'PRESCRIBER_ARCHIVED' : 'PRESCRIPTION_CANCELLED',
      reason: input.summary,
      prescriberId: input.prescriberId,
      prescriptionId: input.prescriptionId,
      prescriberState: input.source === 'prescriber' ? 'ARCHIVED' : null,
      prescriptionState: input.source === 'prescription' ? 'CANCELLED' : null,
      terminal: true,
    });
  const typedSnapshot = baseSnapshot as Record<string, unknown>;
  const nextSnapshot = {
    ...typedSnapshot,
    cancellation: {
      ...(typedSnapshot.cancellation && typeof typedSnapshot.cancellation === 'object'
        ? typedSnapshot.cancellation as Record<string, unknown>
        : {}),
      status: 'resolution_required',
    },
  };
  await deps.orderRepo.updateQuoteSnapshot({
    id: order.id,
    organisationId: order.organisationId,
    quoteSnapshot: nextSnapshot,
    fulfilmentStatus: 'EXCEPTION',
  });
  await new SqlPrescriptionSerialRepository().endLiveForOrder(order.organisationId, order.id, 'curaleaf_cancelled').catch(() => undefined);
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
            summary: 'Curaleaf cancelled the purchase order. Resolve the unfulfilled packs by replacement or refund.',
            afterPharmacyCall,
            purchaseOrder,
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
            summary: 'Curaleaf cancelled the prescription. Review replacement or refund options.',
            afterPharmacyCall,
          });
        }
      } else if (kind === 'prescription') {
        const prescriptionState = String(record.state || '').toUpperCase();
        if (['PENDING', 'ACTIVE', 'FULFILLED', 'EXPIRED'].includes(prescriptionState)) {
          const sqlIds = await sqlOrderIdsForPrescription(connection.organisationId, String(record.id || ''), deps);
          const orders = await resolveOrdersForCuraleafEntity(
            connection.organisationId,
            sqlIds,
            deps,
            order => orderMatchesCancelledPrescription(order, record),
          );
          for (const order of orders) {
            const snapshot = order.quoteSnapshot && typeof order.quoteSnapshot === 'object'
              ? order.quoteSnapshot as Record<string, unknown>
              : {};
            const prior = snapshot.curaleaf && typeof snapshot.curaleaf === 'object'
              ? snapshot.curaleaf as Record<string, unknown>
              : {};
            await persistCuraleafPrescriptionIdentity({
              organisationId: order.organisationId,
              orderId: order.id,
              patientId: order.patientId,
              snapshot,
              prescriptionId: String(record.id || ''),
              prescriberId: typeof prior.prescriberId === 'string' ? prior.prescriberId : null,
              prescriptionState,
              purchaseOrder: null,
              fulfilmentStatus: prescriptionState === 'EXPIRED' || prescriptionState === 'FULFILLED' ? 'EXCEPTION' : 'SUPPLIER_PENDING',
            });
            if (prescriptionState === 'ACTIVE') {
              const { executeCuraleafOrderPlacement } = await import('../integrations/curaleaf.service.js');
              await executeCuraleafOrderPlacement(connection, order).catch(error => {
                console.warn('[Curaleaf poll] Active prescription placement retry failed.', {
                  code: error instanceof Error ? error.name : 'UNKNOWN',
                });
              });
            }
          }
        }
      }
      if (kind === 'prescriber') {
        const prescriberState = String(record.state || '').toUpperCase();
        if (!['UNVERIFIED', 'VERIFIED', 'ARCHIVED'].includes(prescriberState)) continue;
        if (prescriberState === 'VERIFIED' && deps.prescriptionRepo) {
          await recordVerifiedPrescriberInDirectory(deps.prescriptionRepo, {
            name: typeof record.name === 'string' ? record.name : null,
            initials: typeof record.initials === 'string' ? record.initials : null,
            pin: typeof record.pin === 'string' ? record.pin : null,
            gmcNumber: typeof record.gmcNumber === 'number' || typeof record.gmcNumber === 'string' ? record.gmcNumber : null,
            gphcNumber: typeof record.gphcNumber === 'string' ? record.gphcNumber : null,
          });
        }
        const orders = await deps.orderRepo.listTenantOrders(connection.organisationId, 500);
        for (const order of orders) {
          if (!orderMatchesRejectedPrescriber(order, record)) continue;
          if (isCuraleafPrescriberRejected(prescriberState)) {
            await persistSupplierCancellation(order, deps, {
              source: 'prescriber',
              prescriberId: String(record.id || ''),
              entityId: String(record.id || ''),
              summary: 'Curaleaf archived the prescriber. Correct or replace the prescriber before continuing.',
            });
            continue;
          }
          const snapshot = order.quoteSnapshot && typeof order.quoteSnapshot === 'object'
            ? order.quoteSnapshot as Record<string, unknown>
            : {};
          const prior = snapshot.curaleaf && typeof snapshot.curaleaf === 'object'
            ? snapshot.curaleaf as Record<string, unknown>
            : {};
          await persistCuraleafPrescriptionIdentity({
            organisationId: order.organisationId,
            orderId: order.id,
            patientId: order.patientId,
            snapshot,
            prescriptionId: typeof prior.prescriptionId === 'string' ? prior.prescriptionId : null,
            prescriberId: String(record.id || ''),
            prescriberState: prescriberState as 'UNVERIFIED' | 'VERIFIED',
            purchaseOrder: null,
            fulfilmentStatus: 'SUPPLIER_PENDING',
          });
          if (prescriberState === 'VERIFIED') {
            const { executeCuraleafOrderPlacement } = await import('../integrations/curaleaf.service.js');
            await executeCuraleafOrderPlacement(connection, order).catch(error => {
              console.warn('[Curaleaf poll] Verified prescriber placement retry failed.', {
                code: error instanceof Error ? error.name : 'UNKNOWN',
              });
            });
          }
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
          /*
           * Curaleaf creates the shipment when it dispenses, so that is when the row
           * should exist — with Curaleaf's own dispatch time on it. Until now nothing
           * created it here: the goods-in route upserted it lazily days later, which
           * left `dispatchedAt` null and made in-transit consignments invisible to any
           * SQL shipment query between dispatch and check-in. The lazy upsert stays as
           * a backstop for orders dispatched before this ran.
           */
          if (deps.fulfilmentRepo) {
            const shipmentRow = supplierShipmentRowInput(order, shipment);
            if (shipmentRow) {
              await deps.fulfilmentRepo.upsertSupplierShipment(shipmentRow).catch(error => {
                // Never let a shipment row failure lose the snapshot update below; the
                // goods-in route can still create the row when the packs arrive.
                console.error('[Curaleaf poll] Supplier shipment row could not be recorded.', {
                  orderId: order.id,
                  supplierShipmentId: shipmentRow.supplierShipmentId,
                  code: error instanceof Error ? error.name : 'UNKNOWN',
                });
              });
            }
          }
          const next = applyShipmentSnapshot(order, shipment);
          /*
           * Ratchet the supplier's view against what the dispensary already recorded.
           * `supplierFulfilmentStatus` has no READY_FOR_COLLECTION in its vocabulary —
           * only the pharmacy can reach that state — so persisting its answer raw let a
           * late shipment event knock a checked-in order back to RECEIVED, dropping it
           * out of the collection queue after the patient had already been emailed.
           * EXCEPTION still outranks goods-in, so supplier problems are never masked.
           */
          const fulfilmentStatus = advanceFulfilmentStatus(order.fulfilmentStatus, next.fulfilmentStatus);
          await deps.orderRepo.updateQuoteSnapshot({
            id: order.id,
            organisationId: order.organisationId,
            quoteSnapshot: next.snapshot,
            fulfilmentStatus,
          });
          if (
            fulfilmentStatus !== order.fulfilmentStatus &&
            ['PARTIALLY_DISPATCHED_TO_PHARMACY', 'DISPATCHED_TO_PHARMACY'].includes(fulfilmentStatus)
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
