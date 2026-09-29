import { Router, type Request, type Response, type NextFunction } from 'express';
import { HttpError } from '../../domain/common/errors.js';
import { attachPublicPharmacyLogo } from '../../application/organisation/public-pharmacy-logo.js';
import { StorageProvider } from '../../providers/storage/storage.provider.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { publicReferralResolveLimiter } from '../../security/public-limits.js';
import { sha256 } from '../../security/session-utils.js';
import { normaliseReferralToken } from '../../domain/referrals/referral-token.js';

export function createDirectoryRouter(): Router {
  const router = Router();
  const organisationRepo = new SqlOrganisationRepository();
  const storage = new StorageProvider();

  // GET /v1/public/pharmacies/by-token/:token
  router.get('/public/pharmacies/by-token/:token', publicReferralResolveLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rawToken = req.params.token;
      const token = typeof rawToken === 'string' ? normaliseReferralToken(rawToken) : null;
      if (!token) {
        throw new HttpError(404, 'Pharmacy not found.', 'NOT_FOUND');
      }

      // Query by SHA-256 token hash (never raw token)
      const tokenHash = sha256(token);
      const resolution = await organisationRepo.findDirectoryByTokenHash(tokenHash);

      if (!resolution) {
        throw new HttpError(404, 'Pharmacy referral token is invalid or expired.', 'NOT_FOUND');
      }

      res.status(200).json({
        ...resolution,
        pharmacy: await attachPublicPharmacyLogo(storage, resolution.pharmacy),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
