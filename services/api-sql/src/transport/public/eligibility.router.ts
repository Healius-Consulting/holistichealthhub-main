import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { SqlIntakeRepository } from '../../repositories/sql/intake.sql.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { publicSubmissionLimiter } from '../../security/public-limits.js';
import { sha256 } from '../../security/session-utils.js';

const submissionInputSchema = z.object({
  firstName: z.string().min(1).max(100),
  surname: z.string().min(1).max(100),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  mobile: z.string().min(8).max(20),
  email: z.string().email(),
  postcode: z.string().min(3).max(12),
  conditions: z.array(z.string()).min(1),
  primaryCondition: z.string().min(1),
  tried2: z.literal(true),
  psychExclusion: z.literal(false),
  consentReferral: z.literal(true),
  consentShare: z.literal(true),
  marketing: z.boolean().default(false),
  heardAbout: z.string().max(200).optional().default(''),
  consentVersion: z.string().default('general-public-v2.0'),
  idempotencyKey: z.string().min(8).max(128),
  referralToken: z.string().optional(),
  type: z.enum(['general_hhh_website', 'future_pharmacy_qr']).default('general_hhh_website'),
});

export function createPublicEligibilityRouter(): Router {
  const router = Router();
  const intakeRepo = new SqlIntakeRepository();
  const organisationRepo = new SqlOrganisationRepository();

  // POST /v1/public/eligibility-submissions
  router.post('/public/eligibility-submissions', publicSubmissionLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = submissionInputSchema.parse(req.body);
      const emailHash = sha256(input.email.trim().toLowerCase());
      const idempotencyKeyHash = sha256(input.idempotencyKey);

      let assignedOrganisationId: string | null = null;
      let sourceOrganisationId: string | null = null;
      let sourceType: 'GENERAL_HHH_WEBSITE' | 'PHARMACY_QR' = 'GENERAL_HHH_WEBSITE';
      let assignmentStatus: 'AWAITING_HHH_ALLOCATION' | 'PROVISIONAL' = 'AWAITING_HHH_ALLOCATION';
      let pharmacyAccessStatus: 'WITHHELD' | 'ACTIVATED' = 'WITHHELD';

      // If submitted via pharmacy QR token
      if (input.referralToken) {
        const tokenHash = sha256(input.referralToken);
        const resolved = await organisationRepo.findDirectoryByTokenHash(tokenHash);
        if (resolved) {
          sourceOrganisationId = resolved.pharmacy.id;
          assignedOrganisationId = resolved.pharmacy.id;
          sourceType = 'PHARMACY_QR';
          assignmentStatus = 'PROVISIONAL';
          pharmacyAccessStatus = 'WITHHELD'; // Withheld until HHH review
        }
      }

      const result = await intakeRepo.createSubmission({
        sourceOrganisationId,
        assignedOrganisationId,
        sourceType,
        firstName: input.firstName,
        surname: input.surname,
        dob: input.dob,
        mobile: input.mobile,
        email: input.email,
        emailHash,
        postcode: input.postcode,
        triedTwoTreatments: input.tried2,
        psychiatricExclusion: input.psychExclusion,
        heardAbout: input.heardAbout,
        conditionCodes: input.conditions,
        primaryConditionCode: input.primaryCondition,
        idempotencyKeyHash,
        assignmentStatus,
        pharmacyAccessStatus,
        consentVersion: input.consentVersion,
        referralConsent: input.consentReferral,
        dataSharingConsent: input.consentShare,
        marketingConsent: input.marketing,
        privacyNoticeVersion: '2026-v2',
      });
      const submissionId = result.id
        ?? (await intakeRepo.findSubmissionByIdempotencyHash(idempotencyKeyHash))?.id;
      if (submissionId) {
        await intakeRepo.saveSubmissionConditions(submissionId, input.conditions, input.primaryCondition);
      }

      res.status(201).json({
        caseReference: idempotencyKeyHash.slice(0, 10).toUpperCase(),
        submittedAt: new Date().toISOString(),
        assignmentStatus: assignmentStatus.toLowerCase(),
        warning: null,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
