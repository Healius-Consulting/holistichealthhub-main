import type { PatientOrder } from '../context/AppContext';
import {
  orderCancellationResolution,
  orderHasInTransitPacks,
  orderHasPartialCollection,
  orderHasPartialCuraleafDispense,
  orderHasPartialPharmacyReceipt,
  orderHasUncollectedReceivedPacks,
  orderIsSplitFulfilment,
  orderSplitPackSnapshot,
  type OrderStage,
} from './orderStage.ts';

/** The board only ever needs the order and the stage already resolved for it. */
export interface OrderLaneInput {
  order: PatientOrder;
  stage: OrderStage;
}

export function quoteReviewIsOpen(order: PatientOrder) {
  return ['required', 'awaiting_top_up', 'awaiting_refund'].includes(order.quoteReview?.status ?? '')
    || ['CHANGED', 'OUT_OF_STOCK', 'RECONCILIATION_REQUIRED'].includes(order.activeQuoteCheck?.status ?? '');
}

/**
 * Exceptions only. Awaiting payment is routine chasing, not an exception, so it
 * gets its own lane instead of being buried in "needs action" with rejections and
 * cancellations — that mix is what made the old board unreadable.
 */
export function recordActionException(record: OrderLaneInput) {
  return orderCancellationResolution(record.order) === 'needs-action'
    || quoteReviewIsOpen(record.order)
    || record.stage === 'rejected';
}

export function recordAwaitingPayment(record: OrderLaneInput) {
  return !recordActionException(record) && record.stage === 'awaiting-payment';
}

/** Anything a human has to pick up: an exception, or a payment still to land. */
export function recordNeedsAction(record: OrderLaneInput) {
  return recordActionException(record) || recordAwaitingPayment(record);
}

export function recordReadyToCollect(record: OrderLaneInput) {
  return !recordNeedsAction(record) && (record.stage === 'ready' || record.stage === 'delivered');
}

export type OrderBoardLane =
  | 'needs-action'
  | 'awaiting-payment'
  | 'curaleaf'
  | 'split'
  | 'ready';

/**
 * Left-to-right reading order of the live board. Lanes with no records are not
 * rendered, so this is the maximum set rather than what is always on screen.
 */
export const ORDER_BOARD_LANES: Array<{ key: OrderBoardLane; label: string; detail: string }> = [
  { key: 'needs-action', label: 'Needs action', detail: 'Exceptions, quote reviews and cancellations' },
  { key: 'awaiting-payment', label: 'Awaiting payment', detail: 'Payment link is with the patient' },
  { key: 'curaleaf', label: 'With Curaleaf', detail: 'Placement, prescription check, dispensing and transit' },
  { key: 'split', label: 'Split delivery', detail: 'Arriving in more than one consignment' },
  { key: 'ready', label: 'Ready to collect', detail: 'Verified and waiting for the patient' },
];

/**
 * Exactly one lane per live order — no record can fall between buckets and vanish.
 * Precedence, highest first:
 *
 *   1. needs-action   — an exception outranks wherever the packs happen to be.
 *   2. awaiting-payment — no money, no pipeline position worth showing.
 *   3. ready          — if any pack can be handed over now, the order belongs in the
 *                       handout queue even when the rest of it is still split. The
 *                       split state is not lost: the card carries the stage-aware tag.
 *   4. split          — takes precedence over with-Curaleaf and checked-in, because
 *                       "half of it is here" is the fact staff act on, not the stage of
 *                       whichever half moved last.
 *   5. goods-in / curaleaf — plain stage buckets. Placement and dispensing sit in one
 *                       lane: from the counter they are the same wait, and splitting
 *                       them cost a whole column that the board has to scroll past.
 *
 * The default is `curaleaf`: a live order with no other signal is paid and sitting with
 * the supplier, which is exactly what that lane means.
 */
export function orderBoardLane(record: OrderLaneInput): OrderBoardLane {
  if (recordActionException(record)) return 'needs-action';
  if (record.stage === 'awaiting-payment') return 'awaiting-payment';
  if (record.stage === 'ready' || record.stage === 'delivered') return 'ready';
  if (orderIsSplitFulfilment(record.order)) return 'split';
  return 'curaleaf';
}

/**
 * Sub-sections inside a lane. A lane answers "how urgent is this?"; a section answers
 * "what exactly is it?" — "Needs action" is really five different jobs, and "With
 * Curaleaf" is four different waits. Without sections a busy lane is an undifferentiated
 * pile that a card tag has to re-explain on every single row.
 *
 * Total function: every record in a lane lands in exactly one section, so sectioning
 * can never drop a card the lane partition already placed.
 */
export interface OrderBoardSection {
  key: string;
  label: string;
  /** Display order within the lane. Actionable sections come first. */
  rank: number;
}

/*
 * Split sections answer the only question the counter has about a split order: is any
 * of it physically here? Where the remainder sits is a moving target and belongs on the
 * card tag ("1/2 in transit"), not in a heading that would go stale row by row.
 */
const SPLIT_SECTIONS = {
  atPharmacy: { key: 'split-here', label: 'Part here to hand over', rank: 0 },
  collected: { key: 'split-collected', label: 'Part already collected', rank: 1 },
  inbound: { key: 'split-inbound', label: 'None arrived yet', rank: 2 },
} as const;

const CURALEAF_SECTIONS: Partial<Record<OrderStage, OrderBoardSection>> = {
  paid: { key: 'to-send', label: 'To send', rank: 0 },
  'curaleaf-pending': { key: 'rx-check', label: 'Prescription check', rank: 1 },
  'curaleaf-approved': { key: 'preparing', label: 'Being prepared', rank: 2 },
  dispatched: { key: 'in-transit', label: 'In transit', rank: 3 },
};

/**
 * `actionLabel` is the card's own resolved status (Refund due, Cancellation pending, Quote
 * review …). It is the natural section for the exceptions lane, where the kind of
 * follow-up is the only thing that distinguishes one card from the next.
 */
export function orderBoardSection(record: OrderLaneInput, lane: OrderBoardLane, actionLabel: string): OrderBoardSection {
  if (lane === 'needs-action') {
    // The lane is already sorted by `orderRecordPriority`, so first-seen is most urgent.
    return { key: orderBoardSlug(actionLabel), label: actionLabel, rank: 0 };
  }
  if (lane === 'curaleaf') {
    return CURALEAF_SECTIONS[record.stage] ?? { key: 'with-supplier', label: 'With Curaleaf', rank: 4 };
  }
  if (lane === 'split') {
    const split = orderSplitPackSnapshot(record.order);
    if (split.atPharmacy > 0) return SPLIT_SECTIONS.atPharmacy;
    if (split.collected > 0) return SPLIT_SECTIONS.collected;
    return SPLIT_SECTIONS.inbound;
  }
  const meta = ORDER_BOARD_LANES.find(entry => entry.key === lane);
  return { key: lane, label: meta?.label ?? lane, rank: 0 };
}

/** Reading order inside a lane: earliest pipeline position first. */
const LANE_STAGE_ORDER: OrderStage[] = ['awaiting-payment', 'paid', 'curaleaf-pending', 'curaleaf-approved', 'dispatched', 'delivered', 'ready'];

export function orderLaneRank(record: OrderLaneInput) {
  const rank = LANE_STAGE_ORDER.indexOf(record.stage);
  return rank === -1 ? LANE_STAGE_ORDER.length : rank;
}

/**
 * Card-facing stage copy. Lane headers may name the supplier; a card should read as
 * pharmacy work ("Being prepared"), not as a vendor's internal queue name.
 */
const CARD_STAGE_LABELS: Partial<Record<OrderStage, string>> = {
  'awaiting-payment': 'Awaiting payment',
  paid: 'Ready to send',
  'curaleaf-pending': 'Prescription check',
  'curaleaf-approved': 'Being prepared',
  dispatched: 'In transit',
  delivered: 'Checked in',
  ready: 'Ready to collect',
  collected: 'Collected',
  rejected: 'Prescription issue',
  archived: 'Archived',
  cancelled: 'Cancelled',
};

export function orderCardStageLabel(stage: OrderStage, fallback: string) {
  return CARD_STAGE_LABELS[stage] ?? fallback;
}

/**
 * Card-only shortenings, applied last. A lane card gives a tag roughly 100px, and the
 * board reads as a mess when half the tags wrap to two lines and the casing switches
 * between Title Case and sentence case mid-column. The record dialog keeps the long
 * form, so nothing here loses meaning — it just stops shouting on the board.
 */
const CARD_TAG_SHORTENINGS: Record<string, string> = {
  'Prescription check': 'Rx check',
  'Prescription issue': 'Rx issue',
  'Ready to send': 'To send',
  'Being prepared': 'Preparing',
  'Quote Review': 'Quote review',
  'Refund Due': 'Refund due',
  'Stock Hold': 'Stock hold',
  'Needs Action': 'Needs action',
  'Reconciliation': 'Reconcile',
  'Cancelled Purchase Order': 'PO cancelled',
};

/** Shared slug so a section key and a card tag can be compared without string luck. */
export function orderBoardSlug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function orderCardTagLabel(label: string) {
  return CARD_TAG_SHORTENINGS[label] ?? label;
}

/**
 * One string that answers "where is this order?" for a split fulfilment, replacing the
 * old "Split 2/10" badge plus a stage-blind "Split Dispensed" pill. Counts are packs.
 */
export function orderSplitCardLabel(record: OrderLaneInput): string | null {
  const { order, stage } = record;
  if (!orderIsSplitFulfilment(order)) return null;
  const split = orderSplitPackSnapshot(order);
  const total = split.total;

  // One idiom: a fraction plus the noun for the stage those packs reached. That is
  // what the old "Split 0/10" badge was missing — the fraction never said of what —
  // and it stays short enough to sit on one line in a lane card. The transit-versus-
  // awaiting-dispatch breakdown lives in the tooltip and the record dialog.
  if (stage === 'ready' && split.atPharmacy > 0) return `${split.atPharmacy}/${total} ready`;
  if (split.atPharmacy > 0) return `${split.atPharmacy}/${total} checked in`;
  if (split.collected > 0 && split.collected < total) return `${split.collected}/${total} collected`;
  if (split.inTransit > 0) return `${split.inTransit}/${total} in transit`;
  if (split.dispensedAtCuraleaf > 0 && split.awaitingDispense > 0) return `${split.dispensedAtCuraleaf}/${total} prepared`;
  return 'Split delivery';
}

/** Long form for the card tooltip and the accessible name; the pill stays short. */
export function orderSplitCardDescription(order: PatientOrder): string | null {
  if (!orderIsSplitFulfilment(order)) return null;
  const split = orderSplitPackSnapshot(order);
  if (orderHasUncollectedReceivedPacks(order)) {
    return `${split.atPharmacy} pack(s) checked in · ${split.withCuraleaf + split.inTransit} still in transit or awaiting dispatch`;
  }
  if (orderHasPartialCollection(order) && !orderHasInTransitPacks(order)) {
    return 'Arrived packs collected; remainder awaiting dispatch';
  }
  if (orderHasPartialPharmacyReceipt(order) && !orderHasInTransitPacks(order)) {
    return 'First consignment checked in; remainder awaiting dispatch';
  }
  if (orderHasInTransitPacks(order)) {
    return split.withCuraleaf > 0
      ? `${split.inTransit} of ${split.total} packs in transit · ${split.withCuraleaf} awaiting dispatch`
      : `${split.inTransit} of ${split.total} packs with courier`;
  }
  if (orderHasPartialCuraleafDispense(order)) {
    return `${split.dispensedAtCuraleaf} of ${split.total} packs dispensed at Curaleaf · ${split.awaitingDispense} awaiting dispense`;
  }
  if (split.withCuraleaf > 0) return `${split.withCuraleaf} pack(s) awaiting dispatch after the first consignment`;
  return null;
}
