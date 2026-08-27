import type { NextFunction, Request, Response } from 'express';
import { auth } from '../bootstrap/firebase.js';
import { secureSessionCookies } from '../bootstrap/config.js';
import { HttpError } from '../domain/common/errors.js';
import { SqlIdentityRepository } from '../repositories/sql/identity.sql.js';
import { validatePortalAdmission } from './admission.js';
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

      if (failure) {
        // A 401 stays deliberately generic: the session itself is the thing in doubt.
        // A 403 is an authenticated staff member hitting a permission wall, and
        // "Session admission failed." reads as a scary auth outage instead of the
        // plain "your role cannot do this" that it actually is.
        const message = failure.status === 403
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
