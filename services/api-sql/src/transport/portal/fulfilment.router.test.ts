import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { HttpError } from '../../domain/common/errors.js';
import { assertGoodsReceiptRecorded, curaleafScopeForShipment, goodsReceiptStatus } from './fulfilment.router.js';

const entityIdSchema = z.string().regex(/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i);

const goodsReceiptSchema = z.object({
  orderId: entityIdSchema.optional(),
  receiptNumber: z.string().min(1).max(100).optional(),
  status: z.enum(['COMPLETE', 'DAMAGED', 'DISCREPANCY', 'PARTIAL']).optional(),
  notes: z.string().max(4000).optional(),
  items: z.array(z.object({
    productId: z.string(),
    expectedQuantity: z.number().int().nonnegative().optional(),
    receivedQuantity: z.number().int().nonnegative(),
  })).optional(),
  lines: z.array(z.object({
    productId: z.string(),
    expectedQuantity: z.number().int().nonnegative().optional(),
    receivedQuantity: z.number().int().nonnegative(),
  })).optional(),
});

describe('portal goods receipt validation', () => {
  it('accepts compact tenant ids and dashed UUID order ids', () => {
    const payload = {
      organisationId: '70913a3071c34a41952ed532927af58c',
      orderId: '5a8b4ac3-236c-41f7-a37b-0132b7892637',
      items: [{
        productId: '9f2d6958-2d76-4338-9e5f-6fd383dfff36',
        expectedQuantity: 2,
        receivedQuantity: 2,
        batchNumber: null,
        expiryDate: null,
        issue: 'none',
      }],
    };
    const parsed = goodsReceiptSchema.parse(payload);
    assert.equal(parsed.orderId, '5a8b4ac3-236c-41f7-a37b-0132b7892637');
    assert.equal(parsed.items?.[0]?.receivedQuantity, 2);
  });

  it('accepts compact order ids used by migrated SQL records', () => {
    const parsed = goodsReceiptSchema.parse({
      orderId: '93eea6883a394b1db998e43cc16acf4b',
      items: [{ productId: 'pack-1', receivedQuantity: 1 }],
    });
    assert.equal(parsed.orderId, '93eea6883a394b1db998e43cc16acf4b');
  });

  it('uses the prescription sub-order that owns the Curaleaf shipment', () => {
    const selected = curaleafScopeForShipment({
      curaleaf: { purchaseOrderId: 'legacy-order-level-po', shipmentIds: [] },
      curaleafSubOrders: {
        'rx-a': { purchaseOrderId: 'po-a', shipments: [{ id: 'ship-a' }] },
        'rx-b': { purchaseOrderId: 'po-b', shipments: [{ id: 'ship-b' }] },
      },
    }, 'ship-b');
    assert.equal(selected.rxKey, 'rx-b');
    assert.equal(selected.curaleaf.purchaseOrderId, 'po-b');
  });
});

/**
 * Goods-in is a regulated record, not a convenience. The route used to skip the receipt
 * entirely when no SQL shipment row existed, swallow any write failure, invent a
 * `gr-<timestamp>` id and still answer 201 -- so the pharmacy booked stock in believing
 * it was recorded while nothing captured who received it.
 */
describe('goods-in never books stock in without an audit record', () => {
  it('returns the persisted receipt id when the record was written', () => {
    assert.equal(
      assertGoodsReceiptRecorded({ shipmentId: 'shipment-1', receiptId: 'receipt-1' }),
      'receipt-1',
    );
  });

  it('refuses the check-in when the consignment has no shipment row to hang the receipt on', () => {
    assert.throws(
      () => assertGoodsReceiptRecorded({ shipmentId: null, receiptId: 'receipt-1' }),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.statusCode, 409);
        assert.equal(error.code, 'SHIPMENT_NOT_LINKED');
        return true;
      },
    );
  });

  it('refuses the check-in when the receipt could not be persisted', () => {
    assert.throws(
      () => assertGoodsReceiptRecorded({ shipmentId: 'shipment-1', receiptId: null }),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.statusCode, 503);
        assert.equal(error.code, 'GOODS_RECEIPT_NOT_RECORDED');
        return true;
      },
    );
  });

  it('never invents an id to stand in for a missing record', () => {
    // The old fallback shape. If this ever passes again, the audit gap is back.
    for (const receiptId of [null, undefined, '']) {
      assert.throws(() => assertGoodsReceiptRecorded({ shipmentId: 'shipment-1', receiptId }), HttpError);
    }
  });

  it('records a short delivery as PARTIAL so the receipt matches what arrived', () => {
    assert.equal(goodsReceiptStatus([{ productId: 'p1', expectedQuantity: 2, receivedQuantity: 2 }] as never), 'COMPLETE');
    assert.equal(goodsReceiptStatus([{ productId: 'p1', expectedQuantity: 2, receivedQuantity: 1 }] as never), 'PARTIAL');
    // One short line is enough to make the whole receipt partial.
    assert.equal(goodsReceiptStatus([
      { productId: 'p1', expectedQuantity: 2, receivedQuantity: 2 },
      { productId: 'p2', expectedQuantity: 3, receivedQuantity: 1 },
    ] as never), 'PARTIAL');
    // No expected count means the received count is the expectation.
    assert.equal(goodsReceiptStatus([{ productId: 'p1', receivedQuantity: 1 }] as never), 'COMPLETE');
  });
});
