import type { Request } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

const limitResponse = { code: 'RATE_LIMITED', message: 'Too many requests. Wait briefly before trying again.' };

export function publicClientIp(request: Request): string {
  const forwarded = request.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const client = raw?.split(',')[0]?.trim();
  return client || request.ip || 'unknown';
}

function publicLimiter(windowMs: number, limit: number) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator: request => ipKeyGenerator(publicClientIp(request)),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: limitResponse,
  });
}

export const publicSubmissionLimiter = publicLimiter(60 * 60 * 1000, 30);
export const publicPaymentStatusLimiter = publicLimiter(15 * 60 * 1000, 90);
export const publicWebhookLimiter = publicLimiter(15 * 60 * 1000, 300);
export const publicReferralResolveLimiter = publicLimiter(15 * 60 * 1000, 240);
export const publicPostcodeSearchLimiter = publicLimiter(15 * 60 * 1000, 120);
export const publicPharmsmartLoginLimiter = publicLimiter(15 * 60 * 1000, 20);
