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
/** A pharmacy onboarding form is not a high-volume page. Three an hour stops repeat clicks and scripts. */
export const publicPharmacyOnboardingLimiter = publicLimiter(60 * 60 * 1000, 3, {
  code: 'RATE_LIMITED',
  message: 'This form was sent recently. Wait an hour before sending it again.',
});
export const publicPaymentStatusLimiter = publicLimiter(15 * 60 * 1000, 90);
export const publicWebhookLimiter = publicLimiter(15 * 60 * 1000, 300);
export const publicReferralResolveLimiter = publicLimiter(15 * 60 * 1000, 240);
export const publicPostcodeSearchLimiter = publicLimiter(15 * 60 * 1000, 120);
export const publicPharmsmartLoginLimiter = publicLimiter(15 * 60 * 1000, 20);
