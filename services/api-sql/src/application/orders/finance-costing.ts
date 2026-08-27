import { parseQuote, type ParsedQuote } from './quote-review.js';

/**
 * Where a row's wholesale figure came from. Finance must never blur these:
 * a frozen paid quote is what this pharmacy actually paid Curaleaf, a payment-gate
 * total is the same paid figure without per-pack detail, and a quote-bank estimate
 * is today's catalogue price standing in for a quote nobody froze at the time.
 */
export type WholesaleCostBasis = 'paid_quote' | 'paid_quote_totals' | 'quote_bank';

export interface QuotedCost {
  wholesaleComplete: boolean;
  /** null when no honest source could be found — the row stays "awaiting quote". */
  costBasis: WholesaleCostBasis | null;
  /** False for quote-bank estimates: the bank prices packs, it does not price delivery. */
  shippingKnown: boolean;
  wholesaleProductPence: number | null;
  shippingPence: number | null;
  wholesalePence: number | null;
  prices: Map<string, number>;
}

export interface QuotedCostOptions {
  /**
   * Wholesale pack price by Curaleaf pack id from the shared quote bank. Used only
   * when no paid quote was ever frozen onto the order.
   */
  bankWholesalePenceByPackId?: ReadonlyMap<string, number>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

/** Paid Curaleaf quote stored on the order. Never a later live recheck. */
export function paidQuoteFromSnapshot(snapshot: unknown): ParsedQuote | null {
  const root = asRecord(snapshot);
  const curaleaf = asRecord(root.curaleaf);
  for (const candidate of [root.pricingQuote, root.quote, curaleaf.quote]) {
    const parsed = parseQuote(candidate);
    if (parsed && parsed.items.some(item => item.wholesalePence > 0)) return parsed;
  }
  return null;
}

/**
 * Basket lines as recorded on the snapshot. Shapes differ by vintage, so accept
 * every one the finance router already reads rather than a single canonical key.
 */
export function snapshotBasketLines(snapshot: unknown): Array<{ packId: string; quantity: number }> {
  const root = asRecord(snapshot);
  const prescriptionItems = Array.isArray(root.prescriptions)
    ? root.prescriptions.flatMap(entry => {
      const items = asRecord(entry).items;
      return Array.isArray(items) ? items : [];
    })
    : [];
  const rawLines = Array.isArray(root.lineItems)
    ? root.lineItems
    : Array.isArray(root.items)
      ? root.items
      : prescriptionItems;

  const lines: Array<{ packId: string; quantity: number }> = [];
  for (const entry of rawLines) {
    const item = asRecord(entry);
    const packId = String(item.packId || item.productId || item.pack_id || item.id || '').trim();
    if (!packId) continue;
    const quantity = Number(item.quantity ?? item.qty ?? 1);
    lines.push({ packId, quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1 });
  }
  return lines;
}

/**
 * Aggregate wholesale recorded by the payment quote gate. This is still the paid
 * Curaleaf figure — it just has no per-pack breakdown — so it outranks the bank.
 */
function paidGateTotals(snapshot: unknown): { wholesaleProductPence: number; shippingPence: number } | null {
  const gate = asRecord(asRecord(snapshot).paymentQuote);
  const wholesaleTotalPence = positiveInteger(gate.wholesaleTotalPence);
  if (wholesaleTotalPence === null) return null;
  const shippingPence = Number(gate.shippingPence);
  const shipping = Number.isFinite(shippingPence) && shippingPence >= 0 ? Math.round(shippingPence) : 0;
  // The gate total already includes delivery; keep product and shipping separable.
  return {
    wholesaleProductPence: Math.max(0, wholesaleTotalPence - shipping),
    shippingPence: shipping,
  };
}

const AWAITING_QUOTE: QuotedCost = {
  wholesaleComplete: false,
  costBasis: null,
  shippingKnown: false,
  wholesaleProductPence: null,
  shippingPence: null,
  wholesalePence: null,
  prices: new Map<string, number>(),
};

export function quotedCostFromSnapshot(snapshot: unknown, options?: QuotedCostOptions): QuotedCost {
  const quote = paidQuoteFromSnapshot(snapshot);
  if (quote) {
    const wholesaleProductPence = quote.items.reduce((sum, item) => sum + item.wholesalePence * item.quantity, 0);
    return {
      wholesaleComplete: true,
      costBasis: 'paid_quote',
      shippingKnown: true,
      wholesaleProductPence,
      shippingPence: quote.shippingPence,
      wholesalePence: wholesaleProductPence + quote.shippingPence,
      prices: new Map(quote.items.map(item => [item.packId, item.wholesalePence])),
    };
  }

  const gate = paidGateTotals(snapshot);
  if (gate) {
    return {
      wholesaleComplete: true,
      costBasis: 'paid_quote_totals',
      shippingKnown: true,
      wholesaleProductPence: gate.wholesaleProductPence,
      shippingPence: gate.shippingPence,
      wholesalePence: gate.wholesaleProductPence + gate.shippingPence,
      // No per-pack detail exists in the gate record, so line margins stay unknown.
      prices: new Map<string, number>(),
    };
  }

  const bank = options?.bankWholesalePenceByPackId;
  if (!bank || bank.size === 0) return { ...AWAITING_QUOTE, prices: new Map<string, number>() };

  const lines = snapshotBasketLines(snapshot);
  // A partial bank match would silently understate cost, so all or nothing.
  if (!lines.length || !lines.every(line => bank.has(line.packId))) {
    return { ...AWAITING_QUOTE, prices: new Map<string, number>() };
  }

  const wholesaleProductPence = lines.reduce((sum, line) => sum + bank.get(line.packId)! * line.quantity, 0);
  return {
    wholesaleComplete: true,
    costBasis: 'quote_bank',
    // The bank prices packs only. Inventing a delivery charge would be exactly the
    // kind of made-up cost this module exists to refuse.
    shippingKnown: false,
    wholesaleProductPence,
    shippingPence: null,
    wholesalePence: wholesaleProductPence,
    prices: new Map(lines.map(line => [line.packId, bank.get(line.packId)!])),
  };
}

/**
 * Freeze the paid Curaleaf quote onto the snapshot when nothing froze it earlier.
 * Never overwrites an existing paid quote: the first freeze is the authoritative one.
 */
export function stampPaidQuoteOnSnapshot(snapshot: unknown, rawQuote: unknown): Record<string, unknown> {
  const root = asRecord(snapshot);
  if (paidQuoteFromSnapshot(root)) return root;
  const parsed = parseQuote(rawQuote);
  if (!parsed || !parsed.items.some(item => item.wholesalePence > 0)) return root;
  return { ...root, pricingQuote: rawQuote, quote: rawQuote };
}
