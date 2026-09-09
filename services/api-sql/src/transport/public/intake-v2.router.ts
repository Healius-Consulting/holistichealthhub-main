import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { ELIGIBILITY_CONDITION_IDS } from '../../domain/eligibility/conditions.js';
import { HttpError } from '../../domain/common/errors.js';
import { PRIVACY_NOTICE_VERSION } from '../../domain/legal/notice-version.js';
import { isEligibleAge } from '../../domain/eligibility/age.js';
import { screeningFlagFor } from '../../domain/eligibility/screening.js';
import { TERMS_VERSION } from '../../domain/legal/notice-version.js';
import { asUuid, uuidKey } from '../../domain/common/uuid.js';
import { normaliseUkPostcode } from '../../domain/geography/postcode.js';
import { SqlIdentityRepository } from '../../repositories/sql/identity.sql.js';
import { SqlIntakeRepository } from '../../repositories/sql/intake.sql.js';
import { SqlNotificationRepository } from '../../repositories/sql/notification.sql.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { SqlPostcodeSearchRepository } from '../../repositories/sql/postcode-search.sql.js';
import { publicReferralResolveLimiter, publicSubmissionLimiter } from '../../security/public-limits.js';
import { ipHash, sha256 } from '../../security/session-utils.js';
import type { CreateSubmissionInput } from '../../repositories/ports/intake.port.js';
import { dispatchEmailEvent } from '../../application/notifications/email-dispatch.js';
import { pharmacyEmailContext } from '../../application/notifications/email-outbox.js';
import { resolveWebsiteAssignedPharmacy } from '../../domain/intake/website-assignment.js';
import { attachPublicPharmacyLogo } from '../../application/organisation/public-pharmacy-logo.js';
import { attachPublicPharmacyContacts } from '../../application/organisation/public-pharmacy-contacts.js';
import { SqlDirectoryRepository } from '../../repositories/sql/directory.sql.js';
import { StorageProvider } from '../../providers/storage/storage.provider.js';

export const referralTokenSchema = z.string().min(12).max(160).regex(/^[A-Za-z0-9_-]+$/);
const opaqueIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const conditionIdSchema = z.enum(ELIGIBILITY_CONDITION_IDS);

const answersSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  surname: z.string().trim().min(1).max(100),
  dob: z.iso.date().refine(value => isEligibleAge(value), {
    message: 'You must be 18 or over to apply.',
  }),
  mobile: z.string().trim().min(7).max(30),
  email: z.email().max(254),
  postcode: z.string().trim().min(2).max(16),
  conditions: z.array(conditionIdSchema).min(1).max(3),
  primaryCondition: conditionIdSchema,
  tried2: z.boolean(),
  psychExclusion: z.boolean(),
  consentReferral: z.literal(true),
  consentShare: z.literal(true),
  marketing: z.boolean().default(false),
  heardAbout: z.string().trim().min(1).max(100),
  consentVersion: z.enum(['general-public-v2.0', 'pharmacy-qr-v2.0', 'general-public-v2.1', 'pharmacy-qr-v2.1', 'general-public-v2.2', 'pharmacy-qr-v2.2']),
  idempotencyKey: z.string().uuid(),
});

export const fixedPharmacyIntakeSchema = answersSchema.extend({
  type: z.literal('future_pharmacy_qr'),
  referralToken: referralTokenSchema,
  consentVersion: z.enum(['pharmacy-qr-v2.0', 'pharmacy-qr-v2.1', 'pharmacy-qr-v2.2']),
}).strict().refine(input => new Set(input.conditions).size === input.conditions.length, {
  path: ['conditions'],
  message: 'Conditions must be unique.',
}).refine(input => input.conditions.includes(input.primaryCondition), {
  path: ['primaryCondition'],
  message: 'Primary condition must be one of the selected conditions.',
});

export const generalWebsiteIntakeSchema = answersSchema.extend({
  type: z.literal('general_hhh_website'),
  searchId: opaqueIdSchema,
  selectedDirectoryProfileId: opaqueIdSchema.nullable(),
  consentVersion: z.enum(['general-public-v2.0', 'general-public-v2.1', 'general-public-v2.2']),
}).strict().refine(input => new Set(input.conditions).size === input.conditions.length, {
  path: ['conditions'],
  message: 'Conditions must be unique.',
}).refine(input => input.conditions.includes(input.primaryCondition), {
  path: ['primaryCondition'],
  message: 'Primary condition must be one of the selected conditions.',
});

export const intakeSchema = z.discriminatedUnion('type', [
  answersSchema.extend({ type: z.literal('general_hhh_website'), searchId: opaqueIdSchema, selectedDirectoryProfileId: opaqueIdSchema.nullable() }),
  answersSchema.extend({ type: z.literal('future_pharmacy_qr'), referralToken: referralTokenSchema }),
]).refine(input => input.conditions.includes(input.primaryCondition), {
  path: ['primaryCondition'],
  message: 'Primary condition must be one of the selected conditions.',
}).refine(input => new Set(input.conditions).size === input.conditions.length, {
  path: ['conditions'],
  message: 'Conditions must be unique.',
}).refine(input => (
  input.type === 'general_hhh_website'
    ? input.consentVersion.startsWith('general-public-')
    : input.consentVersion.startsWith('pharmacy-qr-')
), {
  path: ['consentVersion'],
  message: 'Consent version does not match intake source.',
});

const resolveTokenSchema = z.object({
  token: referralTokenSchema,
}).strict();

export function caseReference(id: string, submittedAt: string) {
  const day = submittedAt.slice(0, 10).replaceAll('-', '');
  return `HHH-${day}-${id.replaceAll('-', '').slice(0, 8).toUpperCase()}`;
}

function answersPayload(input: z.infer<typeof intakeSchema>, assignment: {
  sourceOrganisationId?: string | null;
  assignedOrganisationId?: string | null;
  sourceType: CreateSubmissionInput['sourceType'];
  assignmentStatus: CreateSubmissionInput['assignmentStatus'];
  submissionIpHash: string;
}): CreateSubmissionInput {
  // A failed screening check is a flag for HHH admin, never a decision made here.
  const screeningFlag = screeningFlagFor({
    triedTwoTreatments: input.tried2,
    psychiatricExclusion: input.psychExclusion,
  });
  return {
    sourceOrganisationId: assignment.sourceOrganisationId ? asUuid(assignment.sourceOrganisationId) : null,
    assignedOrganisationId: assignment.assignedOrganisationId ? asUuid(assignment.assignedOrganisationId) : null,
    sourceType: assignment.sourceType,
    firstName: input.firstName,
    surname: input.surname,
    dob: input.dob,
    mobile: input.mobile,
    email: input.email.trim().toLowerCase(),
    emailHash: sha256(input.email.trim().toLowerCase()),
    postcode: input.postcode.trim().toUpperCase(),
    triedTwoTreatments: input.tried2,
    psychiatricExclusion: input.psychExclusion,
    heardAbout: input.heardAbout,
    conditionCodes: input.conditions,
    primaryConditionCode: input.primaryCondition,
    idempotencyKeyHash: sha256(input.idempotencyKey),
    assignmentStatus: assignment.assignmentStatus,
    pharmacyAccessStatus: 'WITHHELD',
    consentVersion: input.consentVersion,
    referralConsent: input.consentReferral,
    dataSharingConsent: input.consentShare,
    marketingConsent: input.marketing,
    privacyNoticeVersion: PRIVACY_NOTICE_VERSION,
    termsVersion: TERMS_VERSION,
    referralConsentVersion: input.consentVersion,
    dataSharingConsentVersion: input.consentVersion,
    // Recorded only when they opted in; an unticked box has no consent to version.
    marketingConsentVersion: input.marketing ? input.consentVersion : null,
    submissionIpHash: assignment.submissionIpHash,
    outcomeStatus: 'OPEN',
    declineRule: screeningFlag,
    declinedAt: null,
  };
}

export function createPublicIntakeV2Router(): Router {
  const router = Router();
  const organisationRepo = new SqlOrganisationRepository();
  const intakeRepo = new SqlIntakeRepository();
  const identityRepo = new SqlIdentityRepository();
  const notificationRepo = new SqlNotificationRepository();
  const searchRepo = new SqlPostcodeSearchRepository();
  const directoryRepo = new SqlDirectoryRepository();
  const storage = new StorageProvider();

  router.post('/public/referral-tokens/resolve', publicReferralResolveLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = resolveTokenSchema.parse(req.body);
      const resolution = await organisationRepo.findDirectoryByTokenHash(sha256(token));
      if (!resolution) throw new HttpError(404, 'Pharmacy link not found.', 'NOT_FOUND');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({
        ...resolution,
        pharmacy: await attachPublicPharmacyContacts(
          directoryRepo,
          await attachPublicPharmacyLogo(storage, resolution.pharmacy),
        ),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/public/intakes', publicSubmissionLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = intakeSchema.parse(req.body);
      const screeningFlag = screeningFlagFor({
        triedTwoTreatments: input.tried2,
        psychiatricExclusion: input.psychExclusion,
      });
      let sourceOrganisationId: string | null = null;
      let assignedOrganisationId: string | null = null;
      let sourceType: CreateSubmissionInput['sourceType'] = 'GENERAL_HHH_WEBSITE';
      let assignmentStatus: CreateSubmissionInput['assignmentStatus'] = 'AWAITING_HHH_ALLOCATION';
      let provisionalPharmacyName: string | null = null;

      if (input.type === 'future_pharmacy_qr') {
        const resolution = await organisationRepo.findDirectoryByTokenHash(sha256(input.referralToken));
        if (!resolution || resolution.intakeVersion !== 'v2') {
          throw new HttpError(404, 'Pharmacy link not found.', 'NOT_FOUND');
        }
        sourceOrganisationId = resolution.pharmacy.id;
        assignedOrganisationId = resolution.pharmacy.id;
        sourceType = 'PHARMACY_QR';
        assignmentStatus = 'PROVISIONAL';
        provisionalPharmacyName = resolution.pharmacy.name;
      } else {
        const search = await searchRepo.findSessionById(asUuid(input.searchId));
        if (!search || Date.parse(search.expiresAt) <= Date.now()) {
          throw new HttpError(409, 'The postcode search has expired. Search again.', 'SEARCH_EXPIRED');
        }
        if (normaliseUkPostcode(input.postcode) !== search.postcode) {
          throw new HttpError(409, 'The postcode changed. Search again.', 'SEARCH_POSTCODE_MISMATCH');
        }
        if (input.selectedDirectoryProfileId) {
          const selectedKey = uuidKey(input.selectedDirectoryProfileId);
          const allowed = (search.resultOrganisationIds ?? []).some((id) => uuidKey(id) === selectedKey);
          if (!allowed) throw new HttpError(400, 'Select a pharmacy from the current search.', 'INVALID_SELECTION');
          const organisation = resolveWebsiteAssignedPharmacy(
            await organisationRepo.findOrganisationById(asUuid(input.selectedDirectoryProfileId)),
          );
          if (!organisation) {
            throw new HttpError(400, 'That pharmacy is no longer available. Search again and choose another.', 'SELECTED_PHARMACY_UNAVAILABLE');
          }
          sourceOrganisationId = organisation.id;
          assignedOrganisationId = organisation.id;
          assignmentStatus = 'PROVISIONAL';
          provisionalPharmacyName = organisation.name;
        }
      }

      const idempotencyKeyHash = sha256(input.idempotencyKey);
      let submission = await intakeRepo.findSubmissionByIdempotencyHash(idempotencyKeyHash);
      let created = false;

      if (!submission) {
        const result = await intakeRepo.createSubmission(answersPayload(input, {
          sourceOrganisationId,
          assignedOrganisationId,
          sourceType,
          assignmentStatus,
          submissionIpHash: ipHash(req),
        }));
        if (!result.id) throw new Error('Eligibility submission did not return an identifier.');
        submission = await intakeRepo.findSubmissionById(result.id);
        if (!submission) throw new Error('Eligibility submission could not be verified after creation.');
        created = true;
      }

      await intakeRepo.saveSubmissionConditions(submission.id, input.conditions, input.primaryCondition);

      if (created) {
        await identityRepo.appendAudit({
          organisationId: assignedOrganisationId ?? sourceOrganisationId,
          event: 'eligibility.submitted',
          recordType: 'EligibilitySubmission',
          recordId: submission.id,
          surface: 'public',
          details: { sourceType, conditionCount: input.conditions.length, screeningFlag },
        });
        const caseRef = caseReference(submission.id, submission.submittedAt || new Date().toISOString());
        const assignedOrganisation = assignedOrganisationId
          ? await organisationRepo.findOrganisationById(assignedOrganisationId)
          : null;
        await dispatchEmailEvent('enquiry.submitted', {
          notificationRepo,
          identityRepo,
          organisationRepo,
          organisationId: assignedOrganisationId,
          mails: {
            admin_new_enquiry_received: {
              payload: {
                firstName: input.firstName,
                surname: input.surname,
                mobile: input.mobile,
                email: input.email,
                caseReference: caseRef,
                sourceType,
                provisionalPharmacyName,
              },
              keyParts: ['admin-enquiry', submission.id],
            },
            pharmacy_new_enquiry_assigned: assignedOrganisation
              ? {
                  payload: { caseReference: caseRef, ...pharmacyEmailContext(assignedOrganisation) },
                  keyParts: ['pharmacy-enquiry-assigned', submission.id, assignedOrganisationId, 1],
                }
              : { skip: true },
          },
        });
      }

      const submittedAt = submission.submittedAt || new Date().toISOString();
      res.setHeader('Cache-Control', 'no-store');
      res.status(created ? 201 : 200).json({
        caseReference: caseReference(submission.id, submittedAt),
        submittedAt,
        assignmentStatus: assignmentStatus.toLowerCase(),
        provisionalPharmacyName,
        warning: null,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
