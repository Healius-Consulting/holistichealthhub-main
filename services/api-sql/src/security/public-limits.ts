import type { Request } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

const limitResponse = { code: 'RATE_LIMITED', message: 'Too many requests. Wait briefly before trying again.' };

export function publicClientIp(request: Request): string {
  const forwarded = request.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const client = raw?.split(',')[0]?.trim();
  return client || request.ip || 'unknown';
}

function publicLimiter(windowMs: number, limit: number, message = limitResponse) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator: request => ipKeyGenerator(publicClientIp(request)),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message,
  });
}

export const publicSubmissionLimiter = publicLimiter(60 * 60 * 1000, 30);
/**
 * The three pharmacy onboarding forms (Curaleaf account, Partner Terms, Worldpay) each
 * get their own count, so finishing one never uses up another, and failed attempts
 * still count, so ten an hour leaves room to fix a typo or two and still stops scripts.
 */
export const ONBOARDING_FORM_LIMIT_PER_HOUR = 10;

function onboardingFormLimiter() {
  return publicLimiter(60 * 60 * 1000, ONBOARDING_FORM_LIMIT_PER_HOUR, {
    code: 'RATE_LIMITED',
    message: 'This form has been tried too many times. Wait an hour, then send it again.',
  });
}

export const publicCuraleafFormLimiter = onboardingFormLimiter();
export const publicPartnerTermsLimiter = onboardingFormLimiter();
export const publicWorldpayFormLimiter = onboardingFormLimiter();
/**
 * Companies House lookups on the Curaleaf form. Thirty an hour covers a few typos per
 * pharmacy and keeps any one address well inside HHH's 600-per-5-minutes key.
 */
export const publicCompanyLookupLimiter = publicLimiter(60 * 60 * 1000, 30, {
  code: 'RATE_LIMITED',
  message: 'Too many company lookups. Fill the form in yourself, or try again in an hour.',
});
/** Worldpay application drafts autosave as the pharmacy types (debounced), so the allowance is generous. */
export const publicWorldpayDraftLimiter = publicLimiter(60 * 60 * 1000, 600);
/** "Not yet" is one click per visit. Ten an hour allows a few retries and stops scripts. */
export const publicPharmacyOnboardingDeferralLimiter = publicLimiter(60 * 60 * 1000, 10);
export const publicPaymentStatusLimiter = publicLimiter(15 * 60 * 1000, 90);
export const publicWebhookLimiter = publicLimiter(15 * 60 * 1000, 300);
export const publicReferralResolveLimiter = publicLimiter(15 * 60 * 1000, 240);
export const publicPostcodeSearchLimiter = publicLimiter(15 * 60 * 1000, 120);
export const publicPharmsmartLoginLimiter = publicLimiter(15 * 60 * 1000, 20);
