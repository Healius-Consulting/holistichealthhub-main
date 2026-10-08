import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { fetchPharmsmartPharmacyInfo } from '../../application/identity/pharmsmart-pharmacy-client.js';
import { PharmsmartSsoService } from '../../application/identity/pharmsmart-sso.service.js';
import { SessionService } from '../../application/identity/session.service.js';
import { firstPartyPasswordResetLink, portalAppOrigin } from '../../application/identity/password-reset-link.js';
import { hasEnrolledTotp } from '../../application/identity/staff-activation.js';
import { dispatchEmailEvent } from '../../application/notifications/email-dispatch.js';
import { auth } from '../../bootstrap/firebase.js';
import { config } from '../../bootstrap/config.js';
import { HttpError } from '../../domain/common/errors.js';
import { cookieOptions, csrfCookieName, issueCsrf, requireCsrf } from '../../security/csrf.js';
import { publicPharmsmartLoginLimiter } from '../../security/public-limits.js';
import { ipHash } from '../../security/session-utils.js';
import type { ProtectedSurface } from '../../security/request-context.js';
import { requireStaff, sessionCookieName } from '../../security/require-staff.js';
import { assertTenantScope } from '../../security/request-context.js';
import { SqlIdentityRepository } from '../../repositories/sql/identity.sql.js';
import { SqlNotificationRepository } from '../../repositories/sql/notification.sql.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { SqlIntegrationRepository } from '../../repositories/sql/integration.sql.js';
import { toPortalOrganisation } from '../portal/pharmacy-contracts.js';

const sessionInputSchema = z.object({
  idToken: z.string().min(100).max(20_000),
});

const passwordResetSchema = z.object({
  email: z.email().transform(value => value.toLowerCase()),
}).strict();

const pharmsmartLoginSchema = z.object({
  token: z.string().trim().min(16).max(2048),
}).strict();

const pharmsmartSetupSchema = z.object({
  ticket: z.string().trim().min(20).max(4_000),
  email: z.string().trim().email().max(254).optional(),
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
}).strict();

function firebaseAuthErrorCode(error: unknown) {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { code?: unknown; errorInfo?: { code?: unknown } };
  return typeof candidate.code === 'string'
    ? candidate.code
    : typeof candidate.errorInfo?.code === 'string'
      ? candidate.errorInfo.code
      : null;
}

function bearerToken(request: Request) {
  const header = request.get('authorization') || '';
  if (!header.toLowerCase().startsWith('bearer ')) return '';
  return header.slice(7).trim();
}

export function createAuthRouter(): Router {
  const router = Router();
  const sessionService = new SessionService();
  const identityRepo = new SqlIdentityRepository();
  const organisationRepo = new SqlOrganisationRepository();
  const integrationRepo = new SqlIntegrationRepository();
  const notificationRepo = new SqlNotificationRepository();
  const markPharmsmartAccount = async (input: {
    uid: string;
    organisationId: string;
    email: string;
    displayName: string;
  }) => {
    await auth.updateUser(input.uid, {
      emailVerified: true,
      displayName: input.displayName,
      // PharmSmart already completed its own second factor. Do not ask again here.
      multiFactor: { enrolledFactors: null },
    });
    await auth.setCustomUserClaims(input.uid, {
      role: 'pharmacy_staff',
      organisationId: input.organisationId,
      pharmsmartSso: true,
    });
    await identityRepo.upsertStaffUser({
      uid: input.uid,
      organisationId: input.organisationId,
      email: input.email,
      displayName: input.displayName,
      role: 'PHARMACY_STAFF',
      status: 'ACTIVE',
      disabled: false,
    });
  };
  const pharmsmartSso = new PharmsmartSsoService({
    fetchPharmacyInfo: fetchPharmsmartPharmacyInfo,
    listOrganisations: () => organisationRepo.listOrganisations(),
    listStaff: organisationId => identityRepo.listPharmacyStaffByOrganisationId(organisationId),
    findEmailOwner: async email => {
      try {
        const user = await auth.getUserByEmail(email);
        const profile = await identityRepo.findStaffUser(user.uid);
        return profile ?? 'unlinked';
      } catch (error) {
        if (firebaseAuthErrorCode(error) === 'auth/user-not-found') return null;
        throw error;
      }
    },
    adoptAccount: async (staff, displayName) => {
      if (!staff.organisationId) {
        throw new HttpError(403, 'This pharmacy sign-in could not be opened.', 'PHARMACY_LOGIN_UNAVAILABLE');
      }
      await markPharmsmartAccount({
        uid: staff.uid,
        organisationId: staff.organisationId,
        email: staff.email,
        displayName: staff.displayName.trim() || displayName,
      });
    },
    createAccount: async input => {
      const user = await auth.createUser({
        email: input.email,
        displayName: input.displayName,
        emailVerified: true,
      });
      await markPharmsmartAccount({ uid: user.uid, ...input });
      return user.uid;
    },
    createCustomToken: (uid, claims) => auth.createCustomToken(uid, claims),
    audit: input => identityRepo.appendAudit(input),
    setupSecret: config.IP_HASH_SECRET ?? `${config.FIREBASE_PROJECT_ID}:pharmsmart-sso`,
  });

  // GET /v1/auth/csrf - Issue or refresh CSRF token
  router.get('/auth/csrf', (req: Request, res: Response) => {
    const csrfToken = issueCsrf(req, res);
    res.json({ csrfToken });
  });

  // POST /v1/auth/pharmsmart - Redeem an opaque PharmSmart token.
  // The body is only the token. The GPhC selects the pharmacy, and the person gets an SSO account.
  router.post('/auth/pharmsmart', publicPharmsmartLoginLimiter, requireCsrf, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = pharmsmartLoginSchema.parse(req.body);
      const result = await pharmsmartSso.redeem(token, {
        requestId: req.requestId ?? null,
        ipHash: ipHash(req),
      });
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post('/auth/pharmsmart/setup', publicPharmsmartLoginLimiter, requireCsrf, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = pharmsmartSetupSchema.parse(req.body);
      const result = await pharmsmartSso.completeSetup(input, {
        requestId: req.requestId ?? null,
        ipHash: ipHash(req),
      });
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/auth/session - Exchange ID token for session cookie
  router.post('/auth/session', requireCsrf, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { idToken } = sessionInputSchema.parse(req.body);
      const requestedSurface = (req.query.__hhh_surface as ProtectedSurface | 'auto') || 'auto';
      const userAgent = req.get('user-agent') || 'unknown';

      const result = await sessionService.createSession({
        idToken,
        requestedSurface,
        userAgent,
      });

      // Set secure HTTP-only session cookie
      res.cookie(sessionCookieName, result.sessionCookie, cookieOptions(true));
      const csrfToken = issueCsrf(req, res);

      res.status(200).json({
        uid: result.uid,
        email: result.email,
        displayName: result.displayName,
        role: result.role.toLowerCase(),
        organisationId: result.organisationId,
        surface: result.surface,
        idleExpiresAt: result.idleExpiresAt,
        absoluteExpiresAt: result.absoluteExpiresAt,
        csrfToken,
      });
    } catch (error) {
      next(error);
    }
  });

  // GET /v1/auth/session - Get current authentication session.
  const getSessionHandler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.context || req.context.kind === 'public') {
        throw new HttpError(401, 'A valid staff session is required.', 'UNAUTHENTICATED');
      }
      const payload = await sessionService.getSessionPayload(req.context);
      const csrfToken = issueCsrf(req, res);
      res.json({ ...payload, csrfToken });
    } catch (error) {
      next(error);
    }
  };

  router.get('/auth/session', requireStaff('any'), getSessionHandler);

  // GET /v1/portal/session - Return the tenant profile contract consumed by
  // the pharmacy shell. The organisation is resolved from the admitted SQL
  // tenant scope, never from a caller-supplied identifier.
  router.get('/portal/session', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const [payload, staff, organisation, curaleaf] = await Promise.all([
        sessionService.getSessionPayload(scope),
        identityRepo.findStaffUser(scope.uid),
        organisationRepo.findOrganisationById(scope.organisationId),
        integrationRepo.findConnection(scope.organisationId, 'CURALEAF'),
      ]);
      if (!staff || !organisation) {
        throw new HttpError(403, 'The pharmacy account is not fully provisioned.', 'TENANT_REQUIRED');
      }
      const csrfToken = issueCsrf(req, res);
      res.status(200).json({
        ...payload,
        csrfToken,
        pharmacyId: scope.organisationId,
        profile: {
          uid: staff.uid,
          organisationId: staff.organisationId,
          email: staff.email,
          displayName: staff.displayName,
          role: staff.role.toLowerCase(),
          status: staff.status.toLowerCase(),
          disabled: staff.disabled,
        },
        organisation: toPortalOrganisation(organisation, { curaleafPharmacyCode: curaleaf?.externalCustomerId }),
      });
    } catch (error) {
      next(error);
    }
  });


  // DELETE /v1/auth/session - Log out and revoke session
  router.delete('/auth/session', requireCsrf, requireStaff('any'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (req.context && req.context.kind !== 'public') {
        await sessionService.revokeSession(req.context.sessionHash, 'logout');
      }
      res.clearCookie(sessionCookieName, cookieOptions(true, 0));
      res.clearCookie(csrfCookieName, cookieOptions(false, 0));
      res.status(200).json({ status: 'logged_out' });
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/auth/activity - Touch and return the complete refreshed session
  router.post('/auth/activity', requireCsrf, requireStaff('any'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.context || req.context.kind === 'public') {
        throw new HttpError(401, 'A valid staff session is required.', 'UNAUTHENTICATED');
      }
      const payload = await sessionService.getSessionPayload(req.context);
      const csrfToken = issueCsrf(req, res);
      res.status(200).json({ ...payload, csrfToken });
    } catch (error) {
      next(error);
    }
  });

  router.post('/auth/password-reset', requireCsrf, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email } = passwordResetSchema.parse(req.body);
      try {
        const user = await auth.getUserByEmail(email);
        const profile = await identityRepo.findStaffUser(user.uid);
        if (profile && !profile.disabled && profile.status !== 'REMOVED') {
          const firebaseLink = await auth.generatePasswordResetLink(profile.email, {
            url: new URL('/reset-password', portalAppOrigin()).toString(),
            handleCodeInApp: true,
          });
          const actionLink = firstPartyPasswordResetLink(firebaseLink, portalAppOrigin());
          const organisation = profile.organisationId
            ? await organisationRepo.findOrganisationById(profile.organisationId)
            : null;
          await dispatchEmailEvent('staff.password_reset', {
            notificationRepo,
            organisationId: profile.organisationId,
            to: { email: profile.email, displayName: profile.displayName },
            payload: {
              pharmacyName: organisation?.name || 'HHH admin workspace',
              organisationId: organisation?.id || '',
              actionLink,
            },
            keyParts: ['staff-password-reset', profile.uid, Date.now()],
          });
          await identityRepo.appendAudit({
            organisationId: profile.organisationId,
            actorUid: profile.uid,
            actorRole: profile.role,
            event: 'staff.password_reset_queued',
            recordType: 'StaffUser',
            recordId: profile.uid,
            requestId: req.requestId ?? null,
            surface: profile.role === 'HHH_ADMIN' ? 'admin' : 'pharmacy',
          });
        }
      } catch {
        // Always acknowledge so the login form cannot be used to probe staff accounts.
      }
      res.status(200).json({ accepted: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(200).json({ accepted: true });
        return;
      }
      next(error);
    }
  });

  router.post('/auth/mfa-enrolled', requireCsrf, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const idToken = bearerToken(req);
      if (!idToken) {
        throw new HttpError(401, 'A valid staff session is required.', 'UNAUTHENTICATED');
      }
      let uid = '';
      try {
        uid = (await auth.verifyIdToken(idToken, true)).uid;
      } catch {
        throw new HttpError(401, 'A valid staff session is required.', 'UNAUTHENTICATED');
      }
      let profile = await identityRepo.findStaffUser(uid);
      if (!profile || profile.disabled || (profile.status !== 'INVITED' && profile.status !== 'ACTIVE')) {
        throw new HttpError(401, 'A valid staff session is required.', 'UNAUTHENTICATED');
      }
      const firebaseUser = await auth.getUser(uid);
      if (!hasEnrolledTotp(firebaseUser)) {
        throw new HttpError(403, 'Complete authenticator enrolment before activating this staff account.', 'MFA_TOTP_REQUIRED');
      }
      if (profile.status === 'INVITED') {
        const activated = await identityRepo.activateInvitedStaffUser(uid);
        if (!activated) {
          profile = await identityRepo.findStaffUser(uid);
          if (!profile || profile.disabled || profile.status !== 'ACTIVE') {
            throw new HttpError(409, 'The staff account changed while activation was being completed.', 'ACCOUNT_STATE_CONFLICT');
          }
        } else {
          profile = { ...profile, status: 'ACTIVE' };
        }
      }
      const organisation = profile.organisationId
        ? await organisationRepo.findOrganisationById(profile.organisationId)
        : null;
      await dispatchEmailEvent('staff.2fa_enabled', {
        notificationRepo,
        organisationId: profile.organisationId,
        to: { email: profile.email, displayName: profile.displayName },
        payload: {
          pharmacyName: profile.role === 'HHH_ADMIN'
            ? 'HHH admin workspace'
            : organisation?.name || 'the pharmacy',
          organisationId: organisation?.id || '',
        },
        keyParts: ['pharmacy-2fa-enabled', profile.uid, Date.now()],
      });
      await identityRepo.appendAudit({
        organisationId: profile.organisationId,
        actorUid: profile.uid,
        actorRole: profile.role,
        event: 'staff.mfa_enrolled',
        recordType: 'StaffUser',
        recordId: profile.uid,
        requestId: req.requestId ?? null,
        surface: profile.role === 'HHH_ADMIN' ? 'admin' : 'pharmacy',
      });
      res.status(200).json({ queued: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
