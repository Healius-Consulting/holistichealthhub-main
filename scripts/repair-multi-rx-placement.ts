#!/usr/bin/env -S npx tsx
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MULTI_RX_REPAIR, planMultiRxPlacementRepair } from '../services/api-sql/src/application/orders/multi-rx-placement-repair.js';

const SERVICE_ID = 'hhh-platform-service';
const LOCATION = 'europe-west2';
const args = process.argv.slice(2);
const argument = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const orderNumber = argument('--order');
const projectId = argument('--project');
const apply = args.includes('--apply');
const acknowledge = args.includes('--acknowledge-curaleaf-read-only-repair');

if (orderNumber !== MULTI_RX_REPAIR.orderNumber) throw new Error(`Pass --order ${MULTI_RX_REPAIR.orderNumber}.`);
if (projectId !== MULTI_RX_REPAIR.projectId) throw new Error(`Pass --project ${MULTI_RX_REPAIR.projectId}.`);
if (apply && !acknowledge) throw new Error('Applying requires --acknowledge-curaleaf-read-only-repair. This command never calls Curaleaf.');

function executeGraphql<T>(operation: string, variables: Record<string, unknown>): T {
  const directory = mkdtempSync(join(tmpdir(), 'hhh-multi-rx-repair-'));
  const operationPath = join(directory, 'operation.gql');
  const variablesPath = join(directory, 'variables.json');
  writeFileSync(operationPath, operation.trim(), { mode: 0o600 });
  writeFileSync(variablesPath, JSON.stringify(variables), { mode: 0o600 });
  try {
    const output = execFileSync('firebase', [
      'dataconnect:execute', operationPath,
      '--project', projectId,
      '--service', SERVICE_ID,
      '--location', LOCATION,
      '--variables', `@${variablesPath}`,
      '--no-debug-details',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const jsonStart = output.indexOf('{');
    if (jsonStart < 0) throw new Error('Firebase CLI returned no JSON result.');
    return JSON.parse(output.slice(jsonStart)) as T;
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr || '') : '';
    if (/credentials are no longer valid/i.test(stderr)) throw new Error('Firebase authentication expired. No writes were made.');
    throw error;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const inspection = executeGraphql<{ data?: {
  orders?: Array<Record<string, unknown>>;
  orderPrescriptions?: Array<Record<string, unknown>>;
  prescriptionSerialUses?: Array<Record<string, unknown>>;
} }>(`
  query InspectMultiRxRepair($orderNumber: String!, $organisationId: UUID!, $orderId: UUID!) {
    orders(where: { orderNumber: { eq: $orderNumber }, organisationId: { eq: $organisationId } }, limit: 2) {
      id organisationId orderNumber status paymentStatus fulfilmentStatus quoteSnapshot
    }
    orderPrescriptions(where: { orderId: { eq: $orderId } }, limit: 20) {
      orderId prescriptionId supplierPurchaseOrderId placementState
    }
    prescriptionSerialUses(where: { orderId: { eq: $orderId }, organisationId: { eq: $organisationId } }, limit: 20) {
      id serialNumber prescriptionId curaleafPrescriptionId live
    }
  }
`, {
  orderNumber,
  orderId: MULTI_RX_REPAIR.orderId,
  organisationId: MULTI_RX_REPAIR.organisationId,
});

const orders = inspection.data?.orders ?? [];
if (orders.length !== 1) throw new Error(`Expected one scoped order, found ${orders.length}. No writes were made.`);
const plan = planMultiRxPlacementRepair({
  projectId,
  order: orders[0]!,
  orderPrescriptions: inspection.data?.orderPrescriptions ?? [],
  serialUses: inspection.data?.prescriptionSerialUses ?? [],
  repairedAt: new Date().toISOString(),
});

console.log(JSON.stringify({
  projectId,
  orderNumber,
  eligible: plan.eligible,
  reasons: plan.reasons,
  proposed: plan.eligible ? {
    prescription: 1,
    serial: MULTI_RX_REPAIR.serialNumber,
    prescriptionId: MULTI_RX_REPAIR.prescriptionId,
    purchaseOrderId: MULTI_RX_REPAIR.purchaseOrderId,
    customerReference: MULTI_RX_REPAIR.customerReference,
    preserved: ['Prescription 2', 'Prescription 3'],
    curaleafAction: 'none',
  } : undefined,
}, null, 2));

if (!plan.eligible) throw new Error(`Repair guard failed: ${plan.reasons.join(', ')}. No writes were made.`);
if (!apply) {
  console.log('Dry run only. No SQL or Curaleaf writes were made.');
  process.exit(0);
}

executeGraphql(`
  mutation RepairMultiRxPlacement(
    $orderId: UUID!
    $organisationId: UUID!
    $prescriptionId: UUID!
    $serialUseId: UUID!
    $supplierPrescriptionId: String!
    $supplierPurchaseOrderId: String!
    $quoteSnapshot: Any!
    $reason: String!
    $externalReference: String!
  ) {
    order_update(key: { id: $orderId }, data: { quoteSnapshot: $quoteSnapshot, updatedAt_expr: "request.time" })
    prescription_update(key: { id: $prescriptionId }, data: {
      supplierPrescriptionId: $supplierPrescriptionId
      status: PLACED
      updatedAt_expr: "request.time"
    })
    orderPrescription_upsert(data: {
      orderId: $orderId
      prescriptionId: $prescriptionId
      placementState: PLACED
      supplierPurchaseOrderId: $supplierPurchaseOrderId
      placedAt_expr: "request.time"
      updatedAt_expr: "request.time"
    })
    prescriptionSerialUse_update(key: { id: $serialUseId }, data: {
      prescriptionId: $prescriptionId
      curaleafPrescriptionId: $supplierPrescriptionId
      updatedAt_expr: "request.time"
    })
    placementEvent_insert(data: {
      organisationId: $organisationId
      orderId: $orderId
      toState: PLACED
      reason: $reason
      externalReference: $externalReference
    })
  }
`, {
  orderId: MULTI_RX_REPAIR.orderId,
  organisationId: MULTI_RX_REPAIR.organisationId,
  prescriptionId: MULTI_RX_REPAIR.hhhPrescriptionId,
  serialUseId: MULTI_RX_REPAIR.serialUseId,
  supplierPrescriptionId: MULTI_RX_REPAIR.prescriptionId,
  supplierPurchaseOrderId: MULTI_RX_REPAIR.purchaseOrderId,
  quoteSnapshot: plan.nextSnapshot,
  reason: 'Corrected Prescription 1 supplier identity from the verified existing Curaleaf purchase order; no supplier request was sent.',
  externalReference: 'repair:multi-rx-placement:ORD-MTDUS9JV-816507F909:v1',
});

console.log('Prescription 1 SQL identity repaired. Curaleaf was not called and no supplier order was created.');
