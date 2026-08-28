import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const routerSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'order.router.ts'), 'utf8');

test('generic cancellation rejects non-unpaid orders before any mutation', () => {
  const handler = routerSource.match(/router\.post\('\/portal\/orders\/:id\/cancellations',[\s\S]*?router\.post\('\/portal\/orders\/:id\/quote-review\/resolve'/)?.[0];
  assert.ok(handler, 'generic cancellation handler is present');
  const lookup = handler.indexOf('findOrderById');
  const guard = handler.indexOf('orderAllowsManualCancellation(order)');
  const snapshotMutation = handler.indexOf('updateQuoteSnapshot');
  const statusMutation = handler.indexOf('updateOrderStatus');
  assert.ok(lookup >= 0 && guard > lookup, 'the tenant-scoped order is loaded before policy evaluation');
  assert.ok(snapshotMutation > guard, 'snapshot mutation occurs only after the unpaid-order guard');
  assert.ok(statusMutation > guard, 'status mutation occurs only after the unpaid-order guard');
  assert.match(handler, /PAID_ORDER_REQUIRES_RESOLUTION/);
});

test('paid quote-review cancellation stays on the dedicated resolution endpoint', () => {
  const handler = routerSource.match(/router\.post\('\/portal\/orders\/:id\/quote-review\/resolve',[\s\S]*?router\.post\('\/portal\/orders\/:id\/curaleaf-cancellation'/)?.[0];
  assert.ok(handler, 'quote-review resolution handler is present');
  assert.match(handler, /if \(!orderMoneyWasTaken\(order\)\)/);
  assert.match(handler, /if \(input\.action === 'cancel'\)/);
  assert.match(handler, /status: 'CANCELLED'/);
  assert.match(handler, /status: 'recreate_required'/);
  assert.match(handler, /options: \['replace', 'refund'\]/);
});
