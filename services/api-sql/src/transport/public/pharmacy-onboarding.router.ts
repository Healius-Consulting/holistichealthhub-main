import { Router, type Request, type Response, type NextFunction } from 'express';
import Busboy from 'busboy';
import { HttpError } from '../../domain/common/errors.js';
import {
  MAX_LICENCE_BYTES,
  pharmacyOnboardingFieldsSchema,
  publicOnboardingStatus,
} from '../../domain/pharmacy-onboarding/request.js';
import { publicSubmissionLimiter } from '../../security/public-limits.js';
import { SqlNotificationRepository } from '../../repositories/sql/notification.sql.js';
import { SqlPharmacyOnboardingRepository } from '../../repositories/sql/pharmacy-onboarding.sql.js';
import { StorageProvider } from '../../providers/storage/storage.provider.js';
import { queuePharmacyOnboardingSubmitted } from '../../application/pharmacy-onboarding/emails.js';
import { submitPharmacyOnboardingRequest } from '../../application/pharmacy-onboarding/submit-request.js';

type UploadedLicence = { filename: string; declaredType: string; bytes: Buffer };

function readSubmission(req: Request): Promise<{ fields: Record<string, string>; licence: UploadedLicence | null; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'];
    if (!contentType?.includes('multipart/form-data')) {
      reject(new HttpError(400, 'Submit the Curaleaf account form as a file upload.', 'INVALID_INPUT'));
      return;
    }
    const busboy = Busboy({
      headers: { ...req.headers, 'content-type': contentType },
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
    req.pipe(busboy);
  });
}

export function createPublicPharmacyOnboardingRouter(): Router {
  const router = Router();
  const repo = new SqlPharmacyOnboardingRepository();
  const storage = new StorageProvider();
  const notificationRepo = new SqlNotificationRepository();

  router.post('/public/pharmacy-onboarding-requests', publicSubmissionLimiter, async (req: Request, res: Response, next: NextFunction) => {
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
      }
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(201).json({ id: record.id, status: publicOnboardingStatus(record.status) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
