import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { HttpError } from '../../domain/common/errors.js';
import { asUuid, sameUuid } from '../../domain/common/uuid.js';
import type { PlatformSubmissionRecord } from '../../repositories/ports/intake.port.js';
import { SqlIdentityRepository } from '../../repositories/sql/identity.sql.js';
import { SqlIntakeRepository } from '../../repositories/sql/intake.sql.js';
import { SqlNotificationRepository } from '../../repositories/sql/notification.sql.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { listPharmacyRecipients, pharmacyEmailContext, queueEmailToRecipients } from '../../application/notifications/email-outbox.js';
import { canActivateReferredPatient, canReceiveReferral } from '../../domain/organisation/access.js';
import { requireCsrf } from '../../security/csrf.js';
import { assertPlatformScope } from '../../security/request-context.js';
import { requireStaff } from '../../security/require-staff.js';
import { isDedicatedSqlIntake, isOpenSqlIntake, toAdminIntakeDetail, toAdminIntakeQueueItem } from './intake-contracts.js';

export { canReceiveReferral };

const caseIdSchema = z.string().regex(/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
export const queueQuerySchema = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  __hhh_surface: z.literal('admin').optional(),
}).strict();

const assignmentReasonSchema = z.enum([
  'patient_preference',
  'capacity',
  'delivery_or_collection',
  'geographic_coverage',
  'service_compatibility',
  'administrative_correction',
]);
const pendingAssignmentSchema = z.object({
  destinationOrganisationId: caseIdSchema,
  reasonCode: assignmentReasonSchema,
  note: z.string().trim().max(1500).nullable().default(null),
  expectedVersion: z.number().int().nonnegative(),
}).strict();
const followUpStatusSchema = z.enum(['not_started', 'due', 'attempted', 'in_progress', 'completed', 'unable_to_contact']);
const followUpSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  followUpStatus: followUpStatusSchema,
}).strict();
const onboardingSchema = z.object({
  expectedVersion: z.number().int().nonnegative(),
  decision: z.enum(['approved', 'declined']),
  notes: z.string().trim().max(1500).nullable(),
}).strict();

function page(records: PlatformSubmissionRecord[], request: Request) {
  const { cursor, limit } = queueQuerySchema.parse(request.query);
  const projected = records.map(toAdminIntakeQueueItem);
  let offset = 0;
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { id?: unknown };
      if (typeof decoded.id !== 'string') throw new Error('Missing cursor record.');
      const position = projected.findIndex(record => record.id === decoded.id);
      if (position < 0) throw new Error('Unknown cursor record.');
      offset = position + 1;
    } catch {
      throw new HttpError(400, 'The queue cursor is invalid.', 'INVALID_CURSOR');
    }
  }
  const recordsPage = projected.slice(offset, offset + limit);
  const hasMore = offset + recordsPage.length < projected.length;
  return {
    records: recordsPage,
    nextCursor: hasMore && recordsPage.length
      ? Buffer.from(JSON.stringify({ id: recordsPage.at(-1)!.id })).toString('base64url')
      : null,
  };
}

function assertPending(record: PlatformSubmissionRecord) {
  if (record.pharmacyAccessStatus !== 'WITHHELD' || record.outcomeStatus !== 'OPEN') {
    throw new HttpError(409, 'This intake has already left the protected HHH queue.', 'INTAKE_NOT_PENDING');
  }
}

export function createPortalIntakeV2Router(): Router {
  const router = Router();
  const intakeRepo = new SqlIntakeRepository();
  const organisationRepo = new SqlOrganisationRepository();
  const identityRepo = new SqlIdentityRepository();
  const notificationRepo = new SqlNotificationRepository();

  const queue = (source: 'general' | 'pharmacy') => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const submissions = (await intakeRepo.listPlatformSubmissions())
        .filter(isOpenSqlIntake)
        .filter(record => source === 'general' ? !isDedicatedSqlIntake(record.sourceType) : isDedicatedSqlIntake(record.sourceType))
        .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
      await identityRepo.appendAudit({
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'eligibility.admin_queue_viewed',
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: 'admin',
        details: { source, resultCount: submissions.length },
      });
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(page(submissions, req));
    } catch (error) {
      next(error);
    }
  };

  router.get('/portal/admin/intake/general', requireStaff('admin'), queue('general'));
  router.get('/portal/admin/intake/pharmacy-referrals', requireStaff('admin'), queue('pharmacy'));

  router.get('/portal/admin/intake/:caseId', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const caseId = caseIdSchema.parse(req.params.caseId);
      const record = await intakeRepo.findSubmissionById(caseId) as PlatformSubmissionRecord | null;
      if (!record) throw new HttpError(404, 'The requested record was not found.', 'NOT_FOUND');
      const [conditions, organisations] = await Promise.all([
        intakeRepo.listSubmissionConditions(caseId),
        organisationRepo.listOrganisations(),
      ]);
      const names = new Map(organisations.map(organisation => [organisation.id, organisation.tradingName || organisation.name]));
      await identityRepo.appendAudit({
        organisationId: record.assignedOrganisationId,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'eligibility.admin_detail_viewed',
        recordType: 'EligibilitySubmission',
        recordId: record.id,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: 'admin',
      });
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json(toAdminIntakeDetail(record, conditions, names));
    } catch (error) {
      next(error);
    }
  });

  router.get('/portal/admin/intake/:caseId/assignment-candidates', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      const caseId = caseIdSchema.parse(req.params.caseId);
      const query = z.string().trim().max(100).catch('').parse(req.query.q).toLowerCase();
      const record = await intakeRepo.findSubmissionById(caseId) as PlatformSubmissionRecord | null;
      if (!record) throw new HttpError(404, 'The requested record was not found.', 'NOT_FOUND');
      assertPending(record);
      const organisations = (await organisationRepo.listOrganisations())
        .filter(canReceiveReferral)
        .filter(organisation => !query || `${organisation.tradingName} ${organisation.gphcNumber} ${organisation.address}`.toLowerCase().includes(query))
        .map(organisation => ({
          id: organisation.id,
          tradingName: organisation.tradingName || organisation.name,
          gphcNumber: organisation.gphcNumber,
          address: organisation.address,
          intakeState: 'available',
          workspaceClassification: organisation.classification.toLowerCase(),
        }));
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ records: organisations });
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/admin/intake/:caseId/reassign', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const caseId = asUuid(caseIdSchema.parse(req.params.caseId));
      const input = pendingAssignmentSchema.parse(req.body);
      const destinationOrganisationId = asUuid(input.destinationOrganisationId);
      const [record, destination] = await Promise.all([
        intakeRepo.findSubmissionById(caseId) as Promise<PlatformSubmissionRecord | null>,
        organisationRepo.findOrganisationById(destinationOrganisationId),
      ]);
      if (!record) throw new HttpError(404, 'The requested record was not found.', 'NOT_FOUND');
      assertPending(record);
      if (record.assignmentVersion !== input.expectedVersion) {
        throw new HttpError(409, 'This intake changed. Refresh before moving it.', 'VERSION_CONFLICT');
      }
      if (!canReceiveReferral(destination)) {
        throw new HttpError(409, 'The selected pharmacy is not currently eligible to receive referrals.', 'DESTINATION_UNAVAILABLE');
      }
      if (sameUuid(record.assignedOrganisationId, destinationOrganisationId)) {
        throw new HttpError(409, 'This pharmacy is already the current pending destination.', 'DESTINATION_UNCHANGED');
      }
      const newVersion = record.assignmentVersion + 1;
      await intakeRepo.reassignPendingSubmission({
        id: caseId,
        newOrganisationId: destinationOrganisationId,
        expectedAssignmentVersion: record.assignmentVersion,
        newAssignmentVersion: newVersion,
        actorUid: scope.uid,
        reasonCode: input.reasonCode,
        note: input.note,
      });
      await identityRepo.appendAudit({
        organisationId: destinationOrganisationId,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'eligibility.pending_destination_changed',
        recordType: 'EligibilitySubmission',
        recordId: caseId,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: 'admin',
        details: {
          previousOrganisationId: record.assignedOrganisationId,
          newOrganisationId: destinationOrganisationId,
          reasonCode: input.reasonCode,
          notePresent: Boolean(input.note),
          sourceOrganisationId: record.sourceOrganisationId,
        },
      });
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ id: caseId, assignedOrganisationId: destinationOrganisationId, assignmentVersion: newVersion, pharmacyAccessStatus: 'withheld' });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/portal/admin/intake/:caseId/follow-up', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const caseId = caseIdSchema.parse(req.params.caseId);
      const input = followUpSchema.parse(req.body);
      const record = await intakeRepo.findSubmissionById(caseId) as PlatformSubmissionRecord | null;
      if (!record) throw new HttpError(404, 'The requested record was not found.', 'NOT_FOUND');
      assertPending(record);
      if (record.assignmentVersion !== input.expectedVersion) {
        throw new HttpError(409, 'This intake changed. Refresh before saving the review status.', 'VERSION_CONFLICT');
      }
      const newVersion = record.assignmentVersion + 1;
      await intakeRepo.updateSubmissionFollowUp({
        id: caseId,
        expectedAssignmentVersion: record.assignmentVersion,
        newAssignmentVersion: newVersion,
        followUpStatus: input.followUpStatus.toUpperCase() as 'NOT_STARTED' | 'DUE' | 'ATTEMPTED' | 'IN_PROGRESS' | 'COMPLETED' | 'UNABLE_TO_CONTACT',
      });
      await identityRepo.appendAudit({
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'eligibility.hhh_review_status_changed',
        recordType: 'EligibilitySubmission',
        recordId: caseId,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: 'admin',
        details: { followUpStatus: input.followUpStatus },
      });
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ id: caseId, followUpStatus: input.followUpStatus, assignmentVersion: newVersion });
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/admin/intake/:caseId/programme-onboarding', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const caseId = caseIdSchema.parse(req.params.caseId);
      const input = onboardingSchema.parse(req.body);
      const record = await intakeRepo.findSubmissionById(caseId) as PlatformSubmissionRecord | null;
      if (!record) throw new HttpError(404, 'The requested record was not found.', 'NOT_FOUND');
      assertPending(record);
      if (record.assignmentVersion !== input.expectedVersion) {
        throw new HttpError(409, 'This intake changed. Refresh before recording the decision.', 'VERSION_CONFLICT');
      }
      const newVersion = record.assignmentVersion + 1;
      if (input.decision === 'declined') {
        await intakeRepo.declineSubmission({
          id: caseId,
          expectedAssignmentVersion: record.assignmentVersion,
          newAssignmentVersion: newVersion,
          onboardingNote: input.notes,
        });
        await identityRepo.appendAudit({
          organisationId: record.assignedOrganisationId,
          actorUid: scope.uid,
          actorRole: scope.role,
          event: 'eligibility.programme_onboarding_declined',
          recordType: 'EligibilitySubmission',
          recordId: caseId,
          requestId: scope.requestId,
          sessionHashPrefix: scope.sessionHash.slice(0, 12),
          surface: 'admin',
          details: { notePresent: Boolean(input.notes) },
        });
        res.setHeader('Cache-Control', 'no-store');
        res.status(200).json({ id: caseId, decision: 'declined', assignmentVersion: newVersion });
        return;
      }
      if (!record.assignedOrganisationId) {
        throw new HttpError(409, 'Choose and save a pharmacy before completing the referral.', 'DESTINATION_REQUIRED');
      }
      if (record.followUpStatus !== 'COMPLETED') {
        throw new HttpError(409, 'Complete the HHH review before activating the pharmacy patient record.', 'FOLLOW_UP_REQUIRED');
      }
      if (!record.referralConsent || !record.dataSharingConsent) {
        throw new HttpError(409, 'Required referral and data-sharing consent is not recorded.', 'CONSENT_REQUIRED');
      }
      const destination = await organisationRepo.findOrganisationById(record.assignedOrganisationId);
      if (!canActivateReferredPatient(destination)) {
        throw new HttpError(409, 'The selected pharmacy cannot receive the patient record until it is live.', 'DESTINATION_UNAVAILABLE');
      }
      const patientId = randomUUID();
      await intakeRepo.activateSubmission({
        id: caseId,
        patientId,
        organisationId: record.assignedOrganisationId,
        expectedAssignmentVersion: record.assignmentVersion,
        newAssignmentVersion: newVersion,
        firstName: record.firstName,
        surname: record.surname,
        dob: record.dob,
        email: record.email,
        emailHash: record.emailHash,
        mobile: record.mobile,
        postcode: record.postcode,
        onboardingNote: input.notes,
      });
      await intakeRepo.copySubmissionConditionsToPatient(patientId, caseId);
      await identityRepo.appendAudit({
        organisationId: record.assignedOrganisationId,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'eligibility.referral_activated',
        recordType: 'EligibilitySubmission',
        recordId: caseId,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: 'admin',
        details: { patientId, notePresent: Boolean(input.notes), sourceOrganisationId: record.sourceOrganisationId },
      });
      const pharmacyRecipients = canActivateReferredPatient(destination)
        ? await listPharmacyRecipients(record.assignedOrganisationId, { identityRepo, organisationRepo })
        : [];
      const pharmacyContext = pharmacyEmailContext(destination);
      await queueEmailToRecipients(
        notificationRepo,
        pharmacyRecipients,
        'pharmacy_new_patient_referred',
        {
          caseReference: record.id,
          ...pharmacyContext,
        },
        ['pharmacy-referred', record.id, record.assignedOrganisationId],
        { organisationId: record.assignedOrganisationId, patientId },
      );
      if (record.email) {
        await queueEmailToRecipients(
          notificationRepo,
          [{ email: record.email, displayName: record.firstName || null }],
          'patient_referred',
          {
            firstName: record.firstName || 'there',
            ...pharmacyContext,
          },
          ['patient-referred', record.id, record.assignedOrganisationId],
          { organisationId: record.assignedOrganisationId, patientId },
        );
      }
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ id: caseId, decision: 'approved', patientId, assignmentVersion: newVersion });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
