import { curaleafEntityRecord } from '../integrations/curaleaf-events.js';
import { curaleafCancellationBlocksPlacement, isQuoteReviewBlocking } from '../orders/quote-review.js';
import {
  curaleafSubOrders,
  lookupKeyedRecord,
  pendingPlacementRxIndexes,
  snapshotRxKey,
  snapshotRxList,
} from '../prescriptions/snapshot-rx.js';
import type { IntegrationConnectionRecord } from '../../repositories/ports/integration.port.js';
import type { OrderRecord, OrderRepositoryPort } from '../../repositories/ports/order.port.js';

/**
 * Paid orders must never sit unplaced just because Curaleaf did not tell us something
 * changed. On 12 Nov 2026 fifteen UAT orders waited for a prescriber that Curaleaf later
 * verified, but `/v1/prescriber-events/` never listed that prescriber (not when it was
 * created, not when it was verified), so the event-driven retry in poll-curaleaf.ts
 * never fired. This sweep asks Curaleaf directly instead, on a backoff, and places the
 * order as soon as the prescriber is verified or the prescription is active.
 *
 * Placement itself re-checks stock and price before it creates anything at Curaleaf and
 * never double-submits, so retrying is safe. Orders that need a person (quote review,
 * correction, cancellation) are left alone: the order page already shows them.
 */

type Snapshot = Record<string, unknown>;

function asRecord(value: unknown): Snapshot {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Snapshot : {};
}

/** What each unplaced prescription is waiting for, as recorded by the last placement attempt. */
export type PendingRx = {
  rxIndex: number;
  waitingFor: 'prescriber_verification' | 'prescription_activation' | null;
  prescriberId: string | null;
  prescriptionId: string | null;
};

export function pendingPlacements(snapshot: unknown): PendingRx[] {
  const root = asRecord(snapshot);
  const prescriptions = snapshotRxList(root);
  const subOrders = curaleafSubOrders(root);
  return pendingPlacementRxIndexes(root).map(rxIndex => {
    const rx = prescriptions[rxIndex];
    const record = asRecord(
      lookupKeyedRecord(subOrders, rx)
      ?? subOrders[snapshotRxKey(rx, rxIndex)]
      ?? (rxIndex === 0 ? root.curaleaf : null),
    );
    const waitingFor = record.waitingFor === 'prescriber_verification' || record.waitingFor === 'prescription_activation'
      ? record.waitingFor
      : null;
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : null);
    return { rxIndex, waitingFor, prescriberId: text(record.prescriberId), prescriptionId: text(record.prescriptionId) };
  });
}

/** Why an order is not retried, or null when it should be. Exported for tests. */
export function placementRetrySkipReason(order: OrderRecord): string | null {
  if (String(order.paymentStatus || '').toUpperCase() !== 'PAID' && !order.paidAt) return 'not_paid';
  if (['CANCELLED', 'COMPLETED'].includes(String(order.status || '').toUpperCase())) return 'closed';
  if (order.archivedAt || String(order.resolutionStatus || '').toUpperCase() === 'RESOLVED') return 'resolved';
  const snapshot = asRecord(order.quoteSnapshot);
  if (curaleafCancellationBlocksPlacement(snapshot)) return 'cancelled';
  if (isQuoteReviewBlocking(snapshot)) return 'quote_review';
  const attention = asRecord(snapshot.curaleafAttention);
  if (attention.status === 'correction_required' || attention.status === 'terminal') return 'needs_correction';
  const flow = asRecord(snapshot.prescriptionFlow);
  if (Object.values(flow).some(entry => asRecord(entry).manualPlaceRequired === true)) return 'manual_placement';
  if (!snapshotRxList(snapshot).length) return 'no_prescriptions';
  if (!pendingPlacements(snapshot).length) return 'placed';
  return null;
}

const MINUTE = 60_000;

/**
 * How long to wait between checks, from how long the order has been paid: every 5
 * minutes for the first 2 hours, every 15 minutes up to 2 days, then hourly. Curaleaf
 * verification is a person at Curaleaf, so after the first day an hourly check is plenty.
 */
export function placementCheckIntervalMs(order: Pick<OrderRecord, 'paidAt' | 'createdAt'>, now: Date) {
  const since = Date.parse(String(order.paidAt || order.createdAt || ''));
  const age = Number.isFinite(since) ? now.getTime() - since : 0;
  if (age < 2 * 60 * MINUTE) return 5 * MINUTE;
  if (age < 48 * 60 * MINUTE) return 15 * MINUTE;
  return 60 * MINUTE;
}

export type PlacementRetryDeps = {
  orderRepo: Pick<OrderRepositoryPort, 'appendPlacementEvent'>;
  /** Last check time per order, so each order is checked on its own backoff. */
  checks: {
    lastCheckedAt(orderId: string): Promise<string | null>;
    recordCheck(order: OrderRecord, at: string): Promise<void>;
  };
  /** GET against this pharmacy's Curaleaf connection. */
  curaleafGet(connection: IntegrationConnectionRecord, path: string): Promise<unknown>;
  place(connection: IntegrationConnectionRecord, order: OrderRecord): Promise<unknown>;
  afterPlaced?(order: OrderRecord, result: unknown): Promise<void>;
};

export type PlacementRetrySummary = {
  waiting: number;
  checked: number;
  stillWaiting: number;
  attempted: number;
  placed: number;
  errors: number;
};

function purchaseOrderIdOf(result: unknown) {
  const id = asRecord(asRecord(result).purchaseOrder).id;
  return typeof id === 'string' && id ? id : null;
}

/**
 * Retry every paid, unplaced order of these Curaleaf connections that is due a check.
 * `orders` is the paid-open list; orders of pharmacies without a connection are ignored.
 */
export async function retryWaitingCuraleafPlacements(
  connections: IntegrationConnectionRecord[],
  orders: OrderRecord[],
  deps: PlacementRetryDeps,
  options: { now?: Date; maxPlacementsPerConnection?: number } = {},
): Promise<PlacementRetrySummary> {
  const now = options.now ?? new Date();
  const maxPlacements = options.maxPlacementsPerConnection ?? 5;
  const summary: PlacementRetrySummary = { waiting: 0, checked: 0, stillWaiting: 0, attempted: 0, placed: 0, errors: 0 };
  const byOrganisation = new Map(connections.map(connection => [connection.organisationId, connection]));
  const attemptsByConnection = new Map<string, number>();
  // One Curaleaf GET per prescriber or prescription per run, however many orders share it.
  const stateCache = new Map<string, Promise<string | null>>();

  const entityState = (connection: IntegrationConnectionRecord, kind: 'prescriber' | 'prescription', id: string) => {
    const key = `${connection.organisationId}:${kind}:${id}`;
    if (!stateCache.has(key)) {
      const path = kind === 'prescriber' ? `/v1/prescribers/${encodeURIComponent(id)}/` : `/v1/prescriptions/${encodeURIComponent(id)}/`;
      stateCache.set(key, deps.curaleafGet(connection, path)
        .then(raw => String(curaleafEntityRecord(raw, kind).state || '').toUpperCase() || null));
    }
    return stateCache.get(key)!;
  };

  for (const order of orders) {
    const connection = byOrganisation.get(order.organisationId);
    if (!connection || placementRetrySkipReason(order)) continue;
    summary.waiting += 1;
    try {
      const last = Date.parse(String(await deps.checks.lastCheckedAt(order.id) ?? ''));
      if (Number.isFinite(last) && now.getTime() - last < placementCheckIntervalMs(order, now)) continue;
      if ((attemptsByConnection.get(connection.organisationId) ?? 0) >= maxPlacements) continue;
      summary.checked += 1;
      await deps.checks.recordCheck(order, now.toISOString());

      // Ready when any unplaced prescription is no longer held at Curaleaf. A
      // prescription with nothing recorded (an earlier attempt failed before Curaleaf
      // answered) is always ready to try again.
      let ready = false;
      for (const pending of pendingPlacements(order.quoteSnapshot)) {
        if (pending.waitingFor === 'prescriber_verification' && pending.prescriberId) {
          if (await entityState(connection, 'prescriber', pending.prescriberId) !== 'UNVERIFIED') ready = true;
        } else if (pending.waitingFor === 'prescription_activation' && pending.prescriptionId) {
          if (await entityState(connection, 'prescription', pending.prescriptionId) !== 'PENDING') ready = true;
        } else {
          ready = true;
        }
        if (ready) break;
      }
      if (!ready) {
        summary.stillWaiting += 1;
        continue;
      }

      attemptsByConnection.set(connection.organisationId, (attemptsByConnection.get(connection.organisationId) ?? 0) + 1);
      summary.attempted += 1;
      const result = await deps.place(connection, order);
      const purchaseOrderId = purchaseOrderIdOf(result);
      if (!purchaseOrderId) continue;
      summary.placed += 1;
      await deps.afterPlaced?.(order, result);
      // A skipped result that still carries a purchase order means Curaleaf already had
      // one for this reference (an earlier attempt got through but was not recorded).
      const foundExisting = asRecord(result).skipped === true;
      await deps.orderRepo.appendPlacementEvent({
        organisationId: order.organisationId,
        orderId: order.id,
        fromState: 'PENDING_PLACEMENT',
        toState: 'PLACED',
        reason: foundExisting
          ? `Curaleaf Purchase Order ${purchaseOrderId} found at Curaleaf on an automatic recheck and recorded`
          : `Curaleaf Purchase Order ${purchaseOrderId} placed automatically after Curaleaf cleared the hold`,
        externalReference: purchaseOrderId,
      });
    } catch (error) {
      summary.errors += 1;
      console.warn('[Curaleaf placement retry] Order check failed.', {
        orderId: order.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
  return summary;
}
