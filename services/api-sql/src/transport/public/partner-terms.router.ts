import { Router, type NextFunction, type Request, type Response } from 'express';
import { readOnboardingContent } from '../../application/pharmacy-onboarding/onboarding-content.js';
import { HttpError } from '../../domain/common/errors.js';
import type { PlatformContentRepository } from '../../repositories/ports/worldpay-application.port.js';
import { SqlPlatformContentRepository } from '../../repositories/sql/worldpay-application.sql.js';
import { publicPartnerTermsReadLimiter } from '../../security/public-limits.js';

/**
 * GET /public/partner-terms: the published Partner Terms, the page the emails link to.
 * 404 while admin has not published them, or published them with no text.
 */
export function createPublicPartnerTermsRouter(content: Pick<PlatformContentRepository, 'read'> = new SqlPlatformContentRepository()): Router {
  const router = Router();

  router.get('/public/partner-terms', publicPartnerTermsReadLimiter, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const { partnerTerms } = await readOnboardingContent(content);
      if (!partnerTerms.published || !partnerTerms.text.trim()) {
        throw new HttpError(404, 'The Partner Terms are not published yet.', 'NOT_FOUND');
      }
      // Short cache: a correction admin publishes shows within minutes.
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.status(200).json({ version: partnerTerms.version, text: partnerTerms.text });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
