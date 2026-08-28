/**
 * Staff-facing money vocabulary, in one place.
 *
 * Pharmacy and admin staff read the same commercial figures on the create-order
 * rail, the checkout ledger, the order fulfilment cards, the formulary and the
 * patient record. They only reconcile if every surface names and formats them
 * identically, so the labels and the margin format live here rather than being
 * retyped per screen.
 *
 * Curaleaf's own tax on what the pharmacy buys is deliberately absent: it is a
 * supplier-side figure that staff cannot act on, and showing it next to the
 * patient's price invited the reading that the patient was being taxed.
 */

/** Supplier cost. Always qualified, because the quoted figure excludes VAT. */
export const WHOLESALE_LABEL = 'Wholesale (excl. VAT)';

/**
 * Compact label for narrow columns (picker rows, rail line economics). Pair with
 * `title={WHOLESALE_LABEL}` / sr-only so the excl.-VAT meaning is not lost.
 */
export const WHOLESALE_LABEL_SHORT = 'Wholesale';

/** The patient's medicines subtotal, before the dispensing charge. */
export const PATIENT_PRICE_LABEL = 'Patient price';

/** Quiet section heading above wholesale + delivery (Curaleaf cost to the pharmacy). */
export const PHARMACY_COST_LABEL = 'Pharmacy cost';
export const PHARMACY_TOTAL_LABEL = 'Pharmacy Total';
export const PATIENT_TOTAL_LABEL = 'Patient Total';
export const WHOLESALE_COST_LABEL = 'Wholesale Cost';
export const CURALEAF_DELIVERY_LABEL = 'Curaleaf Delivery';
export const PHARMACY_DELIVERY_LABEL = 'Pharmacy Delivery';
export const DISPENSING_COST_LABEL = 'Dispensing Cost';

export type OrderPricingPence = {
  medicinePence: number;
  dispensingPence?: number;
  pharmacyDeliveryPence?: number;
  wholesalePence?: number | null;
  curaleafDeliveryPence?: number | null;
};

const safePence = (value: number | null | undefined) => Number.isFinite(value) ? Math.max(0, Math.round(value!)) : 0;

/** One exact ledger shared by checkout, payment and finance surfaces. */
export function orderPricingTotals(input: OrderPricingPence) {
  const medicinePence = safePence(input.medicinePence);
  const dispensingPence = safePence(input.dispensingPence);
  const pharmacyDeliveryPence = safePence(input.pharmacyDeliveryPence);
  const wholesaleKnown = input.wholesalePence != null && Number.isFinite(input.wholesalePence);
  const wholesalePence = safePence(input.wholesalePence);
  const curaleafDeliveryPence = safePence(input.curaleafDeliveryPence);
  const patientTotalPence = medicinePence + dispensingPence + pharmacyDeliveryPence;
  const pharmacyTotalPence = wholesaleKnown ? wholesalePence + curaleafDeliveryPence : null;
  return {
    medicinePence,
    dispensingPence,
    pharmacyDeliveryPence,
    wholesalePence,
    curaleafDeliveryPence,
    patientTotalPence,
    pharmacyTotalPence,
    grossMarginPence: pharmacyTotalPence == null ? null : patientTotalPence - pharmacyTotalPence,
  };
}

export function optionalChargeVisible(pence: number | null | undefined) {
  return safePence(pence) > 0;
}

export function validOptionalChargePence(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= 1_500;
}

/**
 * Gross margin is healthy from this percentage upward (inclusive). Below it,
 * surfaces use the warn tone so staff notice thin or negative margins.
 */
export const MARGIN_HEALTHY_PCT = 20;

/**
 * Tone class for a margin percentage. `null` when the margin is unknown
 * (no wholesale yet) — callers leave the value unstyled.
 */
export function marginToneClass(marginPct: number | null): 'is-good' | 'is-warn' | '' {
  if (marginPct === null || !Number.isFinite(marginPct)) return '';
  return marginPct >= MARGIN_HEALTHY_PCT ? 'is-good' : 'is-warn';
}

/**
 * Percentage of `basis` that `contribution` represents. Null when either side
 * is unknown so tone helpers do not treat an unquoted basket as 0%.
 */
export function marginPercent(contribution: number | null, basis: number): number | null {
  if (contribution === null || !Number.isFinite(contribution) || !(basis > 0)) return null;
  return Math.round((contribution / basis) * 100);
}

/**
 * The one house format for a margin: signed cash first, then the percentage of
 * the revenue it came out of. Staff decide on the pounds and use the percentage
 * to sanity-check them, so the two always travel together.
 *
 * `contribution` of null means the wholesale cost has not been quoted yet — an
 * unknown margin reads as unknown rather than as zero.
 */
export function formatMargin(contribution: number | null, basis: number): string {
  if (contribution === null || !Number.isFinite(contribution)) return 'Pending';
  const pct = marginPercent(contribution, basis) ?? 0;
  return `${contribution < 0 ? '−' : '+'}£${Math.abs(contribution).toFixed(2)} (${pct}%)`;
}
