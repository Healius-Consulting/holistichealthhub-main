import { createHash } from 'node:crypto';
import {
  applyPrescriptionMaintenance,
  evaluatePrescriptionMaintenance,
  prescriptionFlowMap,
  snapshotObject,
} from '../orders/order-maintenance.js';
import { dispatchEmailEvent } from '../notifications/email-dispatch.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { IdentityRepositoryPort } from '../../repositories/ports/identity.port.js';
import type { OrganisationRepositoryPort } from '../../repositories/ports/organisation.port.js';
import type { OrderRecord, OrderRepositoryPort } from '../../repositories/ports/order.port.js';
import { uuidFromHex } from '../../domain/common/uuid.js';
import { insertStaffTask } from '../../repositories/sql/staff-task.sql.js';

export type OrderMaintenanceDeps = {
  orderRepo: OrderRepositoryPort;
  identityRepo: IdentityRepositoryPort;
  organisationRepo: OrganisationRepositoryPort;
  notificationRepo: NotificationRepositoryPort;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function queueDelayMessage(
  deps: OrderMaintenanceDeps,
  order: OrderRecord,
  prescriptionId: string,
  episodeId: string,
) {
  await dispatchEmailEvent('order.delivery_issue', {
    notificationRepo: deps.notificationRepo,
    identityRepo: deps.identityRepo,
    organisationRepo: deps.organisationRepo,
    organisationId: order.organisationId,
    patientId: order.patientId,
    orderId: order.id,
    payload: {
      orderNumber: order.orderNumber,
      summary: 'Part of the order is delayed and needs pharmacy awareness.',
      prescriptionId,
    },
    keyParts: ['pharmacy-delivery-issue', order.id, prescriptionId, episodeId],
  });
}

export async function maintainPaidOrderFlow(deps: OrderMaintenanceDeps, now = new Date()) {
  const orders = await deps.orderRepo.listPaidOpenOrders(1_000);
  const summary = { checked: orders.length, delayed: 0, renewalHeld: 0, renewalEscalated: 0, errors: 0 };
  for (const order of orders) {
    try {
      const snapshot = snapshotObject(order.quoteSnapshot);
      const flow = prescriptionFlowMap(snapshot);
      if (!Object.keys(flow).length) continue;
      const nextFlow = { ...flow };
      let changed = false;
      for (const [prescriptionId, prescription] of Object.entries(flow)) {
        const action = evaluatePrescriptionMaintenance({
          state: String(prescription.state ?? ''),
          lines: prescription.lines,
          delayEpisode: prescription.delayEpisode,
          renewal: prescription.renewal,
          expiryDate: typeof prescription.expiryDate === 'string' ? prescription.expiryDate : null,
          placedAt: typeof prescription.placedAt === 'string' ? prescription.placedAt : null,
          orderUpdatedAt: order.updatedAt,
          now,
        });
        if (action.type === 'none') continue;
        const episodeId = createHash('sha256').update(`${order.id}:${prescriptionId}:${now.toISOString()}`).digest('hex').slice(0, 24);
        const taskId = uuidFromHex(createHash('sha256').update(`${order.organisationId}:${order.id}:${prescriptionId}:${action.type}`).digest('hex'));
        nextFlow[prescriptionId] = applyPrescriptionMaintenance(prescription, action, now, { episodeId, taskId });
        changed = true;
        if (action.type === 'notify_delay') {
          summary.delayed += 1;
          await queueDelayMessage(deps, order, prescriptionId, episodeId);
        }
        if (action.type === 'renewal_boundary') {
          summary.renewalHeld += 1;
          await insertStaffTask({
            id: taskId,
            organisationId: order.organisationId,
            taskType: 'renewal_boundary',
            priority: 0,
            title: 'Renewal boundary reached',
            details: { orderId: order.id, prescriptionId },
            dueAt: new Date(`${String(prescription.expiryDate ?? '')}T23:59:59.999Z`).toISOString(),
          });
          await dispatchEmailEvent('order.near_expiry', {
            notificationRepo: deps.notificationRepo,
            identityRepo: deps.identityRepo,
            organisationRepo: deps.organisationRepo,
            organisationId: order.organisationId,
            patientId: order.patientId,
            orderId: order.id,
            payload: {
              orderNumber: order.orderNumber,
              summary: `Prescription ${prescriptionId} is close to expiry.`,
              prescriptionId,
            },
            keyParts: ['pharmacy-prescription-close-to-expiry', order.id, prescriptionId, taskId],
          });
        }
        if (action.type === 'renewal_expired') {
          summary.renewalEscalated += 1;
          await insertStaffTask({
            id: taskId,
            organisationId: order.organisationId,
            taskType: 'renewal_expired',
            priority: 1,
            title: 'Prescription expired with unfulfilled lines',
            details: { orderId: order.id, prescriptionId },
            dueAt: now.toISOString(),
          });
        }
      }
      if (changed) {
        await deps.orderRepo.updateQuoteSnapshot({
          id: order.id,
          organisationId: order.organisationId,
          quoteSnapshot: { ...snapshot, prescriptionFlow: nextFlow },
        });
      }
    } catch (error) {
      summary.errors += 1;
      const snapshot = asRecord(order.quoteSnapshot);
      await deps.orderRepo.updateQuoteSnapshot({
        id: order.id,
        organisationId: order.organisationId,
        quoteSnapshot: {
          ...snapshot,
          maintenanceError: error instanceof Error ? error.message : 'Unknown maintenance error',
        },
      }).catch(() => undefined);
    }
  }
  return summary;
}
