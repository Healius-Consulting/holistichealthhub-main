import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { partnerTermsState, type PartnerTermsStateDeps } from '../../application/pharmacy-onboarding/partner-terms.service.js';
import { HttpError } from '../../domain/common/errors.js';
import { uuidInput } from '../../domain/common/uuid.js';
import { StorageProvider } from '../../providers/storage/storage.provider.js';
import type { PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';
import type { PartnerTermsAcceptanceRecord } from '../../domain/pharmacy-onboarding/terms.js';
import { SqlPartnerTermsRepository } from '../../repositories/sql/partner-terms.sql.js';
import { SqlPharmacyOnboardingRepository } from '../../repositories/sql/pharmacy-onboarding.sql.js';
import { SqlPlatformContentRepository } from '../../repositories/sql/worldpay-application.sql.js';
import { publicPartnerTermsReadLimiter } from '../../security/public-limits.js';

export type PublicPartnerTermsDeps = PartnerTermsStateDeps & {
  requests: {
    findById(id: string): Promise<PharmacyOnboardingRequestRecord | null>;
    findTermsAcceptances(id: string): Promise<PartnerTermsAcceptanceRecord[]>;
  };
  storage: { downloadFile(path: string): Promise<{ bytes: Buffer }> };
};

function sqlDeps(): PublicPartnerTermsDeps {
  return {
    content: new SqlPlatformContentRepository(),
    repo: new SqlPartnerTermsRepository(),
    requests: new SqlPharmacyOnboardingRepository(),
    storage: new StorageProvider(),
  };
}

const requestQuery = z.object({ request: uuidInput });

/**
 * Sign-up's view of the Partner Terms. There is no public Terms page: the file is only
 * served to a pharmacy mid sign-up, against its own pending onboarding request.
 *   GET /public/partner-terms                   whether sign-up must ask for them, and the version
 *   GET /public/partner-terms/file?request=<id> the current version's PDF, for that pending request
 */
export function createPublicPartnerTermsRouter(depsFor: () => PublicPartnerTermsDeps = (() => {
  let deps: PublicPartnerTermsDeps | null = null;
  return () => (deps ??= sqlDeps());
})()): Router {
  const router = Router();

  router.get('/public/partner-terms', publicPartnerTermsReadLimiter, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const state = await partnerTermsState(depsFor());
      // Short cache: switching the Terms on reaches sign-up within a minute.
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.status(200).json({ required: state.on, version: state.on ? state.document!.version : null });
    } catch (error) {
      next(error);
    }
  });

  router.get('/public/partner-terms/file', publicPartnerTermsReadLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { request: requestId } = requestQuery.parse(req.query);
      const deps = depsFor();
      const state = await partnerTermsState(deps);
      const request = await deps.requests.findById(requestId);
      // Only a pending request that still has to sign gets the file; everything else looks the same.
      const owes = state.on && request?.status === 'PENDING' && (await deps.requests.findTermsAcceptances(request.id)).length === 0;
      if (!owes || !state.document) throw new HttpError(404, 'The Partner Terms are not available here.', 'NOT_FOUND');
      const file = await deps.storage.downloadFile(state.document.storagePath);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="Partner-Terms-${state.document.version.replace(/[^A-Za-z0-9._-]/g, '')}.pdf"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).send(file.bytes);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
