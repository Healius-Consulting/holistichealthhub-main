import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  loadWorldpayApplication,
  saveWorldpayDraft,
  submitWorldpayApplication,
  type WorldpayDeps,
  type WorldpayOwner,
} from '../../application/worldpay-application/applications.js';
import { worldpayHooks } from '../../application/worldpay-application/hooks.js';
import { sqlWorldpayDeps, worldpayPrefill } from '../../application/worldpay-application/sql-deps.js';
import { HttpError } from '../../domain/common/errors.js';
import { SqlPharmacyOnboardingRepository } from '../../repositories/sql/pharmacy-onboarding.sql.js';
import { SqlNotificationRepository } from '../../repositories/sql/notification.sql.js';
import { SqlPartnerTermsRepository } from '../../repositories/sql/partner-terms.sql.js';
import { SqlPlatformContentRepository } from '../../repositories/sql/worldpay-application.sql.js';
import { partnerTermsState } from '../../application/pharmacy-onboarding/partner-terms.service.js';
import { publicWorldpayDraftLimiter, publicWorldpayFormLimiter } from '../../security/public-limits.js';

const requestId = z.string().uuid();
const loadSchema = z.object({ onboardingRequestId: requestId });
const saveSchema = z.object({
  onboardingRequestId: requestId,
  id: z.string().uuid().nullable().default(null),
  version: z.number().int().min(0).default(0),
  answers: z.unknown(),
});
const submitSchema = z.object({
  onboardingRequestId: requestId,
  id: z.string().uuid(),
  version: z.number().int().min(1),
  answers: z.unknown(),
  declaration: z.unknown(),
});

/**
 * The Worldpay application from the public onboarding page, before the branch exists.
 * It belongs to the onboarding request: its id is a random UUID the browser was given
 * when the Curaleaf form went in. While the Partner Terms are on, a request that still
 * has to sign them (its Curaleaf application has not gone) must accept them first.
 * Once the request is activated the application lives in the portal instead.
 */
export function createPublicWorldpayApplicationRouter(deps: () => WorldpayDeps = () => sqlWorldpayDeps(worldpayHooks())): Router {
  const router = Router();
  const onboardingRepo = new SqlPharmacyOnboardingRepository();
  const notificationRepo = new SqlNotificationRepository();
  const termsDeps = { content: new SqlPlatformContentRepository(), repo: new SqlPartnerTermsRepository() };

  const ownerFor = async (onboardingRequestId: string) => {
    const request = await onboardingRepo.findById(onboardingRequestId);
    if (!request) throw new HttpError(404, 'This onboarding request could not be found.', 'NOT_FOUND');
    if (request.status === 'ACTIVATED') {
      throw new HttpError(409, 'Your pharmacy account is ready. Sign in to the portal to continue your Worldpay application.', 'WORLDPAY_USE_PORTAL');
    }
    const terms = await onboardingRepo.findTermsAcceptances(request.id);
    if (terms.length === 0 && (await partnerTermsState(termsDeps)).on) {
      const applicationSent = ((await notificationRepo.listForOnboardingRequest?.(request.id)) ?? [])
        .some(row => row.templateCode === 'curaleaf_new_account_application');
      if (!applicationSent) throw new HttpError(409, 'Accept the Partner Terms before starting the Worldpay application.', 'ONBOARDING_TERMS_REQUIRED');
    }
    const owner: WorldpayOwner = { kind: 'request', onboardingRequestId: request.id, gphcNumber: request.gphcNumber };
    return { request, terms, owner };
  };

  // POST /v1/public/worldpay-application/load - the request's application, or a new one
  router.post('/public/worldpay-application/load', publicWorldpayDraftLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = loadSchema.parse(req.body);
      const { request, terms, owner } = await ownerFor(input.onboardingRequestId);
      const view = await loadWorldpayApplication(deps(), owner, worldpayPrefill({ request, terms: terms[0] ?? null }));
      res.setHeader('Cache-Control', 'private, no-store');
      // A sent application's answers are never handed back on a public route.
      res.status(200).json(view.status && view.status !== 'DRAFT' ? { ...view, answers: null } : view);
    } catch (error) {
      next(error);
    }
  });

  // PUT /v1/public/worldpay-application - save the draft
  router.put('/public/worldpay-application', publicWorldpayDraftLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = saveSchema.parse(req.body);
      const { owner } = await ownerFor(input.onboardingRequestId);
      const saved = await saveWorldpayDraft(deps(), owner, input);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(saved);
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/public/worldpay-application/submit - final answers and the declaration
  router.post('/public/worldpay-application/submit', publicWorldpayFormLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = submitSchema.parse(req.body);
      const { terms, owner } = await ownerFor(input.onboardingRequestId);
      const signer = terms[0];
      const declarationName = typeof (input.declaration as { signerName?: unknown })?.signerName === 'string' ? String((input.declaration as { signerName: string }).signerName) : '';
      const record = await submitWorldpayApplication(deps(), owner, {
        ...input,
        submitter: { uid: null, name: declarationName || signer?.signerName || '', email: signer?.signerEmail ?? '' },
      });
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(201).json({ id: record.id, status: record.status, reference: record.reference, submittedAt: record.submittedAt });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
