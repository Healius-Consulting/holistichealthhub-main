import type { NextFunction, Request, Response } from 'express';
import { auth } from '../bootstrap/firebase.js';
import { secureSessionCookies } from '../bootstrap/config.js';
import { HttpError } from '../domain/common/errors.js';
import { SqlIdentityRepository } from '../repositories/sql/identity.sql.js';
import { validatePortalAdmission } from './admission.js';
import { PHARMACY_ON_HOLD_MESSAGE } from '../domain/pharmacy-onboarding/request.js';
import { sqlHoldMessages } from '../application/pharmacy-onboarding/hold-message.js';
import type { OnboardingHoldMessage } from '../application/pharmacy-onboarding/onboarding-content.js';
import type { PlatformScope, ProtectedSurface, RequestContext, TenantScope } from './request-context.js';
import { parseCookies, SESSION_TOUCH_INTERVAL_MS, sha256 } from './session-utils.js';

export const sessionCookieName = secureSessionCookies ? '__Host-hhh_session' : 'hhh_session';

declare global {
  namespace Express {
    interface Request {
      context?: RequestContext;
      requestId?: string;
    }
  }
}

const identityRepo = new SqlIdentityRepository();

export const PHARMACY_SUSPENDED_MESSAGE = 'This pharmacy\'s account is suspended. Contact Holistic Health Hub to restore access.';

/**
 * The refusal for a branch on hold: 403 PHARMACY_ON_HOLD with `details.hold`, the hold
 * message for its reason (null if the message could not be read), so the sign-in page
 * can show it instead of the account.
 */
export async function pharmacyOnHoldError(
  organisationId: string | null | undefined,
  lookup: (organisationId: string) => Promise<OnboardingHoldMessage | null>,
): Promise<HttpError> {
  const hold = organisationId ? await lookup(organisationId).catch(() => null) : null;
  return new HttpError(403, PHARMACY_ON_HOLD_MESSAGE, 'PHARMACY_ON_HOLD', { hold });
}

const sharedHoldMessages = lazyHoldMessages();
function lazyHoldMessages() {
  let messages: ReturnType<typeof sqlHoldMessages> | null = null;
  return (organisationId: string) => (messages ??= sqlHoldMessages()).forBranch({ id: organisationId });
}

export function requireStaff(expectedSurface: ProtectedSurface | 'any' = 'any') {

  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      const sessionCookie = parseCookies(request)[sessionCookieName];
      if (!sessionCookie) {
        throw new HttpError(401, 'A valid staff session is required.', 'UNAUTHENTICATED');
      }

      // 1. Verify session cookie against Firebase Auth
      let claims;
      try {
        claims = await auth.verifySessionCookie(sessionCookie, true);
      } catch {
        throw new HttpError(401, 'The staff session is invalid or expired.', 'UNAUTHENTICATED');
      }

      // 2. Query SQL Connect for active session and staff user
      const sessionHash = sha256(sessionCookie);
      const admission = await identityRepo.findAdmission(sessionHash, claims.uid);

      // 3. Perform pure validation
      const failure = validatePortalAdmission({
        claims,
        admission,
        sessionHash,
        surface: expectedSurface,
      });

      if (failure?.code === 'PHARMACY_ON_HOLD') {
        throw await pharmacyOnHoldError(admission.staff?.organisationId, sharedHoldMessages);
      }
      if (failure) {
        // A 401 stays deliberately generic: the session itself is the thing in doubt.
        // A 403 is an authenticated staff member hitting a permission wall, and
        // "Session admission failed." reads as a scary auth outage instead of the
        // plain "your role cannot do this" that it actually is.
        const message = failure.code === 'PHARMACY_SUSPENDED'
          ? PHARMACY_SUSPENDED_MESSAGE
          : failure.status === 403
            ? 'Your staff role is not permitted to perform this action.'
            : 'Session admission failed.';
        throw new HttpError(failure.status, message, failure.code);
      }

      const session = admission.session!;
      const staff = admission.staff!;
      const requestId = request.requestId || crypto.randomUUID();
      request.requestId = requestId;

      // 4. Persist a debounced activity extension before returning a newer
      // deadline to the client. A serverless background write may be dropped.
      const now = Date.now();
      const lastActivity = Date.parse(session.lastActivityAt);
      let idleExpiresAt = session.idleExpiresAt;
      if (Number.isFinite(lastActivity) && now - lastActivity >= SESSION_TOUCH_INTERVAL_MS) {
        const lastActivityAt = new Date(now).toISOString();
        idleExpiresAt = new Date(now + 15 * 60 * 1000).toISOString();
        await identityRepo.touchSession(sessionHash, lastActivityAt, idleExpiresAt);
      }

      // 5. Build immutable RequestContext
      if (staff.role === 'PHARMACY_STAFF') {
        const tenantScope: TenantScope = {
          kind: 'tenant',
          organisationId: staff.organisationId!,
          uid: staff.uid,
          email: staff.email,
          role: 'PHARMACY_STAFF',
          surface: 'pharmacy',
          sessionHash,
          requestId,
          idleExpiresAt,
          absoluteExpiresAt: session.absoluteExpiresAt,
        };
        request.context = tenantScope;
      } else {
        const platformScope: PlatformScope = {
          kind: 'platform',
          uid: staff.uid,
          email: staff.email,
          role: 'HHH_ADMIN',
          surface: 'admin',
          sessionHash,
          requestId,
          idleExpiresAt,
          absoluteExpiresAt: session.absoluteExpiresAt,
        };
        request.context = platformScope;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}
