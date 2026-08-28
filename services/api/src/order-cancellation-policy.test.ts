import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { orderAllowsManualCancellation, orderMoneyWasTaken } from './order-cancellation-policy.js';

test('legacy pharmacy cancellation permits only explicit unpaid states', () => {
  assert.equal(orderAllowsManualCancellation({ paymentStatus: 'pending', paidAt: null }), true);
  assert.equal(orderAllowsManualCancellation({ paymentStatus: 'failed', paidAt: null }), true);
  assert.equal(orderAllowsManualCancellation({ paymentStatus: 'paid', paidAt: null }), false);
  assert.equal(orderAllowsManualCancellation({ paymentStatus: 'refund_required', paidAt: null }), false);
  assert.equal(orderAllowsManualCancellation({ paymentStatus: 'refunded', paidAt: null }), false);
  assert.equal(orderAllowsManualCancellation({ paymentStatus: 'pending', paidAt: '2026-08-28T00:00:00.000Z' }), false);
  assert.equal(orderAllowsManualCancellation({ paymentStatus: 'unknown', paidAt: null }), false);
  assert.equal(orderMoneyWasTaken({ paymentStatus: 'pending', paidAt: '2026-08-28T00:00:00.000Z' }), true);
});

test('legacy cancellation applies the payment guard before side effects', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'app.ts'), 'utf8');
  const handler = source.match(/app\.post\('\/v1\/portal\/orders\/:id\/cancellations',[\s\S]*?app\.post\('\/v1\/portal\/orders\/:id\/curaleaf-cancellation'/)?.[0];
  assert.ok(handler, 'legacy cancellation handler is present');
  const guard = handler.indexOf('orderAllowsManualCancellation(order)');
  assert.ok(guard > handler.indexOf("getTenantRecord('orders'"));
  assert.ok(handler.indexOf('curaleafSupportCases') > guard);
  assert.ok(handler.indexOf('batch.commit()') > guard);
  assert.match(handler, /PAID_ORDER_REQUIRES_RESOLUTION/);
});
