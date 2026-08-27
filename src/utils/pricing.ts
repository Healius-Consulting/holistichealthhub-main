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

/** The patient's medicines subtotal, before the dispensing charge. */
export const PATIENT_PRICE_LABEL = 'Patient price';

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
  const pct = basis > 0 ? Math.round((contribution / basis) * 100) : 0;
  return `${contribution < 0 ? '−' : '+'}£${Math.abs(contribution).toFixed(2)} (${pct}%)`;
}
