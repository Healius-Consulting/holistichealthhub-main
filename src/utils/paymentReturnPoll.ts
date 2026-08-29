/** Worldpay Payment Queries can take up to 60s to index a completed payment. */
export const PAYMENT_RETURN_POLL_GAP_MS = 2_000;
export const PAYMENT_RETURN_GIVE_UP_MS = 60_000;

export function paymentReturnWaitCopy(elapsedMs: number): string {
  if (elapsedMs < 5_000) return 'Contacting the payment gateway…';
  if (elapsedMs < 20_000) return 'Confirming your payment with Worldpay…';
  if (elapsedMs < 45_000) return 'Worldpay is still confirming clearance…';
  return 'Still waiting for Worldpay to confirm…';
}

export function paymentReturnShouldKeepPolling(elapsedMs: number, giveUpMs = PAYMENT_RETURN_GIVE_UP_MS) {
  return elapsedMs < giveUpMs;
}

export function paymentReturnNextGapMs(elapsedMs: number, gapMs = PAYMENT_RETURN_POLL_GAP_MS, giveUpMs = PAYMENT_RETURN_GIVE_UP_MS) {
  return Math.max(0, Math.min(gapMs, giveUpMs - elapsedMs));
}
