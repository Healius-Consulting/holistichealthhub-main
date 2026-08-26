import { auth } from '../../bootstrap/firebase.js';
import { HttpError } from '../../domain/common/errors.js';
import { SqlIdentityRepository } from '../../repositories/sql/identity.sql.js';
import type { PlatformScope, ProtectedSurface, StaffRole, TenantScope } from '../../security/request-context.js';
import {
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  sha256,
} from '../../security/session-utils.js';

export interface CreateSessionResult {
  sessionCookie: string;
  sessionHash: string;
  uid: string;
  email: string;
  displayName: string;
  role: StaffRole;
  organisationId: string | null;
  surface: ProtectedSurface;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}

export class SessionService {
  constructor(private readonly identityRepo = new SqlIdentityRepository()) {}

  async createSession(params: {
    idToken: string;
    requestedSurface: ProtectedSurface | 'auto';
    userAgent: string;
  }): Promise<CreateSessionResult> {
    const { idToken, requestedSurface, userAgent } = params;

    // 1. Verify ID token with Firebase Auth
    const decoded = await auth.verifyIdToken(idToken, true);

    // 2. Validate recent login age (max 5 minutes)
    const authAgeMs = Date.now() - decoded.auth_time * 1000;
    if (authAgeMs < 0 || authAgeMs > 5 * 60 * 1000) {
      throw new HttpError(401, 'Sign in again before starting a staff session.', 'RECENT_LOGIN_REQUIRED');
    }

    // 3. Validate email verification and TOTP MFA
    if (!decoded.email_verified) {
      throw new HttpError(403, 'Verify your email before using the staff portal.', 'EMAIL_NOT_VERIFIED');
    }
    const secondFactor = (decoded.firebase as Record<string, unknown> | undefined)?.sign_in_second_factor;
    if (secondFactor !== 'totp') {
      throw new HttpError(403, 'A TOTP second-factor sign-in is required.', 'MFA_TOTP_REQUIRED');
    }

    // 4. Resolve surface & role
    const rawRole = (typeof decoded.role === 'string' ? decoded.role.toUpperCase() : '') as StaffRole;
    if (rawRole !== 'HHH_ADMIN' && rawRole !== 'PHARMACY_STAFF') {
      throw new HttpError(403, 'The account has no permitted staff role.', 'ROLE_REQUIRED');
    }

    const surface: ProtectedSurface = requestedSurface === 'auto'
      ? (rawRole === 'HHH_ADMIN' ? 'admin' : 'pharmacy')
      : requestedSurface;

    if (surface === 'admin' && rawRole !== 'HHH_ADMIN') {
      throw new HttpError(403, 'This account cannot access HHH administration.', 'FORBIDDEN');
    }
    if (surface === 'pharmacy' && rawRole !== 'PHARMACY_STAFF') {
      throw new HttpError(403, 'This account cannot access the pharmacy workspace.', 'FORBIDDEN');
    }

    // 5. Query SQL for active staff user
    let staff = await this.identityRepo.findStaffUser(decoded.uid);
    if (!staff || staff.disabled || staff.status === 'DISABLED' || staff.status === 'REMOVED') {
      throw new HttpError(403, 'This staff account has been disabled.', 'ACCOUNT_DISABLED');
    }
    if (staff.status === 'INVITED') {
      const activated = await this.identityRepo.activateInvitedStaffUser(decoded.uid);
      if (activated) {
        staff = { ...staff, status: 'ACTIVE' };
        await this.identityRepo.appendAudit({
          organisationId: staff.organisationId,
          actorUid: decoded.uid,
          actorRole: staff.role,
          event: 'staff.activated_after_totp',
          recordType: 'StaffUser',
          recordId: decoded.uid,
          surface,
        });
      } else {
        staff = await this.identityRepo.findStaffUser(decoded.uid);
      }
    }
    if (!staff || staff.status !== 'ACTIVE') {
      throw new HttpError(403, 'This staff account is not active.', 'ACCOUNT_INACTIVE');
    }

    const organisationId = staff.organisationId;
    if (rawRole === 'PHARMACY_STAFF' && !organisationId) {
      throw new HttpError(403, 'The account is not assigned to a pharmacy.', 'TENANT_REQUIRED');
    }

    // 6. Create Firebase session cookie
    const sessionCookie = await auth.createSessionCookie(idToken, { expiresIn: SESSION_ABSOLUTE_MS });
    const sessionHash = sha256(sessionCookie);
    const now = Date.now();
    const idleExpiresAt = new Date(now + SESSION_IDLE_MS).toISOString();
    const absoluteExpiresAt = new Date(now + SESSION_ABSOLUTE_MS).toISOString();

    // 7. Persist session to PostgreSQL via SQL Connect
    await this.identityRepo.createSession({
      sessionHash,
      staffUid: decoded.uid,
      organisationId,
      surface,
      role: rawRole,
      userAgentHash: sha256(userAgent),
      lastActivityAt: new Date(now).toISOString(),
      idleExpiresAt,
      absoluteExpiresAt,
    });

    // 8. Security audit log
    await this.identityRepo.appendAudit({
      organisationId,
      actorUid: decoded.uid,
      actorRole: rawRole,
      event: 'auth.session_created',
      surface,
      sessionHashPrefix: sessionHash.slice(0, 12),
    });

    return {
      sessionCookie,
      sessionHash,
      uid: decoded.uid,
      email: decoded.email ?? '',
      displayName: staff.displayName || decoded.email || 'Staff User',
      role: rawRole,
      organisationId,
      surface,
      idleExpiresAt,
      absoluteExpiresAt,
    };
  }

  async getSessionPayload(context: TenantScope | PlatformScope) {
    const staff = await this.identityRepo.findStaffUser(context.uid);
    return {
      uid: context.uid,
      email: context.email ?? '',
      displayName: staff?.displayName ?? context.email ?? 'Staff User',
      role: context.role.toLowerCase(),
      organisationId: context.kind === 'tenant' ? context.organisationId : null,
      surface: context.surface,
      idleExpiresAt: context.idleExpiresAt,
      absoluteExpiresAt: context.absoluteExpiresAt,
    };
  }

  async revokeSession(sessionHash: string, reason = 'logout'): Promise<void> {
    const revokedAt = new Date().toISOString();
    await this.identityRepo.revokeSession(sessionHash, revokedAt, reason);
  }
}
