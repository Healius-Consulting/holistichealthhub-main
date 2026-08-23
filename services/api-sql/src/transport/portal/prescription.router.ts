import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { HttpError } from '../../domain/common/errors.js';
import { StorageProvider } from '../../providers/storage/storage.provider.js';
import { MAX_PRESCRIPTION_UPLOAD_BYTES, PRESCRIPTION_SIGNATURE_PREFIX_BYTES, matchesDeclaredFileSignature, uploadedObjectMatchesDeclaration } from '../../providers/storage/upload-constraints.js';
import type { PrescriberRecord } from '../../repositories/ports/prescription.port.js';
import { SqlPrescriptionRepository } from '../../repositories/sql/prescription.sql.js';
import { requireCsrf } from '../../security/csrf.js';
import { assertTenantScope } from '../../security/request-context.js';
import { requireStaff } from '../../security/require-staff.js';
import { requirePharmacyOperationalWrites } from './require-operational-writes.js';

const uuidLikeSchema = z.string().regex(/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);

const prescriberDirectoryInputSchema = z.object({
  organisationId: uuidLikeSchema.optional(),
  name: z.string().trim().min(2).max(200),
  initials: z.string().trim().min(1).max(20).optional(),
  pin: z.string().trim().min(1).max(100),
  gmcNumber: z.number().int().positive().nullable().default(null),
  gphcNumber: z.string().trim().max(100).nullable().default(null),
});

function mapPrescriberDirectoryRecord(record: PrescriberRecord) {
  const supplierIdentifiers = record.supplierIdentifiers && typeof record.supplierIdentifiers === 'object'
    ? record.supplierIdentifiers as Record<string, string>
    : {};
  return {
    id: record.id,
    name: record.name,
    initials: record.initials,
    pin: record.pin,
    gmcNumber: record.gmcNumber ?? null,
    gphcNumber: record.gphcNumber ?? null,
    active: record.active,
    curaleafIds: supplierIdentifiers,
    createdAt: record.createdAt ?? new Date().toISOString(),
    updatedAt: record.updatedAt ?? new Date().toISOString(),
  };
}

function filterPrescribers(records: PrescriberRecord[], query: string) {
  const needle = query.trim().toLocaleLowerCase('en-GB');
  if (!needle) return records.slice(0, 50);
  return records.filter(record => `${record.name} ${record.pin} ${record.gmcNumber ?? ''} ${record.gphcNumber ?? ''}`
    .toLocaleLowerCase('en-GB')
    .includes(needle)).slice(0, 50);
}

const uploadTargetSchema = z.object({
  organisationId: z.string().optional(),
  filename: z.string().min(1).max(255),
  contentType: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
  sizeBytes: z.number().int().positive().max(MAX_PRESCRIPTION_UPLOAD_BYTES),
  patientId: z.union([uuidLikeSchema, z.literal(''), z.null()]).optional(),
});

export function createPortalPrescriptionRouter(): Router {
  const router = Router();
  const prescriptionRepo = new SqlPrescriptionRepository();
  const storageProvider = new StorageProvider();

  // POST /v1/portal/prescription-files/upload-url and /upload-target
  const createUploadTarget = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const input = uploadTargetSchema.parse(req.body);
      const fileId = crypto.randomUUID();

      const target = await storageProvider.generateUploadTarget({
        organisationId: scope.organisationId,
        fileId,
        filename: input.filename,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
      });

      await prescriptionRepo.createFile({
        id: fileId,
        organisationId: scope.organisationId,
        patientId: input.patientId || null,
        storagePath: target.storagePath,
        originalFilename: input.filename,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        uploadedByUid: scope.uid,
      }).catch(error => {
        if (error instanceof HttpError) throw error;
        throw new HttpError(503, 'The prescription file record could not be saved.', 'PRESCRIPTION_FILE_CREATE_FAILED');
      });

      res.status(200).json(target);
    } catch (error) {
      next(error);
    }
  };

  router.post('/portal/prescription-files/upload-target', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, createUploadTarget);
  router.post('/portal/prescription-files/upload-url', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, createUploadTarget);

  // POST /v1/portal/prescription-files/:id/complete
  router.post('/portal/prescription-files/:id/complete', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const fileId = String(req.params.id || '');
      const fileRecord = await prescriptionRepo.findFileById(fileId, scope.organisationId);
      if (!fileRecord || fileRecord.status === 'DELETED' || fileRecord.deletedAt) {
        throw new HttpError(404, 'Prescription file not found.', 'NOT_FOUND');
      }
      if (fileRecord.status === 'UPLOADED') {
        res.status(200).json({ id: fileId, status: 'completed' });
        return;
      }
      if (fileRecord.status !== 'PENDING_UPLOAD') {
        throw new HttpError(409, 'This prescription file cannot be completed.', 'UPLOAD_NOT_COMPLETABLE');
      }
      const uploaded = await storageProvider.getObjectMetadata(fileRecord.storagePath);
      const match = uploadedObjectMatchesDeclaration(uploaded, {
        sizeBytes: fileRecord.sizeBytes,
        contentType: fileRecord.contentType,
      });
      if (!match.ok) {
        await storageProvider.deleteFile(fileRecord.storagePath);
        await prescriptionRepo.rejectFile(fileId, scope.organisationId);
        throw new HttpError(400, match.message, match.code);
      }
      const prefix = await storageProvider.readPrefix(fileRecord.storagePath, PRESCRIPTION_SIGNATURE_PREFIX_BYTES);
      if (!matchesDeclaredFileSignature(prefix, fileRecord.contentType)) {
        await storageProvider.deleteFile(fileRecord.storagePath);
        await prescriptionRepo.rejectFile(fileId, scope.organisationId);
        throw new HttpError(400, 'The uploaded file content does not match the declared type.', 'UPLOAD_SIGNATURE_MISMATCH');
      }
      await prescriptionRepo.completeFile(fileId, scope.organisationId);
      res.status(200).json({ id: fileId, status: 'completed' });
    } catch (error) {
      next(error);
    }
  });

  // DELETE /v1/portal/prescription-files/:id
  router.delete('/portal/prescription-files/:id', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const fileId = String(req.params.id || '');
      const fileRecord = await prescriptionRepo.findFileById(fileId, scope.organisationId);
      if (!fileRecord) {
        throw new HttpError(404, 'Prescription file not found.', 'NOT_FOUND');
      }
      await storageProvider.deleteFile(fileRecord.storagePath);
      await prescriptionRepo.deleteFile(fileId, scope.organisationId);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  // GET /v1/portal/prescription-files/:id/download-url
  router.get('/portal/prescription-files/:id/download-url', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const fileId = String(req.params.id || '');

      const fileRecord = await prescriptionRepo.findFileById(fileId, scope.organisationId);
      if (!fileRecord || fileRecord.status === 'DELETED' || fileRecord.deletedAt) {
        throw new HttpError(404, 'Prescription file not found.', 'NOT_FOUND');
      }
      if (fileRecord.status !== 'UPLOADED') {
        throw new HttpError(409, 'This prescription file is not available to download.', 'UPLOAD_NOT_READY');
      }

      const downloadUrl = await storageProvider.generateDownloadUrl(fileRecord.storagePath, 300);
      res.status(200).json({ downloadUrl, expiresAt: new Date(Date.now() + 300 * 1000).toISOString() });
    } catch (error) {
      next(error);
    }
  });

  // GET /v1/portal/prescriptions - List tenant prescriptions
  router.get('/portal/prescriptions', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const prescriptions = await prescriptionRepo.listTenantPrescriptions(scope.organisationId);
      res.status(200).json(prescriptions);
    } catch (error) {
      next(error);
    }
  });

  // GET /v1/portal/prescribers - List active prescriber directory
  router.get('/portal/prescribers', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertTenantScope(req.context!);
      const query = String(req.query.query ?? '');
      const prescribers = await prescriptionRepo.listActivePrescribers();
      res.status(200).json(filterPrescribers(prescribers, query).map(mapPrescriberDirectoryRecord));
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/portal/prescribers - Add or update central prescriber directory entry
  router.post('/portal/prescribers', requireCsrf, requireStaff('pharmacy'), requirePharmacyOperationalWrites, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertTenantScope(req.context!);
      const input = prescriberDirectoryInputSchema.parse(req.body);
      if (input.organisationId && input.organisationId.replace(/-/g, '') !== scope.organisationId.replace(/-/g, '')) {
        throw new HttpError(403, 'Cross-pharmacy access is not permitted.', 'TENANT_SCOPE_VIOLATION');
      }

      const initials = input.initials
        ?? input.name.split(/\s+/).map(part => part[0]).join('').toUpperCase().slice(0, 20);

      const existing = await prescriptionRepo.findActivePrescriberMatch({
        pin: input.pin,
        gmcNumber: input.gmcNumber,
        gphcNumber: input.gphcNumber,
      });

      const record = await prescriptionRepo.upsertPrescriber({
        name: input.name,
        initials,
        pin: input.pin,
        gmcNumber: input.gmcNumber,
        gphcNumber: input.gphcNumber,
        createdByUid: scope.uid,
      });

      res.status(existing ? 200 : 201).json(mapPrescriberDirectoryRecord(record));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
