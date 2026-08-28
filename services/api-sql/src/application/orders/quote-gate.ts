import { createHash } from 'node:crypto';
import type { QuoteCheckPhase, QuoteCheckRecord, QuoteCheckStatus } from '../../repositories/ports/payment.port.js';
import {
  compareQuotes,
  parseQuote,
  patientQuoteTotalPence,
  quoteFingerprint,
  quoteReviewType,
  type ParsedQuote,
} from './quote-review.js';

export type QuoteBasketLine = { packId: string; quantity: number };

export function normaliseQuoteBasket(lines: QuoteBasketLine[]) {
  const combined = new Map<string, number>();
  for (const line of lines) {
    const packId = String(line.packId || '').trim();
    const quantity = Math.trunc(Number(line.quantity));
    if (!packId || quantity <= 0) continue;
    combined.set(packId, (combined.get(packId) ?? 0) + quantity);
  }
  return [...combined.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([packId, quantity]) => ({ packId, quantity }));
}

export function quoteBasketFingerprint(lines: QuoteBasketLine[]) {
  return createHash('sha256').update(JSON.stringify(normaliseQuoteBasket(lines))).digest('hex');
}

export function quoteWholesaleTotalPence(quote: ParsedQuote) {
  return quote.items.reduce((total, item) => total + item.wholesalePence * item.quantity, 0) + quote.shippingPence;
}

export const CURRENT_PRICING_POLICY_VERSION = 2;

export function quotePaymentTotalPence(
  quote: ParsedQuote,
  dispensingFeePence: number,
  pharmacyDeliveryPence = 0,
  includeCuraleafDeliveryInPatientTotal = false,
) {
  return patientQuoteTotalPence(quote)
    + (includeCuraleafDeliveryInPatientTotal ? quote.shippingPence : 0)
    + Math.max(0, Math.round(dispensingFeePence))
    + Math.max(0, Math.round(pharmacyDeliveryPence));
}

export function quotePricingPolicy(snapshot: unknown) {
  const record = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)
    ? snapshot as Record<string, unknown>
    : {};
  const version = Number(record.pricingPolicyVersion || 0);
  return {
    version,
    includeCuraleafDeliveryInPatientTotal: version < CURRENT_PRICING_POLICY_VERSION,
  };
}

export type QuoteGateEvaluation = {
  status: QuoteCheckStatus;
  quote: ParsedQuote;
  quoteFingerprint: string;
  patientTotalPence: number;
  wholesaleTotalPence: number;
  shippingPence: number;
  taxPence: number;
  comparison: Record<string, unknown>;
};

/** Values safe to persist on an order. Every price is derived from the live
 * supplier response; request line prices and request totals are deliberately ignored. */
export function authoritativeQuotePricing(evaluation: QuoteGateEvaluation) {
  const unitPrices = new Map(evaluation.quote.items.map(item => [item.packId, {
    patientPence: item.patientPence,
    wholesalePence: item.wholesalePence,
  }]));
  const medicineTotalPence = evaluation.quote.items.reduce(
    (sum, item) => sum + item.patientPence * item.quantity,
    0,
  );
  return {
    medicineTotalPence,
    deliveryPence: evaluation.shippingPence,
    taxPence: evaluation.taxPence,
    totalPence: evaluation.patientTotalPence,
    unitPrices,
  };
}

export function authoritativeQuoteLineItems<T extends QuoteBasketLine>(
  lines: T[],
  evaluation: QuoteGateEvaluation,
) {
  const prices = authoritativeQuotePricing(evaluation).unitPrices;
  return lines.map(line => ({
    ...line,
    unitPricePence: prices.get(line.packId)?.patientPence ?? 0,
    wholesalePackPricePence: prices.get(line.packId)?.wholesalePence ?? 0,
  }));
}

export function evaluateQuoteGate(input: {
  rawQuote: unknown;
  basket: QuoteBasketLine[];
  baseline?: QuoteCheckRecord | null;
  dispensingFeePence?: number;
  pharmacyDeliveryPence?: number;
  includeCuraleafDeliveryInPatientTotal?: boolean;
}): QuoteGateEvaluation {
  const quote = parseQuote(input.rawQuote);
  if (!quote) throw new Error('Curaleaf returned an invalid quote.');
  const expected = normaliseQuoteBasket(input.basket);
  const actual = normaliseQuoteBasket(quote.items);
  const basketFingerprint = quoteBasketFingerprint(expected);
  const actualFingerprint = quoteBasketFingerprint(actual);
  const fingerprint = quoteFingerprint(quote);
  const patientTotalPence = quotePaymentTotalPence(
    quote,
    input.dispensingFeePence ?? 0,
    input.pharmacyDeliveryPence ?? 0,
    input.includeCuraleafDeliveryInPatientTotal ?? false,
  );
  const base = {
    quote,
    quoteFingerprint: fingerprint,
    patientTotalPence,
    wholesaleTotalPence: quoteWholesaleTotalPence(quote),
    shippingPence: quote.shippingPence,
    taxPence: 0,
  };
  if (!expected.length || basketFingerprint !== actualFingerprint) {
    return {
      ...base,
      status: 'RECONCILIATION_REQUIRED',
      comparison: { reason: 'quote_basket_mismatch', expected, actual },
    };
  }
  if (quote.items.some(item => !item.inStock || item.stockStatus === 'out_of_stock')) {
    return { ...base, status: 'OUT_OF_STOCK', comparison: { reason: 'out_of_stock' } };
  }
  if (!input.baseline) {
    return { ...base, status: 'MATCHED', comparison: { reason: 'baseline_created' } };
  }
  if (input.baseline.basketFingerprint !== basketFingerprint) {
    return {
      ...base,
      status: 'RECONCILIATION_REQUIRED',
      comparison: { reason: 'payment_basket_changed', baselineBasketFingerprint: input.baseline.basketFingerprint, basketFingerprint },
    };
  }
  const baselineQuote = parseQuote(input.baseline.rawQuote);
  if (!baselineQuote) {
    return { ...base, status: 'RECONCILIATION_REQUIRED', comparison: { reason: 'baseline_quote_invalid' } };
  }
  const differences = compareQuotes(baselineQuote, quote);
  const type = quoteReviewType(quote, differences);
  if (!type && input.baseline.quoteFingerprint === fingerprint) {
    return { ...base, status: 'MATCHED', comparison: { reason: 'quote_unchanged', differences: [] } };
  }
  return {
    ...base,
    status: 'REVIEW_REQUIRED',
    comparison: {
      reason: 'quote_changed',
      type: type ?? 'quote_changed',
      differences,
      patientDeltaPence: patientTotalPence - Number(input.baseline.patientTotalPence),
      wholesaleDeltaPence: quoteWholesaleTotalPence(quote) - Number(input.baseline.wholesaleTotalPence),
    },
  };
}

export function quoteCheckInput(input: {
  organisationId: string;
  orderId: string;
  paymentId?: string | null;
  phase: QuoteCheckPhase;
  basket: QuoteBasketLine[];
  rawQuote: unknown;
  baseline?: QuoteCheckRecord | null;
  dispensingFeePence?: number;
  pharmacyDeliveryPence?: number;
  includeCuraleafDeliveryInPatientTotal?: boolean;
}) {
  const evaluated = evaluateQuoteGate(input);
  return {
    organisationId: input.organisationId,
    orderId: input.orderId,
    paymentId: input.paymentId ?? null,
    phase: input.phase,
    status: evaluated.status,
    baselineQuoteCheckId: input.baseline?.id ?? null,
    basketFingerprint: quoteBasketFingerprint(input.basket),
    quoteFingerprint: evaluated.quoteFingerprint,
    patientTotalPence: evaluated.patientTotalPence,
    wholesaleTotalPence: evaluated.wholesaleTotalPence,
    shippingPence: evaluated.shippingPence,
    taxPence: evaluated.taxPence,
    rawQuote: input.rawQuote,
    comparison: evaluated.comparison,
    decidedByUid: null,
  };
}

export function quoteGateAllowsPayment(check: Pick<QuoteCheckRecord, 'phase' | 'status'>) {
  return check.phase === 'PRE_PAYMENT' && check.status === 'MATCHED';
}

export function quoteGateAllowsPlacement(check: Pick<QuoteCheckRecord, 'phase' | 'status'>) {
  return ['POST_PAYMENT', 'FINAL_PLACEMENT', 'REPLACEMENT'].includes(check.phase)
    && ['MATCHED', 'ABSORBED'].includes(check.status);
}
