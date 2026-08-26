import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyCancelledPurchaseOrderSnapshot,
  curaleafOwnsCancellation,
  curaleafRequiresSupplierCancel,
  isCuraleafCorrectionRequired,
  isCuraleafPrescriberRejected,
  isCuraleafTerminalRejection,
  orderMatchesCancelledPrescription,
  orderMatchesCancelledPurchaseOrder,
  stampCuraleafCancellationOnSnapshot,
  stampCuraleafAttentionOnSnapshot,
} from '../integrations/curaleaf-events.js';
import { HttpError } from '../../domain/common/errors.js';
import {
  applyPassedQuoteReview,
  compareQuotes,
  curaleafCancellationBlocksPlacement,
  evaluateQuoteReview,
  parseQuote,
  patientQuoteTotalPence,
  quoteFingerprint,
  quoteReviewAllowsPlacement,
  stampQuoteReviewOnSnapshot,
  supplierPurchaseOrderCancelled,
} from './quote-review.js';

const baseline = {
  shippingPrice: '5.00',
  taxRate: '0.2',
  items: [{
    packId: 'pack-a',
    quantity: 1,
    inStock: true,
    wholesalePackPrice: '68.00',
    patientPackPrice: '85.00',
  }],
};

describe('quote review compare', () => {
  it('parses string and pence quote shapes', () => {
    const fromMoney = parseQuote(baseline);
    const fromPence = parseQuote({
      shippingPence: 500,
      taxRate: '0.2',
      items: [{ packId: 'pack-a', quantity: 1, inStock: true, wholesalePackPricePence: 6800, patientPackPricePence: 8500 }],
    });
    assert.equal(fromMoney?.items[0]?.patientPence, 8500);
    assert.equal(fromPence?.items[0]?.patientPence, 8500);
    assert.equal(quoteFingerprint(fromMoney!), quoteFingerprint(fromPence!));
  });

  it('holds out of stock before price differences', () => {
    const latest = { ...baseline, items: [{ ...baseline.items[0]!, inStock: false, patientPackPrice: '90.00' }] };
    const result = evaluateQuoteReview({ snapshot: { quote: baseline }, latestRaw: latest, now: '2026-08-18T20:00:00.000Z' });
    assert.equal(result.hold, true);
    if (result.hold) assert.equal(result.review.type, 'out_of_stock');
  });

  it('detects patient price up and down', () => {
    const up = compareQuotes(parseQuote(baseline)!, parseQuote({ ...baseline, items: [{ ...baseline.items[0]!, patientPackPrice: '90.00' }] })!);
    const down = compareQuotes(parseQuote(baseline)!, parseQuote({ ...baseline, items: [{ ...baseline.items[0]!, patientPackPrice: '80.00' }] })!);
    assert.equal(up[0]?.category, 'patient_price');
    assert.equal(patientQuoteTotalPence(parseQuote({ ...baseline, items: [{ ...baseline.items[0]!, patientPackPrice: '90.00' }] })!) - patientQuoteTotalPence(parseQuote(baseline)!), 500);
    assert.equal(down[0]?.category, 'patient_price');
  });

  it('holds a price increase for absorb and a drop for continue-as-fee', () => {
    const up = evaluateQuoteReview({
      snapshot: { quote: baseline },
      latestRaw: { ...baseline, items: [{ ...baseline.items[0]!, patientPackPrice: '90.00' }] },
    });
    const down = evaluateQuoteReview({
      snapshot: { quote: baseline },
      latestRaw: { ...baseline, items: [{ ...baseline.items[0]!, patientPackPrice: '80.00' }] },
    });
    assert.equal(up.hold, true);
    assert.equal(down.hold, true);
    if (up.hold) {
      assert.equal(up.review.type, 'patient_price_changed');
      assert.equal(up.review.patientDeltaPence, 500);
    }
    if (down.hold) {
      assert.equal(down.review.type, 'patient_price_changed');
      assert.equal(down.review.patientDeltaPence, -500);
    }
  });

  it('holds wholesale-only changes as supplier cost', () => {
    const result = evaluateQuoteReview({
      snapshot: { quote: baseline },
      latestRaw: { ...baseline, items: [{ ...baseline.items[0]!, wholesalePackPrice: '72.00' }] },
    });
    assert.equal(result.hold, true);
    if (result.hold) assert.equal(result.review.type, 'supplier_cost_changed');
  });

  it('does not hold an approved fingerprint again', () => {
    const latest = parseQuote(baseline)!;
    const fingerprint = quoteFingerprint(latest);
    const snapshot = stampQuoteReviewOnSnapshot({ quote: baseline }, {
      status: 'approved',
      type: 'supplier_cost_changed',
      fingerprint,
      latestQuote: baseline,
      differences: [],
      patientDeltaPence: 0,
      checkedAt: '2026-08-18T20:00:00.000Z',
      approvedFingerprint: fingerprint,
    });
    const result = evaluateQuoteReview({ snapshot, latestRaw: baseline });
    assert.equal(result.hold, false);
    assert.equal(quoteReviewAllowsPlacement(snapshot, fingerprint), true);
  });

  it('holds for reconciliation when the paid quote is missing', () => {
    const result = evaluateQuoteReview({ snapshot: { lineItems: [{ packId: 'pack-a', quantity: 1 }] }, latestRaw: baseline });
    assert.equal(result.hold, true);
    if (result.hold) assert.equal(result.review.status, 'recreate_required');
  });

  it('parses nested Curaleaf quote wrappers and uses a stored review quote as baseline', () => {
    const nested = parseQuote({ data: { items: [{ id: 'pack-a', packsOrderedCount: 1, inStock: true, wholesalePackPrice: '68.00', patientPackPrice: '85.00' }], shippingPrice: '5.00', taxRate: '0.2' } });
    assert.equal(nested?.items[0]?.packId, 'pack-a');
    assert.equal(nested?.items[0]?.patientPence, 8500);

    const held = evaluateQuoteReview({
      snapshot: {
        quote: { lineItems: [{ packId: 'pack-a', quantity: 1 }] },
        quoteReview: {
          status: 'required',
          type: 'patient_price_changed',
          fingerprint: 'stale',
          latestQuote: baseline,
          differences: [{ category: 'patient_price', field: 'missingOriginalQuote', previous: 'missing', latest: 'present' }],
          patientDeltaPence: 0,
          checkedAt: '2026-08-18T20:00:00.000Z',
        },
      },
      latestRaw: baseline,
    });
    assert.equal(held.hold, false);

    const passed = applyPassedQuoteReview({
      quote: { lineItems: [{ packId: 'pack-a', quantity: 1 }] },
      quoteReview: {
        status: 'required',
        type: 'patient_price_changed',
        fingerprint: 'stale',
        latestQuote: baseline,
        differences: [{ category: 'patient_price', field: 'missingOriginalQuote', previous: 'missing', latest: 'present' }],
        patientDeltaPence: 0,
        checkedAt: '2026-08-18T20:00:00.000Z',
      },
      prescriptionFlow: { rx1: { state: 'HELD_PRICE' } },
      curaleaf: { status: 'quote_review_required' },
    }, { latestRaw: baseline, fingerprint: quoteFingerprint(parseQuote(baseline)!), now: '2026-08-19T00:00:00.000Z' });
    assert.equal(passed.changed, true);
    const review = passed.snapshot.quoteReview as { status: string; approvedFingerprint: string };
    assert.equal(review.status, 'approved');
    assert.equal((passed.snapshot.prescriptionFlow as { rx1: { state: string } }).rx1.state, 'PENDING_PLACEMENT');
    assert.equal(parseQuote(passed.snapshot.quote)?.items[0]?.packId, 'pack-a');
  });
});

describe('Curaleaf cancelled purchase orders', () => {
  it('matches a cancelled PO by stored id or customer reference', () => {
    const order = {
      id: '8101c39d-2f17-4ed7-b6fc-826fb15c8868',
      orderNumber: 'ORD-MSZ0VH1L',
      quoteSnapshot: { curaleaf: { purchaseOrderId: 'f287b3b8-d83f-478d-a7e6-34f4cc527f86' } },
    };
    assert.equal(orderMatchesCancelledPurchaseOrder(order, {
      id: 'f287b3b8-d83f-478d-a7e6-34f4cc527f86',
      state: 'CANCELLED',
    }), true);
    assert.equal(orderMatchesCancelledPurchaseOrder({
      ...order,
      quoteSnapshot: {},
    }, { id: 'other', customerReference: 'ORD-MSZ0VH1L', state: 'CANCELLED' }), true);
  });

  it('stamps CANCELLED onto the snapshot without clearing payment identity', () => {
    const next = applyCancelledPurchaseOrderSnapshot(
      { curaleaf: { prescriptionId: 'rx-1', purchaseOrderId: 'po-1', status: 'purchase_order_submitted' } },
      { id: 'po-1', state: 'CANCELLED', customerReference: 'ORD-1' },
    );
    const curaleaf = next.curaleaf as Record<string, unknown>;
    assert.equal(curaleaf.purchaseOrderState, 'CANCELLED');
    assert.equal(curaleaf.state, 'CANCELLED');
    assert.equal(curaleaf.prescriptionId, 'rx-1');
    assert.equal(supplierPurchaseOrderCancelled(next), true);
    assert.equal(next.quoteReview, null);
  });

  it('clears an open quote review when Curaleaf cancellation is confirmed after a pharmacy call', () => {
    const next = stampCuraleafCancellationOnSnapshot({
      quoteReview: { status: 'required', type: 'out_of_stock', fingerprint: 'abc', latestQuote: baseline, differences: [], patientDeltaPence: 0, checkedAt: '2026-08-18T20:00:00.000Z' },
      refund: { kind: 'quote_difference', status: 'pending_confirmation', amountPence: 500 },
      curaleaf: { prescriptionId: 'rx-1', purchaseOrderId: 'po-1', status: 'purchase_order_submitted' },
    }, {
      action: 'confirmed',
      purchaseOrderId: 'po-1',
      reference: 'phone_cs_confirmed',
      now: '2026-08-18T21:00:00.000Z',
    });
    assert.equal(next.quoteReview, null);
    assert.equal(next.refund, null);
    assert.equal(supplierPurchaseOrderCancelled(next), true);
    assert.equal((next.cancellation as { status: string }).status, 'refund_required');
    assert.equal((next.curaleafCancellation as { status: string }).status, 'confirmed');
  });

  it('matches a cancelled prescription by stored id', () => {
    assert.equal(orderMatchesCancelledPrescription({
      quoteSnapshot: { curaleaf: { prescriptionId: 'rx-9' } },
    }, { id: 'rx-9' }), true);
    assert.equal(orderMatchesCancelledPrescription({
      quoteSnapshot: { curaleaf: { prescriptionId: 'rx-9' } },
    }, { id: 'rx-other' }), false);
  });

  it('blocks placement while cancellation is in progress or confirmed', () => {
    assert.equal(curaleafCancellationBlocksPlacement({
      cancellation: { status: 'curaleaf_contact_required' },
      curaleaf: { prescriptionId: 'rx-1' },
    }), true);
    assert.equal(curaleafCancellationBlocksPlacement({ quote: baseline }), false);
  });

  it('requires Curaleaf to cancel once the 3-phase placement rail has started', () => {
    assert.equal(curaleafRequiresSupplierCancel({ curaleaf: { prescriptionId: 'rx-1', prescriptionState: 'PENDING' } }), true);
    assert.equal(curaleafRequiresSupplierCancel({ curaleaf: { prescriberId: 'pr-1', prescriberState: 'UNVERIFIED' } }), false);
    assert.equal(curaleafRequiresSupplierCancel({ curaleaf: { prescriptionId: 'rx-1', prescriptionState: 'ACTIVE' } }), true);
    assert.equal(curaleafRequiresSupplierCancel({ curaleaf: { purchaseOrderId: 'po-1', purchaseOrderState: 'CREATED' } }), true);
    assert.equal(curaleafRequiresSupplierCancel({ curaleaf: { prescriptionState: 'CANCELLED', prescriptionId: 'rx-1' } }), false);
    assert.equal(curaleafOwnsCancellation({ curaleaf: { purchaseOrderId: 'po-1', purchaseOrderState: 'CREATED' } }), true);
    assert.equal(curaleafOwnsCancellation({
      quoteReview: { status: 'required' },
      curaleaf: { purchaseOrderId: 'po-1', purchaseOrderState: 'CREATED' },
    }), false);
  });

  it('holds validation failures for correction without inventing cancellation states', () => {
    const correction = stampCuraleafAttentionOnSnapshot({
      quoteReview: { status: 'required' },
      curaleaf: { prescriberId: 'pr-1', prescriptionId: 'rx-1', prescriptionState: 'PENDING' },
    }, {
      source: 'prescription',
      code: 'PRESCRIPTION_CORRECTION_REQUIRED',
      reason: 'Review the prescription.',
      now: '2026-08-18T21:31:00.000Z',
    }) as Record<string, unknown>;
    assert.equal((correction.curaleaf as { prescriptionState: string }).prescriptionState, 'PENDING');
    assert.equal((correction.curaleafAttention as { status: string }).status, 'correction_required');
    assert.equal(correction.cancellation, undefined);
  });

  it('treats Curaleaf 400/422 as correction holds and leaves auth/5xx/429 outside that classification', () => {
    assert.equal(isCuraleafCorrectionRequired(new HttpError(400, 'invalid', 'CURALEAF_REQUEST_FAILED', { curaleafStatus: 400 })), true);
    assert.equal(isCuraleafCorrectionRequired(new HttpError(422, 'invalid', 'CURALEAF_REQUEST_FAILED', { curaleafStatus: 422 })), true);
    assert.equal(isCuraleafCorrectionRequired(new HttpError(403, 'forbidden', 'CURALEAF_REQUEST_FAILED', { curaleafStatus: 403 })), false);
    assert.equal(isCuraleafCorrectionRequired(new HttpError(502, 'unavailable', 'CURALEAF_REQUEST_FAILED', { curaleafStatus: 502 })), false);
    assert.equal(isCuraleafCorrectionRequired(new HttpError(429, 'limited', 'CURALEAF_REQUEST_FAILED')), false);
  });

  it('recognises only documented Curaleaf terminal states', () => {
    assert.equal(isCuraleafTerminalRejection('CANCELLED'), true);
    assert.equal(isCuraleafTerminalRejection('REJECTED'), false);
    assert.equal(isCuraleafPrescriberRejected('ARCHIVED'), true);
    assert.equal(isCuraleafPrescriberRejected('REJECTED'), false);
    assert.equal(supplierPurchaseOrderCancelled({ curaleaf: { purchaseOrderState: 'REJECTED' } }), false);
  });
});
