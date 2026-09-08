import assert from 'node:assert/strict';
import test from 'node:test';
import type { OrderRecord } from '../../repositories/ports/order.port.js';
import type { OrderLineRecord } from '../../repositories/ports/order-line.port.js';
import type { RefundRecord } from '../../repositories/ports/payment.port.js';
import { historicalPrescriptionRefundBreakdown } from './prescription-refund-backfill.js';

function historical(patch: { snapshot?: Record<string, unknown>; refund?: Partial<RefundRecord>; lines?: unknown[] } = {}) {
  const order = {
    id: 'order', organisationId: 'org', dispensingFeePence: 1000, pharmacyDeliveryPence: 500,
    quoteSnapshot: {
      prescriptions: [{ hhhPrescriptionId: 'rx1' }],
      refund: { id: 'refund-1', lines: [{ kind: 'medicine', key: 'medicine:pack-a', amountPence: 8500 }, { kind: 'dispensing', key: 'charge:dispensing', amountPence: 500 }] },
      ...patch.snapshot,
    },
  } as unknown as OrderRecord;
  const lines = (patch.lines ?? [
    { id: 'line1', prescriptionId: 'rx1', packId: 'pack-a', quantity: 1, fixedPatientPricePence: 8500, formulaName: 'Pack A' },
  ]) as unknown as OrderLineRecord[];
  const refund = { id: 'refund-1', status: 'COMPLETED', amountPence: 9000, ...patch.refund } as RefundRecord;
  return { order, lines, refund };
}

test('an unambiguous single-prescription refund is reconstructed exactly', () => {
  const { order, lines, refund } = historical();
  const breakdown = historicalPrescriptionRefundBreakdown(order, lines, refund)!;
  assert.equal(breakdown.prescriptionId, 'rx1');
  assert.equal(breakdown.dispensingFeePence, 500);
  assert.equal(breakdown.deliveryFeePence, 0);
  assert.deepEqual(breakdown.medicines, [{ orderLineId: 'line1', label: 'Pack A', quantity: 1, unitPricePence: 8500, amountPence: 8500 }]);
});

test('an ambiguous history is left for reconciliation rather than guessed at', () => {
  // A multi-prescription order can never attribute an order-level refund total to one Rx.
  assert.equal(historicalPrescriptionRefundBreakdown(
    ...Object.values(historical({ snapshot: { prescriptions: [{ hhhPrescriptionId: 'rx1' }, { hhhPrescriptionId: 'rx2' }] } })) as [OrderRecord, OrderLineRecord[], RefundRecord],
  ), null);

  // A total that does not add up from its own lines is not proven.
  const mismatched = historical({ refund: { amountPence: 12000 } });
  assert.equal(historicalPrescriptionRefundBreakdown(mismatched.order, mismatched.lines, mismatched.refund), null);

  // A refund amount that is not a whole number of packs cannot name a quantity.
  const partialPack = historical({ snapshot: { refund: { id: 'refund-1', lines: [{ kind: 'medicine', key: 'medicine:pack-a', amountPence: 4000 }] } }, refund: { amountPence: 4000 } });
  assert.equal(historicalPrescriptionRefundBreakdown(partialPack.order, partialPack.lines, partialPack.refund), null);

  // A fee share above the original charge is a records problem, not a backfill.
  const overFee = historical({ snapshot: { refund: { id: 'refund-1', lines: [{ kind: 'dispensing', key: 'charge:dispensing', amountPence: 2000 }] } }, refund: { amountPence: 2000 } });
  assert.equal(historicalPrescriptionRefundBreakdown(overFee.order, overFee.lines, overFee.refund), null);

  // Only a completed refund with no existing scope is a backfill candidate.
  const pending = historical({ refund: { status: 'PENDING_CONFIRMATION' } });
  assert.equal(historicalPrescriptionRefundBreakdown(pending.order, pending.lines, pending.refund), null);
  const scoped = historical({ refund: { prescriptionId: 'rx1' } });
  assert.equal(historicalPrescriptionRefundBreakdown(scoped.order, scoped.lines, scoped.refund), null);
});

test('a duplicated or unknown history line is never merged into a total', () => {
  const duplicated = historical({
    snapshot: { refund: { id: 'refund-1', lines: [{ kind: 'medicine', key: 'medicine:pack-a', amountPence: 8500 }, { kind: 'medicine', key: 'medicine:pack-a', amountPence: 500 }] } },
  });
  assert.equal(historicalPrescriptionRefundBreakdown(duplicated.order, duplicated.lines, duplicated.refund), null);

  const unknownKind = historical({
    snapshot: { refund: { id: 'refund-1', lines: [{ kind: 'surcharge', key: 'charge:other', amountPence: 9000 }] } },
  });
  assert.equal(historicalPrescriptionRefundBreakdown(unknownKind.order, unknownKind.lines, unknownKind.refund), null);
});
