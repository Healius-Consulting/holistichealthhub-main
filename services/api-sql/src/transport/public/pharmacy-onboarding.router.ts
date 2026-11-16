import { Router, type Request, type Response, type NextFunction } from 'express';
import Busboy from 'busboy';
import { HttpError } from '../../domain/common/errors.js';
import {
  MAX_LICENCE_BYTES,
  pharmacyOnboardingFieldsSchema,
  publicOnboardingStatus,
} from '../../domain/pharmacy-onboarding/request.js';
import { pharmacyOnboardingDeferralSchema } from '../../domain/pharmacy-onboarding/deferral.js';
import { publicPharmacyOnboardingDeferralLimiter, publicPharmacyOnboardingLimiter } from '../../security/public-limits.js';
import { recordPharmacyOnboardingDeferral } from '../../application/pharmacy-onboarding/record-deferral.js';
import { submitWorldpayForm } from '../../application/pharmacy-onboarding/submit-worldpay.js';
import { sendEmailNow } from '../../application/workers/deliver-messages.js';
import { worldpayFormSchema } from '../../domain/pharmacy-onboarding/worldpay.js';
import { SqlNotificationRepository } from '../../repositories/sql/notification.sql.js';
import { SqlPharmacyOnboardingRepository } from '../../repositories/sql/pharmacy-onboarding.sql.js';
import { StorageProvider } from '../../providers/storage/storage.provider.js';
import { queuePharmacyOnboardingSubmitted } from '../../application/pharmacy-onboarding/emails.js';
import { submitPharmacyOnboardingRequest } from '../../application/pharmacy-onboarding/submit-request.js';
import { activatePharmacyOnboardingRequest } from '../../application/pharmacy-onboarding/decide-request.js';
import { ReferralLinkService } from '../../application/referrals/referral-link.service.js';
import { SqlIdentityRepository } from '../../repositories/sql/identity.sql.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';

/** Audit actor for pharmacies created by the onboarding form rather than an admin. */
const ONBOARDING_ACTOR = 'system:pharmacy-onboarding';

type UploadedLicence = { filename: string; declaredType: string; bytes: Buffer };

/**
 * Cloud Functions reads the body before Express sees the stream, and leaves it on
 * `rawBody`. Piping the request hangs, so the submit button never finishes.
 */
function requestRawBody(req: Request) {
  const raw = (req as Request & { rawBody?: Buffer | Uint8Array }).rawBody;
  return raw ? Buffer.from(raw) : null;
}

function readMultipart(req: Request, contentType: string): Promise<{ fields: Record<string, string>; licence: UploadedLicence | null; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({
      headers: { 'content-type': contentType },
      limits: { files: 1, fileSize: MAX_LICENCE_BYTES, fields: 20, fieldSize: 2_000 },
    });
    const fields: Record<string, string> = {};
    let licence: UploadedLicence | null = null;
    let tooLarge = false;
    busboy.on('field', (name, value) => { fields[name] = value; });
    busboy.on('file', (name, stream, info) => {
      if (name !== 'licence') {
        stream.resume();
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('limit', () => { tooLarge = true; });
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        licence = {
          filename: info.filename || 'controlled-drug-licence',
          declaredType: info.mimeType || 'application/octet-stream',
          bytes: Buffer.concat(chunks),
        };
      });
    });
    busboy.on('error', reject);
    busboy.on('finish', () => resolve({ fields, licence, tooLarge }));
    const raw = requestRawBody(req);
    if (raw) busboy.end(raw);
    else req.pipe(busboy);
  });
}

async function readSubmission(req: Request): Promise<{ fields: unknown; licence: UploadedLicence | null; tooLarge: boolean }> {
  const contentType = req.headers['content-type'] ?? '';
  if (contentType.includes('application/json')) {
    return { fields: req.body, licence: null, tooLarge: false };
  }
  if (contentType.includes('multipart/form-data')) return readMultipart(req, contentType);
  throw new HttpError(400, 'The form could not be read. Submit it again.', 'INVALID_INPUT');
}

export function createPublicPharmacyOnboardingRouter(): Router {
  const router = Router();
  const repo = new SqlPharmacyOnboardingRepository();
  const storage = new StorageProvider();
  const notificationRepo = new SqlNotificationRepository();
  const organisationRepo = new SqlOrganisationRepository();
  const identityRepo = new SqlIdentityRepository();
  const referralLinks = new ReferralLinkService(organisationRepo);

  router.post('/public/pharmacy-onboarding-requests', publicPharmacyOnboardingLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const submission = await readSubmission(req);
      if (submission.tooLarge) {
        throw new HttpError(400, 'The controlled drug licence must be 4 MB or smaller.', 'LICENCE_TOO_LARGE');
      }
      const fields = pharmacyOnboardingFieldsSchema.parse(submission.fields);
      const record = await submitPharmacyOnboardingRequest(repo, storage, {
        fields,
        licence: submission.licence && submission.licence.bytes.length > 0 ? submission.licence : null,
      });
      if (record.status === 'PENDING') {
        try {
          await queuePharmacyOnboardingSubmitted(notificationRepo, record);
        } catch (error) {
          console.error('Pharmacy onboarding email was not queued', error instanceof Error ? error.message : 'unknown');
        }
        // The pharmacy is created straight away, in onboarding with intake off. The
        // only step left is HHH entering Curaleaf's PHAR code and API key. If this
        // fails the request stays pending and HHH can activate it by hand.
        try {
          const created = await activatePharmacyOnboardingRequest(repo, organisationRepo, referralLinks, {
            id: record.id,
            actorUid: ONBOARDING_ACTOR,
          });
          await identityRepo.appendAudit({
            organisationId: created.organisation.id,
            actorUid: ONBOARDING_ACTOR,
            event: 'organisation.created',
            recordType: 'Organisation',
            recordId: created.organisation.id,
            surface: 'public',
            details: { source: 'pharmacy-onboarding-request', requestId: record.id, automatic: true },
          }).catch(() => undefined);
        } catch (error) {
          console.error('Pharmacy was not created from the onboarding form', error instanceof Error ? error.message : 'unknown');
        }
      }
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(201).json({ id: record.id, status: publicOnboardingStatus(record.status) });
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/public/pharmacy-onboarding-worldpay - the Worldpay form, emailed as a PDF and never stored
  router.post('/public/pharmacy-onboarding-worldpay', publicPharmacyOnboardingLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const form = worldpayFormSchema.parse(req.body);
      const note = await submitWorldpayForm(repo, email => sendEmailNow(email), form);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(201).json({ submittedAt: note.submittedAt });
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/public/pharmacy-onboarding-deferrals - a PharmSmart visitor chose "Not yet"
  router.post('/public/pharmacy-onboarding-deferrals', publicPharmacyOnboardingDeferralLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = pharmacyOnboardingDeferralSchema.parse(req.body);
      const result = await recordPharmacyOnboardingDeferral(repo, input);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(201).json({ id: result.id });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
