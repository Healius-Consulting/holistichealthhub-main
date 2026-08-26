#!/usr/bin/env -S npx tsx
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planFalseRejectionRepair } from '../services/api-sql/src/application/orders/false-rejection-repair.js';

const EXPECTED_ORDER_NUMBER = 'ORD-MT9EHKX0';
const EXPECTED_ORGANISATION_ID = '70913a30-71c3-4a41-952e-d532927af58c';
const EXPECTED_PROJECT_ID = 'hhh26-4ebd2';
const SERVICE_ID = 'hhh-platform-service';
const LOCATION = 'europe-west2';

const args = process.argv.slice(2);
function argument(name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const orderNumber = argument('--order');
const projectId = argument('--project');
const apply = args.includes('--apply');
const acknowledge = args.includes('--acknowledge-local-only-repair');

if (orderNumber !== EXPECTED_ORDER_NUMBER) {
  throw new Error(`Pass --order ${EXPECTED_ORDER_NUMBER}. This repair is intentionally scoped to one investigated order.`);
}
if (projectId !== EXPECTED_PROJECT_ID) {
  throw new Error(`Pass the exact project with --project ${EXPECTED_PROJECT_ID}.`);
}
if (apply && !acknowledge) {
  throw new Error('Applying requires --acknowledge-local-only-repair. The command does not call or retry Curaleaf.');
}
const exactOrderNumber = orderNumber;
const exactProjectId = projectId;

function executeGraphql<T>(operation: string, variables: Record<string, unknown>): T {
  const directory = mkdtempSync(join(tmpdir(), 'hhh-false-rejection-repair-'));
  const operationPath = join(directory, 'operation.gql');
  const variablesPath = join(directory, 'variables.json');
  writeFileSync(operationPath, operation.trim(), { mode: 0o600 });
  writeFileSync(variablesPath, JSON.stringify(variables), { mode: 0o600 });
  try {
    let output: string;
    try {
      output = execFileSync('firebase', [
        'dataconnect:execute', operationPath,
        '--project', exactProjectId,
        '--service', SERVICE_ID,
        '--location', LOCATION,
        '--variables', `@${variablesPath}`,
        '--no-debug-details',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      const stdout = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout || '') : '';
      if (/credentials are no longer valid/i.test(stdout)) {
        throw new Error('Firebase CLI authentication has expired. Run `firebase login --reauth`, then repeat the dry run. No writes were made.');
      }
      throw new Error('Firebase Data Connect inspection failed. No writes were made.');
    }
    const jsonStart = output.indexOf('{');
    if (jsonStart < 0) throw new Error('Firebase CLI returned no JSON result.');
    return JSON.parse(output.slice(jsonStart)) as T;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const inspection = executeGraphql<{
  data?: {
    orders?: Array<Record<string, unknown>>;
  };
}>(`
  query InspectFalseRejectionOrder($orderNumber: String!, $organisationId: UUID!) {
    orders(where: {
      orderNumber: { eq: $orderNumber }
      organisationId: { eq: $organisationId }
    }, limit: 2) {
      id organisationId orderNumber status paymentStatus fulfilmentStatus paidAt quoteSnapshot
    }
  }
`, { orderNumber: exactOrderNumber, organisationId: EXPECTED_ORGANISATION_ID });

const orders = inspection.data?.orders ?? [];
if (orders.length !== 1) throw new Error(`Expected exactly one matching order; found ${orders.length}. No writes were made.`);
const order = orders[0]!;
const orderId = String(order.id || '');

const dependencies = executeGraphql<{
  data?: {
    payments?: Array<Record<string, unknown>>;
    refunds?: Array<Record<string, unknown>>;
    integrationOperations?: Array<Record<string, unknown>>;
  };
}>(`
  query InspectFalseRejectionDependencies($orderId: UUID!, $organisationId: UUID!) {
    payments(where: { orderId: { eq: $orderId }, organisationId: { eq: $organisationId } }, limit: 20) {
      id status amountPence route transactionReference paidAt
    }
    refunds(where: { orderId: { eq: $orderId }, organisationId: { eq: $organisationId } }, limit: 20) {
      id status amountPence externalReference
    }
    integrationOperations(where: { orderId: { eq: $orderId }, organisationId: { eq: $organisationId } }, limit: 100) {
      id operationType status supplierPurchaseOrderId responsePayload
    }
  }
`, { orderId, organisationId: EXPECTED_ORGANISATION_ID });

const plan = planFalseRejectionRepair({
  order: order as Parameters<typeof planFalseRejectionRepair>[0]['order'],
  expectedOrderNumber: EXPECTED_ORDER_NUMBER,
  expectedOrganisationId: EXPECTED_ORGANISATION_ID,
  payments: dependencies.data?.payments ?? [],
  refunds: dependencies.data?.refunds ?? [],
  operations: dependencies.data?.integrationOperations ?? [],
});

console.log(JSON.stringify({
  projectId: exactProjectId,
  orderNumber: exactOrderNumber,
  orderId,
  eligible: plan.eligible,
  reasons: plan.reasons,
  current: {
    status: order.status,
    paymentStatus: order.paymentStatus,
    fulfilmentStatus: order.fulfilmentStatus,
    paidAtPresent: Boolean(order.paidAt),
  },
  dependencyCounts: {
    payments: dependencies.data?.payments?.length ?? 0,
    refunds: dependencies.data?.refunds?.length ?? 0,
    integrationOperations: dependencies.data?.integrationOperations?.length ?? 0,
  },
  ...(plan.eligible ? {
    proposed: {
      status: plan.nextOrderStatus,
      paymentStatus: plan.nextPaymentStatus,
      fulfilmentStatus: plan.nextFulfilmentStatus,
      supplierAction: 'none',
    },
  } : {}),
}, null, 2));

if (!plan.eligible) throw new Error(`Repair guard failed: ${plan.reasons.join(', ')}. No writes were made.`);
if (!apply) {
  console.log('Dry run only. No SQL or Curaleaf writes were made.');
  process.exit(0);
}

executeGraphql(`
  mutation RepairFalseRejection(
    $orderId: UUID!
    $organisationId: UUID!
    $quoteSnapshot: Any!
    $reason: String!
    $externalReference: String!
  ) {
    order_update(key: { id: $orderId }, data: {
      status: PROCESSING
      paymentStatus: PAID
      fulfilmentStatus: SUPPLIER_PENDING
      quoteSnapshot: $quoteSnapshot
      cancelledAt: null
      updatedAt_expr: "request.time"
    })
    placementEvent_insert(data: {
      organisationId: $organisationId
      orderId: $orderId
      toState: PENDING_PLACEMENT
      reason: $reason
      externalReference: $externalReference
    })
  }
`, {
  orderId,
  organisationId: EXPECTED_ORGANISATION_ID,
  quoteSnapshot: plan.nextSnapshot,
  reason: 'Reopened after verified false prescription rejection classification; prescriber correction remains required.',
  externalReference: 'repair:false-rejection:ORD-MT9EHKX0:v1',
});

console.log('Local SQL order state repaired. No Curaleaf request was sent; correct and verify the prescriber before resuming placement.');
