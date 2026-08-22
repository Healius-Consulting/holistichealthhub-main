import { Router, type Request, type Response, type NextFunction } from 'express';
import { HttpError } from '../../domain/common/errors.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { publicReferralResolveLimiter } from '../../security/public-limits.js';
import { sha256 } from '../../security/session-utils.js';

export function createDirectoryRouter(): Router {
  const router = Router();
  const organisationRepo = new SqlOrganisationRepository();

  // GET /v1/public/pharmacies/by-token/:token
  router.get('/public/pharmacies/by-token/:token', publicReferralResolveLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawToken = req.params.token;
      if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 8 || rawToken.length > 256) {
        throw new HttpError(404, 'Pharmacy not found.', 'NOT_FOUND');
      }

      // Query by SHA-256 token hash (never raw token)
      const tokenHash = sha256(rawToken);
      const resolution = await organisationRepo.findDirectoryByTokenHash(tokenHash);

      if (!resolution) {
        throw new HttpError(404, 'Pharmacy referral token is invalid or expired.', 'NOT_FOUND');
      }

      res.status(200).json(resolution);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
