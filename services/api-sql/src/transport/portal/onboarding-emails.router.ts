import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { OnboardingEmails } from '../../application/pharmacy-onboarding/onboarding-emails.js';
import { onboardingEmailLog, sqlOnboardingEmails } from '../../application/pharmacy-onboarding/onboarding-emails.service.js';
import { readOnboardingContent } from '../../application/pharmacy-onboarding/onboarding-content.js';
import {
  ONBOARDING_CONTENT_KEYS,
  ONBOARDING_CONTENT_SCHEMAS,
  ONBOARDING_EMAIL_KINDS,
  ONBOARDING_EMAIL_MERGE_HELP,
  type OnboardingContentKey,
} from '../../domain/pharmacy-onboarding/content.js';
import type { NotificationRepositoryPort } from '../../repositories/ports/notification.port.js';
import type { PlatformContentRepository } from '../../repositories/ports/worldpay-application.port.js';
import { SqlIdentityRepository } from '../../repositories/sql/identity.sql.js';
import { SqlNotificationRepository } from '../../repositories/sql/notification.sql.js';
import { SqlPlatformContentRepository } from '../../repositories/sql/worldpay-application.sql.js';
import { requireCsrf } from '../../security/csrf.js';
import { assertPlatformScope, type RequestContext } from '../../security/request-context.js';
import { requireStaff } from '../../security/require-staff.js';
import { uuidParam } from './uuid-param.js';

const kindParam = z.enum(ONBOARDING_EMAIL_KINDS);
const contentKeyParam = z.enum(Object.keys(ONBOARDING_CONTENT_KEYS) as [OnboardingContentKey, ...OnboardingContentKey[]]);

export interface OnboardingEmailsRouterDeps {
  emails: Pick<OnboardingEmails, 'resend'>;
  notifications: Pick<NotificationRepositoryPort, 'listForOnboardingRequest'>;
  content: PlatformContentRepository;
  audit: (entry: { scope: ReturnType<typeof assertPlatformScope>; event: string; recordType: string; recordId: string; details: Record<string, unknown> }) => Promise<void>;
}

function sqlDeps(): OnboardingEmailsRouterDeps {
  const identityRepo = new SqlIdentityRepository();
  return {
    emails: sqlOnboardingEmails(),
    notifications: new SqlNotificationRepository(),
    content: new SqlPlatformContentRepository(),
    audit: async ({ scope, event, recordType, recordId, details }) => {
      await identityRepo.appendAudit({
        organisationId: null,
        actorUid: scope.uid,
        actorRole: scope.role,
        event,
        recordType,
        recordId,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
        details,
      });
    },
  };
}

/**
 * Admin: a request's onboarding send log and Resend, and the partner onboarding
 * content screen (the five emails, the hold page, addresses, links, Partner Terms).
 *   GET  /portal/admin/pharmacy-onboarding-requests/:id/emails
 *   POST /portal/admin/pharmacy-onboarding-requests/:id/emails/:kind/resend
 *   GET  /portal/admin/onboarding-content
 *   PUT  /portal/admin/onboarding-content/:key
 */
export function createPortalOnboardingEmailsRouter(depsFor: (context: RequestContext) => OnboardingEmailsRouterDeps = (() => {
  let deps: OnboardingEmailsRouterDeps | null = null;
  return () => (deps ??= sqlDeps());
})()): Router {
  const router = Router();

  const contentView = async (content: PlatformContentRepository) => ({
    content: await readOnboardingContent(content),
    mergeHelp: ONBOARDING_EMAIL_MERGE_HELP,
  });

  router.get('/portal/admin/pharmacy-onboarding-requests/:id/emails', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      const id = uuidParam.parse(req.params.id);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({ entries: await onboardingEmailLog(depsFor(req.context!).notifications, id) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/admin/pharmacy-onboarding-requests/:id/emails/:kind/resend', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const id = uuidParam.parse(req.params.id);
      const kind = kindParam.parse(req.params.kind);
      const deps = depsFor(req.context!);
      await deps.emails.resend({ requestId: id, kind, actorUid: scope.uid });
      await deps.audit({
        scope,
        event: 'pharmacy_onboarding.email_resent',
        recordType: 'PharmacyOnboardingRequest',
        recordId: id,
        details: { kind },
      }).catch(() => undefined);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({ entries: await onboardingEmailLog(deps.notifications, id) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/portal/admin/onboarding-content', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(await contentView(depsFor(req.context!).content));
    } catch (error) {
      next(error);
    }
  });

  router.put('/portal/admin/onboarding-content/:key', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const key = contentKeyParam.parse(req.params.key);
      const value = ONBOARDING_CONTENT_SCHEMAS[key].parse((req.body as { value?: unknown })?.value);
      const deps = depsFor(req.context!);
      await deps.content.write(ONBOARDING_CONTENT_KEYS[key], value, scope.uid);
      // Which piece changed, never its text: the Terms text alone can be 100k characters.
      await deps.audit({
        scope,
        event: 'onboarding_content.updated',
        recordType: 'PlatformContent',
        recordId: ONBOARDING_CONTENT_KEYS[key],
        details: { key, ...(key === 'partnerTerms' ? { published: (value as { published: boolean }).published, version: (value as { version: string }).version } : {}) },
      }).catch(() => undefined);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(await contentView(deps.content));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
