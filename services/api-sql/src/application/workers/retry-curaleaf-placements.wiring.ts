import { curaleafApiRequest, executeCuraleafOrderPlacement } from '../integrations/curaleaf.service.js';
import { promotePatientAfterCuraleafPlacement } from '../patient-finance/patient-finance.js';
import { persistCuraleafPrescriptionIdentity } from '../prescriptions/curaleaf-prescription-record.js';
import { SqlWorkerEventRepository } from '../../repositories/sql/worker-event.sql.js';
import type { IntegrationConnectionRecord } from '../../repositories/ports/integration.port.js';
import type { sqlWorkerDeps } from './deps.js';
import { retryWaitingCuraleafPlacements, type PlacementRetryDeps } from './retry-curaleaf-placements.js';

const checkKey = (orderId: string) => `worker:curaleaf-placement-check:${orderId}`;

export function sqlPlacementRetryDeps(deps: ReturnType<typeof sqlWorkerDeps>): PlacementRetryDeps {
  const events = new SqlWorkerEventRepository();
  return {
    orderRepo: deps.orderRepo,
    checks: {
      async lastCheckedAt(orderId) {
        const row = await events.find(checkKey(orderId));
        return row?.transactionReference ?? row?.payloadHash ?? null;
      },
      async recordCheck(order, at) {
        await events.upsertCursor({ eventKey: checkKey(order.id), integration: 'CURALEAF', organisationId: order.organisationId, cursorAt: at });
      },
    },
    curaleafGet: (connection, path) => curaleafApiRequest(connection, path),
    place: (connection, order) => executeCuraleafOrderPlacement(connection, order),
    async afterPlaced(order, result) {
      const placed = result as { skipped?: boolean; purchaseOrder?: Record<string, unknown> | null; prescriptionId?: string | null; prescriberId?: string | null };
      // Placement records a purchase order it creates itself. One it only found at
      // Curaleaf is not recorded, so record it here on the latest snapshot.
      if (placed.skipped && placed.purchaseOrder) {
        const latest = await deps.orderRepo.findOrderById(order.id, order.organisationId);
        if (latest) {
          await persistCuraleafPrescriptionIdentity({
            organisationId: order.organisationId,
            orderId: order.id,
            patientId: order.patientId,
            snapshot: latest.quoteSnapshot,
            prescriptionId: placed.prescriptionId ?? null,
            prescriberId: placed.prescriberId ?? null,
            purchaseOrder: placed.purchaseOrder,
            fulfilmentStatus: 'SUPPLIER_PROCESSING',
          });
        }
      }
      await promotePatientAfterCuraleafPlacement(deps.patientFinanceDeps, order, placed).catch(error =>
        console.warn('Patient activation after Curaleaf placement note:', error),
      );
    },
  };
}

/** The scheduled sweep: every paid, unplaced order of these active Curaleaf connections. */
export async function retryWaitingCuraleafPlacementsSql(
  connections: IntegrationConnectionRecord[],
  deps: ReturnType<typeof sqlWorkerDeps>,
) {
  if (!connections.length) return null;
  const orders = await deps.orderRepo.listPaidUnplacedOrders(500);
  return retryWaitingCuraleafPlacements(connections, orders, sqlPlacementRetryDeps(deps));
}
