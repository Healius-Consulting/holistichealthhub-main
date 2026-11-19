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
import { renderEmailTemplate } from '../../application/notifications/email-renderer.js';
import { readEmailCopy } from '../../application/notifications/email-copy.service.js';
import { prescriberAlertEmail } from '../../application/workers/curaleaf-prescriber-alert.js';
import { ONBOARDING_EMAIL_TEMPLATE } from '../../application/pharmacy-onboarding/onboarding-emails.service.js';
import {
  EDITABLE_EMAIL_CODES,
  EMAIL_COPY_CONTENT_KEY,
  EMAIL_COPY_SPECS,
  emailCopyFrom,
  parseEmailCopy,
  type EditableEmailCode,
} from '../../domain/notifications/email-copy.js';

const kindParam = z.enum(ONBOARDING_EMAIL_KINDS);
const emailCodeParam = z.enum(EDITABLE_EMAIL_CODES as [EditableEmailCode, ...EditableEmailCode[]]);
const onboardingPreviewBody = z.object({
  subject: z.string().max(400),
  paragraphs: z.array(z.string().max(6000)).max(80),
  fromName: z.string().max(120).optional(),
});

/** Email images are attachments (cid:); in the admin preview they load from the portal's own copies. */
function previewHtml(html: string) {
  return html
    .replaceAll('cid:email-hhh-logo', '/email/hhh-logo.png')
    .replaceAll('cid:email-header-logo', '/email/hhh-logo.png')
    .replaceAll('cid:email-curaleaf-logo', '/email/curaleaf-clinic-white.png');
}

/** The stuck-prescriber alert is written when it is sent, so its preview builds a made-up one. */
function prescriberAlertPreview(slots: Record<string, string>) {
  const day = 24 * 60 * 60 * 1000;
  const now = new Date();
  const email = prescriberAlertEmail({
    organisationId: 'preview',
    prescriberId: 'presc-preview',
    prescriber: { name: 'Dr. Prescriber', pin: '123', gmcNumber: null, gphcNumber: '000123' },
    orders: [
      { orderNumber: 'ORD-MWDPNUFJ-634EADD806', waitingSince: new Date(now.getTime() - 6 * day).toISOString() },
      { orderNumber: 'ORD-MWDPPNFX-E0225FEFD2', waitingSince: new Date(now.getTime() - 5 * day).toISOString() },
    ],
  }, { name: 'Kirkgate Pharmacy', gphcNumber: '1123456' }, { externalCustomerId: 'cust-preview', environment: 'PRODUCTION' }, now, slots);
  return renderEmailTemplate('admin_curaleaf_prescriber_stuck', email);
}
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
      // Which piece changed, never its text.
      await deps.audit({
        scope,
        event: 'onboarding_content.updated',
        recordType: 'PlatformContent',
        recordId: ONBOARDING_CONTENT_KEYS[key],
        details: { key },
      }).catch(() => undefined);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(await contentView(deps.content));
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/admin/onboarding-content/preview/:kind', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      const kind = kindParam.parse(req.params.kind);
      const body = onboardingPreviewBody.parse(req.body);
      const rendered = renderEmailTemplate(ONBOARDING_EMAIL_TEMPLATE[kind], { ...body, organisationId: 'preview' });
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({ subject: rendered.subject, html: previewHtml(rendered.html) });
    } catch (error) {
      next(error);
    }
  });

  router.get('/portal/admin/email-copy', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({ copy: await readEmailCopy(depsFor(req.context!).content) });
    } catch (error) {
      next(error);
    }
  });

  router.put('/portal/admin/email-copy/:code', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const code = emailCodeParam.parse(req.params.code);
      const slots = parseEmailCopy(code, (req.body as { slots?: unknown })?.slots);
      const deps = depsFor(req.context!);
      const stored = await deps.content.read([EMAIL_COPY_CONTENT_KEY]);
      const next = { ...emailCopyFrom(stored[EMAIL_COPY_CONTENT_KEY]) };
      if (Object.keys(slots).length) next[code] = slots;
      else delete next[code];
      await deps.content.write(EMAIL_COPY_CONTENT_KEY, next, scope.uid);
      // Which email and which pieces changed, never the text.
      await deps.audit({
        scope,
        event: 'email_copy.updated',
        recordType: 'PlatformContent',
        recordId: EMAIL_COPY_CONTENT_KEY,
        details: { code, edited: Object.keys(slots) },
      }).catch(() => undefined);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({ copy: next });
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/admin/email-copy/:code/preview', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      const code = emailCodeParam.parse(req.params.code);
      const slots = parseEmailCopy(code, (req.body as { slots?: unknown })?.slots);
      // Preview switches (e.g. partly ready, closed as withdrawn) change a few sample values.
      const { sample } = z.object({ sample: z.record(z.string(), z.union([z.string().max(200), z.number()])).optional() }).parse(req.body ?? {});
      const rendered = code === 'admin_curaleaf_prescriber_stuck'
        ? prescriberAlertPreview(slots)
        : renderEmailTemplate(code, { ...EMAIL_COPY_SPECS[code].sample, ...(sample ?? {}) }, { [code]: slots });
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({ subject: rendered.subject, html: previewHtml(rendered.html) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
