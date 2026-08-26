import { createHash } from 'node:crypto';
import { curaleafMoneyPence } from '../../domain/integrations/curaleaf-money.js';

export type QuoteDifferenceCategory = 'stock' | 'patient_price' | 'supplier_cost';

export type QuoteDifference = {
  category: QuoteDifferenceCategory;
  field: string;
  packId?: string;
  previous: string | boolean;
  latest: string | boolean;
};

export type QuoteReviewType = 'out_of_stock' | 'patient_price_changed' | 'supplier_cost_changed';

export type QuoteReviewStatus =
  | 'required'
  | 'approved'
  | 'awaiting_top_up'
  | 'awaiting_refund'
  | 'recreate_required';

export type ParsedQuoteItem = {
  packId: string;
  quantity: number;
  inStock: boolean;
  stockStatus: 'in_stock' | 'low_stock' | 'out_of_stock';
  wholesalePence: number;
  patientPence: number;
};

export type ParsedQuote = {
  shippingPence: number;
  taxRate: string;
  items: ParsedQuoteItem[];
};

export type QuoteReviewRecord = {
  status: QuoteReviewStatus;
  type: QuoteReviewType;
  fingerprint: string;
  latestQuote: unknown;
  differences: QuoteDifference[];
  patientDeltaPence: number;
  checkedAt: string;
  approvedAt?: string;
  approvedFingerprint?: string;
  pharmacyContributionPence?: number;
  topUpPaymentId?: string;
  refundId?: string;
  refundAmountPence?: number;
  hostedPaymentUrl?: string;
  baselineQuoteCheckId?: string;
  quoteCheckId?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function moneyPence(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 100);
  return curaleafMoneyPence(value, 'pack price');
}

function penceFrom(pence: unknown, money: unknown, alt?: unknown) {
  if (typeof pence === 'number' && Number.isFinite(pence)) return Math.round(pence);
  if (money != null && money !== '') return moneyPence(money);
  if (alt != null && alt !== '') return moneyPence(alt);
  return 0;
}

function stockStatus(inStock: boolean, status?: unknown): ParsedQuoteItem['stockStatus'] {
  const normalised = String(status || '').toLowerCase();
  if (!inStock || normalised === 'out_of_stock') return 'out_of_stock';
  if (normalised === 'low_stock') return 'low_stock';
  return 'in_stock';
}

function unwrapQuoteRecord(raw: unknown, depth = 0): Record<string, unknown> {
  const record = asRecord(raw);
  if (Array.isArray(record.items) && record.items.length) return record;
  if (depth >= 3) return record;
  for (const key of ['data', 'quote', 'pricingQuote']) {
    const nested = record[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const inner = unwrapQuoteRecord(nested, depth + 1);
      if (Array.isArray(inner.items) && inner.items.length) return inner;
    }
  }
  return record;
}

export function parseQuote(raw: unknown): ParsedQuote | null {
  const record = unwrapQuoteRecord(raw);
  const items = Array.isArray(record.items) ? record.items : [];
  const parsedItems: ParsedQuoteItem[] = [];
  for (const entry of items) {
    const item = asRecord(entry);
    const packId = String(item.packId || item.productId || item.pack_id || item.id || '').trim();
    const quantity = Number(item.quantity || item.qty || item.count || item.packsOrderedCount || 0);
    if (!packId || quantity <= 0) continue;
    const inStock = item.inStock !== false && stockStatus(true, item.stockStatus) !== 'out_of_stock';
    parsedItems.push({
      packId,
      quantity,
      inStock,
      stockStatus: stockStatus(item.inStock !== false, item.stockStatus),
      wholesalePence: penceFrom(item.wholesalePackPricePence, item.wholesalePackPrice, item.wholesalePrice),
      patientPence: penceFrom(item.patientPackPricePence, item.patientPackPrice, item.patientPrice),
    });
  }
  if (!parsedItems.length) return null;
  return {
    shippingPence: penceFrom(record.shippingPence, record.shippingPrice),
    taxRate: String(record.taxRate ?? '0'),
    items: parsedItems,
  };
}

function firstParseableQuote(...candidates: unknown[]): unknown | null {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (parseQuote(candidate)) return candidate;
  }
  return null;
}

export function snapshotQuote(snapshot: unknown): unknown {
  const root = asRecord(snapshot);
  const review = asRecord(root.quoteReview);
  return firstParseableQuote(root.pricingQuote, root.quote, review.latestQuote);
}

export function quoteFingerprint(quote: ParsedQuote) {
  const normalised = {
    shippingPence: quote.shippingPence,
    taxRate: quote.taxRate,
    items: [...quote.items]
      .sort((left, right) => left.packId.localeCompare(right.packId))
      .map(item => ({
        packId: item.packId,
        quantity: item.quantity,
        inStock: item.inStock,
        stockStatus: item.stockStatus,
        wholesalePence: item.wholesalePence,
        patientPence: item.patientPence,
      })),
  };
  return createHash('sha256').update(JSON.stringify(normalised)).digest('hex');
}

export function compareQuotes(baseline: ParsedQuote, latest: ParsedQuote): QuoteDifference[] {
  const differences: QuoteDifference[] = [];
  const priorItems = new Map(baseline.items.map(item => [item.packId, item]));
  for (const item of latest.items) {
    const earlier = priorItems.get(item.packId);
    if (!earlier) continue;
    if (item.inStock !== earlier.inStock || item.stockStatus !== earlier.stockStatus) {
      differences.push({
        category: 'stock',
        field: 'inStock',
        packId: item.packId,
        previous: earlier.inStock,
        latest: item.inStock,
      });
    }
    if (item.patientPence !== earlier.patientPence) {
      differences.push({
        category: 'patient_price',
        field: 'patientPackPrice',
        packId: item.packId,
        previous: String(earlier.patientPence),
        latest: String(item.patientPence),
      });
    }
    if (item.wholesalePence !== earlier.wholesalePence) {
      differences.push({
        category: 'supplier_cost',
        field: 'wholesalePackPrice',
        packId: item.packId,
        previous: String(earlier.wholesalePence),
        latest: String(item.wholesalePence),
      });
    }
  }
  if (baseline.shippingPence !== latest.shippingPence) {
    differences.push({
      category: 'supplier_cost',
      field: 'shippingPrice',
      previous: String(baseline.shippingPence),
      latest: String(latest.shippingPence),
    });
  }
  return differences;
}

export function patientQuoteTotalPence(quote: ParsedQuote) {
  return quote.items.reduce((total, item) => total + item.patientPence * item.quantity, 0);
}

export function quoteReviewType(latest: ParsedQuote, differences: QuoteDifference[]): QuoteReviewType | null {
  if (latest.items.some(item => !item.inStock || item.stockStatus === 'out_of_stock')) return 'out_of_stock';
  if (differences.some(item => item.category === 'patient_price')) return 'patient_price_changed';
  if (differences.some(item => item.category === 'supplier_cost' || item.category === 'stock')) return 'supplier_cost_changed';
  return null;
}

export function readQuoteReview(snapshot: unknown): QuoteReviewRecord | null {
  const review = asRecord(asRecord(snapshot).quoteReview);
  if (!review.status || !review.type || !review.fingerprint) return null;
  return review as QuoteReviewRecord;
}

export function isQuoteReviewBlocking(snapshot: unknown) {
  const review = readQuoteReview(snapshot);
  return review?.status === 'required'
    || review?.status === 'awaiting_top_up'
    || review?.status === 'awaiting_refund'
    || review?.status === 'recreate_required';
}

export function quoteReviewAllowsPlacement(snapshot: unknown, latestFingerprint: string) {
  const review = readQuoteReview(snapshot);
  if (!review) return true;
  if (review.status === 'awaiting_top_up' || review.status === 'awaiting_refund' || review.status === 'required' || review.status === 'recreate_required') {
    return false;
  }
  return review.status === 'approved' && review.approvedFingerprint === latestFingerprint;
}

export function evaluateQuoteReview(input: {
  snapshot: unknown;
  latestRaw: unknown;
  now?: string;
}): { hold: false; fingerprint: string; latest: ParsedQuote; adoptedBaseline: boolean } | {
  hold: true;
  fingerprint: string;
  latest: ParsedQuote;
  review: QuoteReviewRecord;
} {
  const latest = parseQuote(input.latestRaw);
  if (!latest) {
    throw new Error('Curaleaf returned an invalid quote.');
  }
  const fingerprint = quoteFingerprint(latest);
  const existing = readQuoteReview(input.snapshot);
  if (existing?.status === 'approved' && existing.approvedFingerprint === fingerprint) {
    return { hold: false, fingerprint, latest, adoptedBaseline: false };
  }
  const baseline = parseQuote(snapshotQuote(input.snapshot));
  if (!baseline) {
    return {
      hold: true,
      fingerprint,
      latest,
      review: {
        status: 'recreate_required',
        type: 'patient_price_changed',
        fingerprint,
        latestQuote: input.latestRaw,
        differences: [{
          category: 'patient_price',
          field: 'missingPaidBaseline',
          previous: 'missing',
          latest: 'present',
        }],
        patientDeltaPence: 0,
        checkedAt: input.now ?? new Date().toISOString(),
      },
    };
  }
  const differences = compareQuotes(baseline, latest);
  const type = quoteReviewType(latest, differences);
  if (!type) return { hold: false, fingerprint, latest, adoptedBaseline: false };
  const patientDeltaPence = patientQuoteTotalPence(latest) - patientQuoteTotalPence(baseline);
  return {
    hold: true,
    fingerprint,
    latest,
    review: {
      status: 'required',
      type,
      fingerprint,
      latestQuote: input.latestRaw,
      differences,
      patientDeltaPence,
      checkedAt: input.now ?? new Date().toISOString(),
    },
  };
}

export function applyPassedQuoteReview(snapshot: unknown, input: {
  latestRaw: unknown;
  fingerprint: string;
  now?: string;
}): { changed: boolean; snapshot: Record<string, unknown> } {
  const root = asRecord(snapshot);
  const existing = readQuoteReview(snapshot);
  const storedQuote = firstParseableQuote(root.pricingQuote, root.quote);
  const adoptedQuote = storedQuote
    ?? firstParseableQuote(asRecord(root.quoteReview).latestQuote, input.latestRaw)
    ?? input.latestRaw;
  const needsBaseline = false;
  const needsRelease = existing?.status === 'required';
  if (!needsBaseline && !needsRelease) {
    return { changed: false, snapshot: root };
  }
  const now = input.now ?? new Date().toISOString();
  return {
    changed: true,
    snapshot: stampQuoteReviewOnSnapshot({
      ...root,
      quote: adoptedQuote,
      pricingQuote: adoptedQuote,
    }, needsRelease && existing ? {
      ...existing,
      status: 'approved',
      fingerprint: input.fingerprint,
      latestQuote: input.latestRaw,
      differences: [],
      checkedAt: now,
      approvedAt: now,
      approvedFingerprint: input.fingerprint,
    } : existing),
  };
}

export function stampQuoteReviewOnSnapshot(snapshot: unknown, review: QuoteReviewRecord | null) {
  const root = asRecord(snapshot);
  const flow = asRecord(root.prescriptionFlow);
  const heldState = review?.type === 'out_of_stock' ? 'HELD_STOCK' : 'HELD_PRICE';
  const nextFlow: Record<string, unknown> = {};
  const blocking = Boolean(review && (review.status === 'required' || review.status === 'awaiting_top_up' || review.status === 'awaiting_refund' || review.status === 'recreate_required'));
  for (const [key, value] of Object.entries(flow)) {
    const prescription = asRecord(value);
    const state = String(prescription.state || '');
    nextFlow[key] = blocking
      ? { ...prescription, state: heldState }
      : (state === 'HELD_PRICE' || state === 'HELD_STOCK')
        ? { ...prescription, state: 'PENDING_PLACEMENT' }
        : prescription;
  }
  const curaleaf = asRecord(root.curaleaf);
  const adoptedQuote = firstParseableQuote(root.pricingQuote, root.quote, review?.latestQuote)
    ?? review?.latestQuote
    ?? root.pricingQuote
    ?? root.quote
    ?? null;
  return {
    ...root,
    quote: adoptedQuote,
    pricingQuote: adoptedQuote,
    quoteReview: review,
    prescriptionFlow: Object.keys(nextFlow).length ? nextFlow : root.prescriptionFlow,
    curaleaf: {
      ...curaleaf,
      status: blocking ? 'quote_review_required' : (curaleaf.status === 'quote_review_required' ? undefined : curaleaf.status),
    },
  };
}

export function supplierPurchaseOrderCancelled(snapshot: unknown) {
  const curaleaf = asRecord(asRecord(snapshot).curaleaf);
  const state = String(curaleaf.purchaseOrderState || curaleaf.state || '').toUpperCase();
  return state === 'CANCELLED';
}

export function supplierPrescriptionCancelled(snapshot: unknown) {
  const curaleaf = asRecord(asRecord(snapshot).curaleaf);
  const state = String(curaleaf.prescriptionState || '').toUpperCase();
  return state === 'CANCELLED';
}

export function supplierOrderCancelled(snapshot: unknown) {
  return supplierPurchaseOrderCancelled(snapshot) || supplierPrescriptionCancelled(snapshot);
}

export function curaleafCancellationBlocksPlacement(snapshot: unknown) {
  if (supplierOrderCancelled(snapshot)) return true;
  const cancellation = asRecord(asRecord(snapshot).curaleafCancellation);
  const orderCancellation = asRecord(asRecord(snapshot).cancellation);
  return ['contact_required', 'awaiting_confirmation', 'confirmed'].includes(String(cancellation.status || ''))
    || ['curaleaf_contact_required', 'awaiting_curaleaf_confirmation', 'refund_required', 'cancelled'].includes(String(orderCancellation.status || ''));
}
