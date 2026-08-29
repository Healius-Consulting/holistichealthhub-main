import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appContext = readFileSync(new URL('../src/context/AppContext.tsx', import.meta.url), 'utf8');
const contracts = readFileSync(new URL('../src/shared/contracts.ts', import.meta.url), 'utf8');
const createOrder = readFileSync(new URL('../src/pages/create-order/CreateOrderPage.tsx', import.meta.url), 'utf8');
const pharmacyContracts = readFileSync(new URL('../services/api-sql/src/transport/portal/pharmacy-contracts.ts', import.meta.url), 'utf8');

test('purchaseOrderId has one meaning in the pharmacy client', () => {
  assert.doesNotMatch(appContext, /\bpoRef\b/);
  assert.doesNotMatch(appContext, /purchaseOrderId:\s*action\.customerReference/);
  assert.match(appContext, /purchaseOrderId:\s*rxHasPo\s*\?\s*purchaseOrderReference\(flow\?\.purchaseOrderId/);
});

test('the general order contract does not alias order identity as payment identity', () => {
  assert.doesNotMatch(contracts, /worldpayPaymentId\?:/);
  assert.doesNotMatch(contracts, /paymentTransactionReference\?:/);
  assert.doesNotMatch(pharmacyContracts, /paymentTransactionReference:\s*order\.orderNumber/);
  assert.doesNotMatch(appContext, /record\.orderNumber\s*\?\?\s*record\.paymentTransactionReference/);
});

test('new prescription payloads name their temporary identity explicitly', () => {
  assert.match(createOrder, /clientKey:\s*String\(rx\.id\)/);
  assert.doesNotMatch(createOrder, /prescriptions:\s*activeOrder\.prescriptions\.map[\s\S]{0,100}id:\s*String\(rx\.id\)/);
  assert.match(contracts, /clientKey\?: string/);
  assert.match(contracts, /hhhPrescriptionId\?: string/);
});
