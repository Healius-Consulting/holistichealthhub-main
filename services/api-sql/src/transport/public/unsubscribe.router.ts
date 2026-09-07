import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { HttpError } from '../../domain/common/errors.js';
import { verifyUnsubscribe } from '../../domain/notifications/unsubscribe-token.js';
import { SqlSuppressionRepository } from '../../repositories/sql/suppression.sql.js';
import { publicSubmissionLimiter } from '../../security/public-limits.js';

const unsubscribeSchema = z.object({
  c: z.string().regex(/^[a-f0-9]{64}$/),
  s: z.string().regex(/^[a-f0-9]{64}$/),
  channel: z.enum(['EMAIL', 'SMS']).default('EMAIL'),
}).strict();

export function createPublicUnsubscribeRouter(): Router {
  const router = Router();
  const suppressionRepo = new SqlSuppressionRepository();

  /**
   * PECR reg. 22 requires an opt-out that works from the message itself, so this is
   * unauthenticated and relies on the signature in the link. It answers the same way
   * whether or not the contact was already suppressed — an unsubscribe page must not
   * become an oracle for whether an address is on the list.
   */
  router.post('/public/unsubscribe', publicSubmissionLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = unsubscribeSchema.parse({ ...req.query, ...req.body });
      if (!verifyUnsubscribe(input.c, input.s)) {
        throw new HttpError(400, 'This unsubscribe link is not valid.', 'INVALID_UNSUBSCRIBE_LINK');
      }
      await suppressionRepo.suppress({
        contactHash: input.c,
        channel: input.channel,
        reason: 'PATIENT_UNSUBSCRIBED',
      });
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ unsubscribed: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
