import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const routerSource = readFileSync(join(here, 'prescription-refund.router.ts'), 'utf8');
const serviceSource = readFileSync(join(here, '../../application/payments/prescription-refund-service.ts'), 'utf8');
const orderRouterSource = readFileSync(join(here, 'order.router.ts'), 'utf8');
const reconciliationSource = readFileSync(join(here, '../../application/payments/worldpay-reconciliation.ts'), 'utf8');

test('every prescription refund route is staff-authenticated and tenant-scoped', () => {
  const routes = routerSource.match(/router\.(get|post)\(`?\$?\{?route\}?[^,]*,[\s\S]*?\n    \} catch \(error\) \{ next\(error\); \}\n  \}\);/g) ?? [];
  assert.equal(routes.length, 3, 'preview, submit and confirm are the only routes');
  for (const route of routes) {
    assert.match(route, /requireStaff\('pharmacy'\)/, 'the route requires a pharmacy staff session');
    assert.match(route, /assertTenantScope\(req\.context!\)/, 'the route derives its organisation from the session, never the body');
  }
  for (const write of routes.filter(route => route.startsWith('router.post'))) {
    assert.match(write, /requireCsrf/);
    assert.match(write, /requirePharmacyOperationalWrites/);
  }
  assert.doesNotMatch(routerSource, /organisationId: (?:String\()?req\.(body|query|params)/, 'the tenant is never taken from the request');
});

test('the refund is reserved against the payment before anything is sent to the provider', () => {
  const submit = serviceSource.match(/export async function submitPrescriptionRefund[\s\S]*?\n\}/)?.[0];
  assert.ok(submit, 'the submission path is present');
  const idempotencyLookup = submit.indexOf('findRefundByIdempotencyKey');
  const reservation = submit.indexOf('reservePrescriptionRefund');
  const providerCall = submit.indexOf('submitToWorldpay');
  assert.ok(idempotencyLookup >= 0 && idempotencyLookup < reservation, 'a repeated request id is resolved before a new reservation');
  assert.ok(reservation < providerCall, 'the payment reservation precedes provider submission');

  const worldpay = serviceSource.match(/async function submitToWorldpay[\s\S]*?\n\}/)?.[0];
  assert.ok(worldpay, 'the provider submission path is present');
  assert.ok(
    worldpay.indexOf('markRefundVerification') < worldpay.indexOf('deps.submitRefund'),
    'an uncertain outcome is stamped before the network call, so a crash never resubmits',
  );
});

test('prescription-scoped refunds never cancel the order, delete files, or close serials', () => {
  for (const source of [routerSource, serviceSource]) {
    assert.doesNotMatch(source, /markRefundResolution|updateOrderStatus|deletePrescriptionFile|closeSerial|archiveOrder/);
  }
});

test('the whole-order refund routes hand multi-prescription orders to the scoped flow', () => {
  const requestHandler = orderRouterSource.match(/const existingRefunds = await paymentRepo\.listRefundsByOrderId[\s\S]{0,400}/)?.[0];
  assert.ok(requestHandler, 'the legacy refund request handler is present');
  assert.match(requestHandler, /PRESCRIPTION_REFUND_REQUIRED/);
  assert.match(requestHandler, /snapshotRxList\(order\.quoteSnapshot\)\.length > 1/);
  assert.match(orderRouterSource, /row\.id === refundId && row\.prescriptionId[\s\S]{0,120}PRESCRIPTION_REFUND_REQUIRED/);
  assert.match(orderRouterSource, /payment\.pendingRefundId \|\| refundHistory\.some\(row => row\.prescriptionId\)/,
    'a reserved or scoped refund blocks a replacement funded by the same payment');
});

test('a repeated Worldpay callback cannot refund or reopen a settled prescription refund', () => {
  const prepared = reconciliationSource.match(/async function reconcilePreparedWorldpayRefund[\s\S]*?\n\}/)?.[0];
  assert.ok(prepared, 'the prepared-refund reconciliation path is present');
  assert.match(prepared, /\['VERIFICATION_PENDING', 'RECONCILIATION_REQUIRED'\]\.includes\(String\(row\.status\)\.toUpperCase\(\)\)/,
    'only an unresolved refund is picked up, so a completed one is never reprocessed');
  assert.match(prepared, /if \(refund\.prescriptionId\) \{\s*await completePrescriptionRefund\(/,
    'a scoped refund completes through the shared idempotent path, not the whole-order one');
  const scopedBranch = prepared.match(/if \(refund\.prescriptionId\) \{[\s\S]*?\n  \}/)?.[0] ?? '';
  assert.ok(scopedBranch, 'the scoped completion branch is present');
  assert.doesNotMatch(scopedBranch, /markRefundResolution|updateOrderStatus/,
    'a scoped refund never stamps a whole-order refund resolution');

  // With a scoped refund on the payment, a provider refund event must not reopen the
  // whole-order refund gate that the pharmacy has already resolved per prescription.
  assert.match(reconciliationSource, /history\.some\(row => row\.prescriptionId && row\.paymentId === payment\.id\)[\s\S]{0,160}state: 'reconciled'/);
});
