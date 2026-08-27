#!/usr/bin/env -S npx tsx
/**
 * Backfill SQL shipment rows for consignments Curaleaf dispatched before the poller
 * started writing them.
 *
 * Until `28b51bf` the poller recorded shipments only inside `quoteSnapshot.curaleaf`,
 * and the SQL row was created lazily by the goods-in route when the packs arrived. Any
 * order dispatched but not yet checked in therefore has no shipment row at all, so it is
 * invisible to `listShipments` / `GET /portal/shipments` while it is genuinely in
 * transit. The snapshot kept Curaleaf's own `createdAt` per shipment, so the real
 * dispatch time can be restored rather than left null.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   npx tsx scripts/backfill-supplier-shipment-rows.ts --project <project-id>
 *   npx tsx scripts/backfill-supplier-shipment-rows.ts --project <project-id> --apply
 *
 * Optional: --organisation <uuid> to scope to one pharmacy, --limit <n> per tenant.
 *
 * Idempotent. Every row is checked for an existing `supplierShipmentId` first, and the
 * row it writes is derived by `supplierShipmentRowInput` — the same function the poller
 * uses — so backfilled rows are identical to ones written live.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { supplierShipmentRowInput } from '../services/api-sql/src/application/workers/poll-curaleaf-shipment-row.js';
import type { CuraleafShipmentLike } from '../services/api-sql/src/application/orders/curaleaf-fulfilment.js';

const SERVICE_ID = 'hhh-platform-service';
const LOCATION = 'europe-west2';

const args = process.argv.slice(2);
function argument(name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const projectId = argument('--project');
const organisationFilter = argument('--organisation');
const limit = Number(argument('--limit') ?? 500);
const apply = args.includes('--apply');

if (!projectId) throw new Error('Pass the exact Firebase project with --project <project-id>. No writes were made.');
if (!Number.isInteger(limit) || limit < 1 || limit > 2000) {
  throw new Error('--limit must be a whole number between 1 and 2000. No writes were made.');
}

function executeGraphql<T>(operation: string, variables: Record<string, unknown>): T {
  const directory = mkdtempSync(join(tmpdir(), 'hhh-shipment-backfill-'));
  const operationPath = join(directory, 'operation.gql');
  const variablesPath = join(directory, 'variables.json');
  writeFileSync(operationPath, operation.trim(), { mode: 0o600 });
  writeFileSync(variablesPath, JSON.stringify(variables), { mode: 0o600 });
  try {
    let output: string;
    try {
      output = execFileSync('firebase', [
        'dataconnect:execute', operationPath,
        '--project', projectId!,
        '--service', SERVICE_ID,
        '--location', LOCATION,
        '--variables', `@${variablesPath}`,
        '--no-debug-details',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout || '') : '';
      if (/credentials are no longer valid/i.test(stdout)) {
        throw new Error('Firebase CLI authentication has expired. Run `firebase login --reauth`, then repeat the dry run.');
      }
      throw new Error('Firebase Data Connect call failed. Nothing further was attempted.');
    }
    const start = output.indexOf('{');
    if (start < 0) throw new Error('Firebase Data Connect returned no JSON payload.');
    return JSON.parse(output.slice(start)) as T;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

type OrderRow = {
  id: string;
  organisationId: string;
  orderNumber: string | null;
  quoteSnapshot: unknown;
};

const organisations = organisationFilter
  ? [{ id: organisationFilter }]
  : executeGraphql<{ data?: { organisations?: Array<{ id: string }> } }>(`
      query BackfillOrganisations { organisations(limit: 500) { id } }
    `, {}).data?.organisations ?? [];

if (!organisations.length) throw new Error('No organisations were returned. No writes were made.');

const summary = {
  projectId,
  apply,
  organisations: organisations.length,
  ordersScanned: 0,
  snapshotShipments: 0,
  alreadyPresent: 0,
  written: 0,
  wouldWrite: 0,
  skippedNoPurchaseOrder: 0,
  failed: 0,
};
const planned: Array<Record<string, unknown>> = [];

for (const organisation of organisations) {
  const orders = executeGraphql<{ data?: { orders?: OrderRow[] } }>(`
    query BackfillOrders($organisationId: UUID!, $limit: Int!) {
      orders(where: { organisationId: { eq: $organisationId } }, limit: $limit) {
        id organisationId orderNumber quoteSnapshot
      }
    }
  `, { organisationId: organisation.id, limit }).data?.orders ?? [];

  for (const order of orders) {
    summary.ordersScanned += 1;
    const snapshot = order.quoteSnapshot && typeof order.quoteSnapshot === 'object'
      ? order.quoteSnapshot as Record<string, unknown>
      : {};
    const curaleaf = snapshot.curaleaf && typeof snapshot.curaleaf === 'object'
      ? snapshot.curaleaf as Record<string, unknown>
      : {};
    const shipments = Array.isArray(curaleaf.shipments) ? curaleaf.shipments as CuraleafShipmentLike[] : [];
    if (!shipments.length) continue;

    for (const shipment of shipments) {
      summary.snapshotShipments += 1;
      // Identical derivation to the poller, so a backfilled row and a live one match.
      const row = supplierShipmentRowInput(order, shipment);
      if (!row) {
        summary.skippedNoPurchaseOrder += 1;
        continue;
      }

      const existing = executeGraphql<{ data?: { shipments?: Array<{ id: string }> } }>(`
        query BackfillFindShipment($organisationId: UUID!, $supplierShipmentId: String!) {
          shipments(
            where: {
              organisationId: { eq: $organisationId }
              supplierShipmentId: { eq: $supplierShipmentId }
            }
            limit: 1
          ) { id }
        }
      `, { organisationId: row.organisationId, supplierShipmentId: row.supplierShipmentId })
        .data?.shipments?.[0];
      if (existing?.id) {
        summary.alreadyPresent += 1;
        continue;
      }

      if (!apply) {
        summary.wouldWrite += 1;
        planned.push({
          orderId: row.orderId,
          orderNumber: order.orderNumber,
          supplierShipmentId: row.supplierShipmentId,
          supplierPurchaseOrderId: row.supplierPurchaseOrderId,
          dispatchedAt: row.dispatchedAt,
        });
        continue;
      }

      try {
        executeGraphql(`
          mutation BackfillCreateShipment(
            $organisationId: UUID!
            $orderId: UUID!
            $supplierPurchaseOrderId: String!
            $supplierShipmentId: String
            $supplierCustomerReference: String
            $status: ShipmentStatus!
            $dispatchedAt: Timestamp
          ) {
            shipment_insert(data: {
              organisationId: $organisationId
              orderId: $orderId
              supplierPurchaseOrderId: $supplierPurchaseOrderId
              supplierShipmentId: $supplierShipmentId
              supplierCustomerReference: $supplierCustomerReference
              status: $status
              dispatchedAt: $dispatchedAt
            }) { id }
          }
        `, { ...row, status: 'DISPATCHED' });
        summary.written += 1;
      } catch {
        // One bad row must not abandon the rest of the estate; the id is reported so it
        // can be chased. No patient data is logged.
        summary.failed += 1;
        planned.push({ failed: true, orderId: row.orderId, supplierShipmentId: row.supplierShipmentId });
      }
    }
  }
}

console.log(JSON.stringify({ ...summary, planned: planned.slice(0, 50) }, null, 2));
if (!apply) {
  console.log(`Dry run only. ${summary.wouldWrite} shipment row(s) would be created. Re-run with --apply to write them.`);
} else {
  console.log(`Backfill complete. ${summary.written} written, ${summary.alreadyPresent} already present, ${summary.failed} failed.`);
}
