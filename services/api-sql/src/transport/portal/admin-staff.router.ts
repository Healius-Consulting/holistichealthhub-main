import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { auth } from '../../bootstrap/firebase.js';
import { queueEmailToRecipients } from '../../application/notifications/email-outbox.js';
import { generateStaffPasswordResetLink } from '../../application/identity/password-reset-link.js';
import { HttpError } from '../../domain/common/errors.js';
import { SqlIdentityRepository } from '../../repositories/sql/identity.sql.js';
import { SqlNotificationRepository } from '../../repositories/sql/notification.sql.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { requireCsrf } from '../../security/csrf.js';
import { assertPlatformScope } from '../../security/request-context.js';
import { requireStaff } from '../../security/require-staff.js';
import { assertStaffCanBePharmacyOwner } from '../../application/identity/assign-pharmacy-owner.js';
import { resolveOwnerUid, staffInviteEmailKey, staffInviteResendEmailKey, toPortalPharmacyStaffAccounts, toPortalPlatformAdminAccounts } from './admin-staff-contracts.js';

const organisationIdSchema = z.string().regex(/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
const staffUidSchema = z.string().min(8).max(128);

const inviteStaffSchema = z.object({
  email: z.email().transform(value => value.toLowerCase()),
  displayName: z.string().trim().min(1).max(200),
  role: z.literal('pharmacy_staff'),
  organisationId: organisationIdSchema.optional(),
  pharmacyId: organisationIdSchema.optional(),
}).strict().transform(input => {
  const organisationId = input.organisationId ?? input.pharmacyId;
  if (!organisationId) {
    throw new HttpError(400, 'Select a pharmacy before inviting staff.', 'ORGANISATION_REQUIRED');
  }
  return {
    email: input.email,
    displayName: input.displayName,
    organisationId,
  };
});

const invitePlatformAdminSchema = z.object({
  email: z.email().transform(value => value.toLowerCase()),
  displayName: z.string().trim().min(1).max(200),
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

export function createAdminStaffRouter(): Router {
  const router = Router();
  const identityRepo = new SqlIdentityRepository();
  const notificationRepo = new SqlNotificationRepository();
  const organisationRepo = new SqlOrganisationRepository();

  router.get('/portal/admin/staff', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      const organisationId = organisationIdSchema.parse(req.query.organisationId);
      const organisation = await organisationRepo.findOrganisationById(organisationId);
      if (!organisation) {
        throw new HttpError(404, 'Pharmacy account not found.', 'NOT_FOUND');
      }
      const staff = await identityRepo.listPharmacyStaffByOrganisationId(organisationId);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(toPortalPharmacyStaffAccounts(organisationId, staff, organisation.primaryContactUid));
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/admin/staff/invitations', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const input = inviteStaffSchema.parse(req.body);
      const organisation = await organisationRepo.findOrganisationById(input.organisationId);
      if (!organisation) {
        throw new HttpError(404, 'Pharmacy account not found.', 'NOT_FOUND');
      }

      let user;
      let existingProfile = null;
      try {
        user = await auth.createUser({
          email: input.email,
          displayName: input.displayName,
          emailVerified: false,
          disabled: false,
        });
      } catch (error) {
        if (firebaseAuthErrorCode(error) !== 'auth/email-already-exists') throw error;
        user = await auth.getUserByEmail(input.email);
        existingProfile = await identityRepo.findStaffUser(user.uid);
        const existingRole = existingProfile?.role ?? (typeof user.customClaims?.role === 'string' ? user.customClaims.role.toUpperCase() : null);
        const existingOrganisationId = existingProfile?.organisationId ?? (typeof user.customClaims?.organisationId === 'string' ? user.customClaims.organisationId : null);
        if (existingRole !== 'PHARMACY_STAFF' || existingOrganisationId !== input.organisationId) {
          throw new HttpError(409, 'This email address already belongs to a different HHH account.', 'EMAIL_ALREADY_IN_USE');
        }
        if (existingProfile?.status === 'ACTIVE') {
          throw new HttpError(409, 'This staff account is already active. Use password reset if they cannot sign in.', 'STAFF_ALREADY_ACTIVE');
        }
      }

      await auth.setCustomUserClaims(user.uid, {
        role: 'pharmacy_staff',
        organisationId: input.organisationId,
      });

      const existingStaff = await identityRepo.listPharmacyStaffByOrganisationId(input.organisationId);
      const createdAt = existingProfile?.createdAt ?? new Date().toISOString();
      const assignedOwnerUid = organisation.primaryContactUid
        ?? (existingStaff.length === 0 ? user.uid : null);
      if (!organisation.primaryContactUid && existingStaff.length === 0) {
        await organisationRepo.updateOrganisationPrimaryContactUid(input.organisationId, user.uid);
      }
      const contactRole = user.uid === resolveOwnerUid([...existingStaff, { uid: user.uid, createdAt }], assignedOwnerUid)
        ? 'owner'
        : 'staff';

      await identityRepo.upsertStaffUser({
        uid: user.uid,
        organisationId: input.organisationId,
        email: input.email,
        displayName: input.displayName,
        role: 'PHARMACY_STAFF',
        status: 'INVITED',
        disabled: false,
      });

      const actionLink = await generateStaffPasswordResetLink(input.email);

      await identityRepo.appendAudit({
        organisationId: input.organisationId,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'staff.invited',
        recordType: 'StaffUser',
        recordId: user.uid,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
        details: { role: 'pharmacy_staff', contactRole, deliveryMode: 'outbox' },
      });
      const { queued } = await queueEmailToRecipients(
        notificationRepo,
        [{ email: input.email, displayName: input.displayName }],
        'pharmacy_staff_invite',
        {
          pharmacyName: organisation.tradingName || organisation.name,
          organisationId: organisation.id,
          actionLink,
        },
        staffInviteEmailKey({
          role: 'pharmacy_staff',
          uid: user.uid,
          organisationId: input.organisationId,
          existingInvite: Boolean(existingProfile),
          requestId: scope.requestId,
        }),
        { organisationId: input.organisationId },
      );

      res.status(201).json({
        uid: user.uid,
        email: input.email,
        displayName: input.displayName,
        role: 'pharmacy_staff',
        pharmacyId: input.organisationId,
        organisationId: input.organisationId,
        contactRole,
        status: 'invited',
        createdAt,
        invitationQueued: queued > 0,
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/portal/admin/staff/:uid', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const uid = staffUidSchema.parse(req.params.uid);
      const profile = await identityRepo.findStaffUser(uid);
      if (!profile || profile.role !== 'PHARMACY_STAFF' || !profile.organisationId) {
        throw new HttpError(404, 'Staff account not found.', 'STAFF_NOT_FOUND');
      }
      const organisation = await organisationRepo.findOrganisationById(profile.organisationId);
      if (!organisation) {
        throw new HttpError(404, 'Pharmacy account not found.', 'NOT_FOUND');
      }

      const activeStaff = await identityRepo.listPharmacyStaffByOrganisationId(profile.organisationId);
      const ownerUid = resolveOwnerUid(activeStaff, organisation.primaryContactUid);
      if (profile.uid === ownerUid) {
        throw new HttpError(409, 'The pharmacy owner account cannot be removed.', 'OWNER_ACCOUNT_PROTECTED');
      }

      await auth.updateUser(uid, { disabled: true });
      await auth.revokeRefreshTokens(uid);
      await identityRepo.updateStaffUserStatus(uid, 'REMOVED', true);

      await identityRepo.appendAudit({
        organisationId: profile.organisationId,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'staff.removed',
        recordType: 'StaffUser',
        recordId: uid,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
        details: { retainedForAudit: true },
      });

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/admin/staff/:uid/owner', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const uid = staffUidSchema.parse(req.params.uid);
      const profile = await identityRepo.findStaffUser(uid);
      assertStaffCanBePharmacyOwner(profile);
      const organisation = await organisationRepo.findOrganisationById(profile.organisationId);
      if (!organisation) {
        throw new HttpError(404, 'Pharmacy account not found.', 'NOT_FOUND');
      }

      await organisationRepo.updateOrganisationPrimaryContactUid(profile.organisationId, profile.uid);
      const staff = await identityRepo.listPharmacyStaffByOrganisationId(profile.organisationId);

      await identityRepo.appendAudit({
        organisationId: profile.organisationId,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'staff.owner_assigned',
        recordType: 'StaffUser',
        recordId: profile.uid,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
        details: { previousOwnerUid: organisation.primaryContactUid ?? resolveOwnerUid(staff) },
      });

      res.status(200).json(toPortalPharmacyStaffAccounts(profile.organisationId, staff, profile.uid));
    } catch (error) {
      next(error);
    }
  });

  router.get('/portal/admin/platform-admins', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      const admins = await identityRepo.listPlatformAdmins();
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(toPortalPlatformAdminAccounts(admins));
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/admin/platform-admins/invitations', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const input = invitePlatformAdminSchema.parse(req.body);

      let user;
      let existingProfile = null;
      try {
        user = await auth.createUser({
          email: input.email,
          displayName: input.displayName,
          emailVerified: false,
          disabled: false,
        });
      } catch (error) {
        if (firebaseAuthErrorCode(error) !== 'auth/email-already-exists') throw error;
        user = await auth.getUserByEmail(input.email);
        existingProfile = await identityRepo.findStaffUser(user.uid);
        const existingRole = existingProfile?.role ?? (typeof user.customClaims?.role === 'string' ? user.customClaims.role.toUpperCase() : null);
        const existingOrganisationId = existingProfile?.organisationId ?? (typeof user.customClaims?.organisationId === 'string' ? user.customClaims.organisationId : null);
        if (existingRole !== 'HHH_ADMIN' || existingOrganisationId !== null) {
          throw new HttpError(409, 'This email address already belongs to a different HHH account.', 'EMAIL_ALREADY_IN_USE');
        }
        if (existingProfile?.status === 'ACTIVE') {
          throw new HttpError(409, 'This admin account is already active. Use password reset if they cannot sign in.', 'STAFF_ALREADY_ACTIVE');
        }
      }

      await auth.setCustomUserClaims(user.uid, {
        role: 'hhh_admin',
        organisationId: null,
      });

      const createdAt = existingProfile?.createdAt ?? new Date().toISOString();

      await identityRepo.upsertStaffUser({
        uid: user.uid,
        organisationId: null,
        email: input.email,
        displayName: input.displayName,
        role: 'HHH_ADMIN',
        status: 'INVITED',
        disabled: false,
      });

      const actionLink = await generateStaffPasswordResetLink(input.email);

      await identityRepo.appendAudit({
        organisationId: null,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'staff.invited',
        recordType: 'StaffUser',
        recordId: user.uid,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
        details: { role: 'hhh_admin', deliveryMode: 'outbox' },
      });
      const { queued } = await queueEmailToRecipients(
        notificationRepo,
        [{ email: input.email, displayName: input.displayName }],
        'pharmacy_staff_invite',
        {
          pharmacyName: 'HHH admin workspace',
          actionLink,
        },
        staffInviteEmailKey({
          role: 'hhh_admin',
          uid: user.uid,
          existingInvite: Boolean(existingProfile),
          requestId: scope.requestId,
        }),
        {},
      );

      res.status(201).json({
        uid: user.uid,
        email: input.email,
        displayName: input.displayName,
        role: 'hhh_admin',
        status: 'invited',
        createdAt,
        invitationQueued: queued > 0,
      });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/portal/admin/platform-admins/:uid', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const uid = staffUidSchema.parse(req.params.uid);
      if (uid === scope.uid) {
        throw new HttpError(409, 'You cannot remove your own admin access.', 'SELF_REMOVAL_BLOCKED');
      }

      const profile = await identityRepo.findStaffUser(uid);
      if (!profile || profile.role !== 'HHH_ADMIN') {
        throw new HttpError(404, 'Admin account not found.', 'ADMIN_NOT_FOUND');
      }

      const activeAdmins = await identityRepo.listPlatformAdmins();
      if (activeAdmins.length <= 1) {
        throw new HttpError(409, 'At least one HHH admin account must remain active.', 'LAST_ADMIN_PROTECTED');
      }

      await auth.updateUser(uid, { disabled: true });
      await auth.revokeRefreshTokens(uid);
      await identityRepo.updateStaffUserStatus(uid, 'REMOVED', true);

      await identityRepo.appendAudit({
        organisationId: null,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'staff.removed',
        recordType: 'StaffUser',
        recordId: uid,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
        details: { role: 'hhh_admin', retainedForAudit: true },
      });

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/admin/staff/:uid/invitation-resend', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const uid = staffUidSchema.parse(req.params.uid);
      const profile = await identityRepo.findStaffUser(uid);
      if (!profile || profile.role !== 'PHARMACY_STAFF' || !profile.organisationId || profile.status === 'REMOVED') {
        throw new HttpError(404, 'Staff account not found.', 'STAFF_NOT_FOUND');
      }
      if (profile.status === 'ACTIVE') {
        throw new HttpError(409, 'This staff account is already active. Send a password reset instead.', 'STAFF_ALREADY_ACTIVE');
      }
      if (profile.disabled) {
        throw new HttpError(409, 'This staff account is disabled. Restore access before resending the invitation.', 'STAFF_DISABLED');
      }
      const organisation = await organisationRepo.findOrganisationById(profile.organisationId);
      if (!organisation) {
        throw new HttpError(404, 'Pharmacy account not found.', 'NOT_FOUND');
      }

      const actionLink = await generateStaffPasswordResetLink(profile.email);
      const { queued } = await queueEmailToRecipients(
        notificationRepo,
        [{ email: profile.email, displayName: profile.displayName }],
        'pharmacy_staff_invite',
        {
          pharmacyName: organisation.tradingName || organisation.name,
          organisationId: organisation.id,
          actionLink,
        },
        staffInviteResendEmailKey({
          role: 'pharmacy_staff',
          uid: profile.uid,
          organisationId: profile.organisationId,
          requestId: scope.requestId,
          issuedAt: Date.now(),
        }),
        { organisationId: profile.organisationId },
      );

      await identityRepo.appendAudit({
        organisationId: profile.organisationId,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'staff.invite_resent',
        recordType: 'StaffUser',
        recordId: profile.uid,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
        details: { role: 'pharmacy_staff', deliveryMode: 'outbox' },
      });

      res.status(200).json({ uid: profile.uid, email: profile.email, invitationQueued: queued > 0 });
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/admin/platform-admins/:uid/invitation-resend', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const uid = staffUidSchema.parse(req.params.uid);
      const profile = await identityRepo.findStaffUser(uid);
      if (!profile || profile.role !== 'HHH_ADMIN' || profile.status === 'REMOVED') {
        throw new HttpError(404, 'Admin account not found.', 'ADMIN_NOT_FOUND');
      }
      if (profile.status === 'ACTIVE') {
        throw new HttpError(409, 'This admin account is already active. Send a password reset instead.', 'STAFF_ALREADY_ACTIVE');
      }
      if (profile.disabled) {
        throw new HttpError(409, 'This admin account is disabled. Restore access before resending the invitation.', 'STAFF_DISABLED');
      }

      const actionLink = await generateStaffPasswordResetLink(profile.email);
      const { queued } = await queueEmailToRecipients(
        notificationRepo,
        [{ email: profile.email, displayName: profile.displayName }],
        'pharmacy_staff_invite',
        {
          pharmacyName: 'HHH admin workspace',
          actionLink,
        },
        staffInviteResendEmailKey({
          role: 'hhh_admin',
          uid: profile.uid,
          requestId: scope.requestId,
          issuedAt: Date.now(),
        }),
        {},
      );

      await identityRepo.appendAudit({
        organisationId: null,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'staff.invite_resent',
        recordType: 'StaffUser',
        recordId: profile.uid,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
        details: { role: 'hhh_admin', deliveryMode: 'outbox' },
      });

      res.status(200).json({ uid: profile.uid, email: profile.email, invitationQueued: queued > 0 });
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/admin/staff/:uid/password-reset-email', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const uid = staffUidSchema.parse(req.params.uid);
      const profile = await identityRepo.findStaffUser(uid);
      if (!profile || profile.role !== 'PHARMACY_STAFF' || !profile.organisationId) {
        throw new HttpError(404, 'Staff account not found.', 'STAFF_NOT_FOUND');
      }
      const organisation = await organisationRepo.findOrganisationById(profile.organisationId);
      if (!organisation) throw new HttpError(404, 'Pharmacy account not found.', 'NOT_FOUND');
      const actionLink = await generateStaffPasswordResetLink(profile.email);
      await queueEmailToRecipients(
        notificationRepo,
        [{ email: profile.email, displayName: profile.displayName }],
        'pharmacy_password_reset',
        {
          pharmacyName: organisation.tradingName || organisation.name,
          organisationId: organisation.id,
          actionLink,
        },
        ['pharmacy-password-reset', profile.uid, Date.now()],
        { organisationId: profile.organisationId },
      );
      await identityRepo.appendAudit({
        organisationId: profile.organisationId,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'staff.password_reset_queued',
        recordType: 'StaffUser',
        recordId: profile.uid,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
      });
      res.status(200).json({ uid: profile.uid, email: profile.email, resetQueued: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/admin/platform-admins/:uid/password-reset-email', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const uid = staffUidSchema.parse(req.params.uid);
      const profile = await identityRepo.findStaffUser(uid);
      if (!profile || profile.role !== 'HHH_ADMIN') {
        throw new HttpError(404, 'Admin account not found.', 'ADMIN_NOT_FOUND');
      }
      const actionLink = await generateStaffPasswordResetLink(profile.email);
      await queueEmailToRecipients(
        notificationRepo,
        [{ email: profile.email, displayName: profile.displayName }],
        'pharmacy_password_reset',
        {
          pharmacyName: 'HHH admin workspace',
          actionLink,
        },
        ['platform-admin-password-reset', profile.uid, Date.now()],
        {},
      );
      await identityRepo.appendAudit({
        organisationId: null,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'staff.password_reset_queued',
        recordType: 'StaffUser',
        recordId: profile.uid,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
      });
      res.status(200).json({ uid: profile.uid, email: profile.email, resetQueued: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/admin/staff/:uid/mfa-reset', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const uid = staffUidSchema.parse(req.params.uid);
      z.object({
        verifiedIdentity: z.literal(true),
        reason: z.string().trim().min(20).max(500),
      }).parse(req.body);
      const profile = await identityRepo.findStaffUser(uid);
      if (!profile || profile.disabled || profile.status === 'REMOVED') {
        throw new HttpError(404, 'Staff account not found.', 'STAFF_NOT_FOUND');
      }
      await auth.updateUser(uid, { multiFactor: { enrolledFactors: [] } });
      await auth.revokeRefreshTokens(uid);
      const organisation = profile.organisationId
        ? await organisationRepo.findOrganisationById(profile.organisationId)
        : null;
      await queueEmailToRecipients(
        notificationRepo,
        [{ email: profile.email, displayName: profile.displayName }],
        'pharmacy_2fa_disabled',
        {
          pharmacyName: profile.role === 'HHH_ADMIN'
            ? 'HHH admin workspace'
            : organisation?.tradingName || organisation?.name || 'the pharmacy',
          organisationId: organisation?.id || '',
        },
        ['pharmacy-2fa-disabled', profile.uid, Date.now()],
        { organisationId: profile.organisationId },
      );
      await identityRepo.appendAudit({
        organisationId: profile.organisationId,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'staff.mfa_reset',
        recordType: 'StaffUser',
        recordId: profile.uid,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
      });
      res.status(200).json({ uid: profile.uid, resetQueued: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
