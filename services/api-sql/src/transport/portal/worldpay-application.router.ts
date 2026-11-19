import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  loadWorldpayApplication,
  readWorldpayContent,
  resendWorldpayApplication,
  saveWorldpayDraft,
  setWorldpayApplicationStatus,
  submitWorldpayApplication,
  type WorldpayDeps,
} from '../../application/worldpay-application/applications.js';
import { applicationFileBase } from '../../application/worldpay-application/documents.js';
import { worldpayHooks } from '../../application/worldpay-application/hooks.js';
import { sqlWorldpayDeps, worldpayPrefill } from '../../application/worldpay-application/sql-deps.js';
import { HttpError } from '../../domain/common/errors.js';
import { WORLDPAY_CONTENT_KEYS, WORLDPAY_CONTENT_SCHEMAS, type WorldpayContentKey } from '../../domain/worldpay-application/content.js';
import type { WorldpayApplicationRecord } from '../../repositories/ports/worldpay-application.port.js';
import { SqlIdentityRepository } from '../../repositories/sql/identity.sql.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { SqlPharmacyOnboardingRepository } from '../../repositories/sql/pharmacy-onboarding.sql.js';
import { requireCsrf } from '../../security/csrf.js';
import { assertPlatformScope, assertTenantScope, type RequestContext } from '../../security/request-context.js';
import { requireStaff } from '../../security/require-staff.js';
import { uuidParam } from './uuid-param.js';
import { uuidInput } from '../../domain/common/uuid.js';

const saveSchema = z.object({
  id: uuidInput.nullable().default(null),
  version: z.number().int().min(0).default(0),
  answers: z.unknown(),
});
const submitSchema = z.object({
  id: uuidInput,
  version: z.number().int().min(1),
  answers: z.unknown(),
  declaration: z.unknown(),
});
const statusSchema = z.object({
  status: z.enum(['SUBMITTED', 'WITH_WORLDPAY', 'QUERY', 'ACCOUNT_OPEN', 'WITHDRAWN', 'DECLINED']),
  note: z.string().trim().max(1000).nullable().default(null),
});
const MAX_SERVICE_PDF_BYTES = 10 * 1024 * 1024;

/** The admin list row: names and dates only, never the answers. */
export function adminRow(record: WorldpayApplicationRecord) {
  return {
    id: record.id,
    reference: record.reference,
    legalName: record.legalName,
    tradingName: record.tradingName,
    gphcNumber: record.gphcNumber,
    organisationId: record.organisationId,
    websiteRoute: record.usesHhhWebsite ? 'HHH website and service information' : 'Own website',
    usesHhhWebsite: Boolean(record.usesHhhWebsite),
    status: record.status,
    statusNote: record.statusNote,
    submittedAt: record.submittedAt,
    sentAt: record.sentAt,
    deliveryError: record.deliveryError,
    companyNumber: record.companyNumber,
    companyStatus: record.companyStatus,
    companyNameDiffers: Boolean(record.companyName && record.legalName && record.companyName.trim().toLowerCase() !== record.legalName.trim().toLowerCase()),
    cleared: Boolean(record.sensitiveDeletedAt),
  };
}

function requestRawBody(req: Request) {
  const raw = (req as Request & { rawBody?: Buffer | Uint8Array }).rawBody;
  if (raw) return Buffer.from(raw);
  return Buffer.isBuffer(req.body) ? req.body : null;
}

export function createPortalWorldpayApplicationRouter(depsFor: (context: RequestContext) => WorldpayDeps = context => sqlWorldpayDeps(worldpayHooks(context))): Router {
  const router = Router();
  const organisationRepo = new SqlOrganisationRepository();
  const onboardingRepo = new SqlPharmacyOnboardingRepository();
  const identityRepo = new SqlIdentityRepository();

  const branchOwner = async (context: RequestContext) => {
    const scope = assertTenantScope(context);
    const organisation = await organisationRepo.findOrganisationById(scope.organisationId);
    if (!organisation) throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
    return { scope, organisation, owner: { kind: 'branch' as const, organisationId: organisation.id, gphcNumber: organisation.gphcNumber } };
  };

  // GET /v1/portal/pharmacy/worldpay-application - this branch's application, or a new one started from what we know
  router.get('/portal/pharmacy/worldpay-application', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { organisation, owner } = await branchOwner(req.context!);
      const [request, terms] = await Promise.all([
        onboardingRepo.findByOrganisationId(organisation.id),
        onboardingRepo.findTermsAcceptancesForOrganisation(organisation.id),
      ]);
      const view = await loadWorldpayApplication(depsFor(req.context!), owner, worldpayPrefill({ organisation, request, terms: terms[0] ?? null }));
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(view);
    } catch (error) {
      next(error);
    }
  });

  // PUT /v1/portal/pharmacy/worldpay-application - save the draft (any user of the branch)
  router.put('/portal/pharmacy/worldpay-application', requireCsrf, requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { owner } = await branchOwner(req.context!);
      const input = saveSchema.parse(req.body);
      const saved = await saveWorldpayDraft(depsFor(req.context!), owner, input);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(saved);
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/portal/pharmacy/worldpay-application/submit - final answers and the declaration
  router.post('/portal/pharmacy/worldpay-application/submit', requireCsrf, requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { scope, organisation, owner } = await branchOwner(req.context!);
      const input = submitSchema.parse(req.body);
      const declarationName = typeof (input.declaration as { signerName?: unknown })?.signerName === 'string' ? String((input.declaration as { signerName: string }).signerName) : '';
      const record = await submitWorldpayApplication(depsFor(req.context!), owner, {
        ...input,
        submitter: { uid: scope.uid, name: declarationName, email: scope.email ?? '' },
      });
      await identityRepo.appendAudit({
        organisationId: organisation.id,
        actorUid: scope.uid,
        actorRole: scope.role,
        event: 'worldpay_application.submitted',
        recordType: 'WorldpayApplication',
        recordId: record.id,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
        details: { reference: record.reference },
      }).catch(() => undefined);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(201).json({ id: record.id, status: record.status, reference: record.reference, submittedAt: record.submittedAt });
    } catch (error) {
      next(error);
    }
  });

  // --- Admin -----------------------------------------------------------------------

  // GET /v1/portal/admin/worldpay-applications - every submitted application
  router.get('/portal/admin/worldpay-applications', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      const records = await depsFor(req.context!).repo.list(300);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({ records: records.map(adminRow) });
    } catch (error) {
      next(error);
    }
  });

  // GET /v1/portal/admin/worldpay-applications/:id - one application in full (admin only)
  router.get('/portal/admin/worldpay-applications/:id', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      const record = await depsFor(req.context!).repo.findById(uuidParam.parse(req.params.id));
      if (!record || record.status === 'DRAFT') throw new HttpError(404, 'Worldpay application not found.', 'NOT_FOUND');
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({ ...adminRow(record), answers: record.answers, signerName: record.signerName, signerPosition: record.signerPosition, submitterName: record.submitterName, submitterEmail: record.submitterEmail });
    } catch (error) {
      next(error);
    }
  });

  // GET /v1/portal/admin/worldpay-applications/:id/files/:kind - the PDF, the spreadsheet, or (no website
  // of its own) the service information PDF sent with it
  router.get('/portal/admin/worldpay-applications/:id/files/:kind', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      const deps = depsFor(req.context!);
      const record = await deps.repo.findById(uuidParam.parse(req.params.id));
      const kind = z.enum(['pdf', 'xlsx', 'service']).parse(req.params.kind);
      if (kind === 'service') {
        if (!record || !record.usesHhhWebsite) throw new HttpError(404, 'This pharmacy has its own website, so no service information PDF goes with it.', 'NOT_FOUND');
        const content = await readWorldpayContent(deps.content);
        if (!content.servicePdf) throw new HttpError(404, 'No service information PDF has been uploaded. Upload it in Settings.', 'NOT_FOUND');
        const pack = await deps.storage.downloadFile(content.servicePdf.storagePath);
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${content.servicePdf.filename.replace(/"/g, '')}"`);
        res.status(200).send(pack.bytes);
        return;
      }
      const path = kind === 'pdf' ? record?.pdfStoragePath : record?.xlsxStoragePath;
      if (!record || !path) throw new HttpError(404, 'This file is not available. It may have been deleted under the retention rules.', 'NOT_FOUND');
      const file = await deps.storage.downloadFile(path);
      const filename = `${applicationFileBase(record.answers, record.reference ?? record.id).replace(/[^A-Za-z0-9 _&'-]/g, '')}.${kind}`;
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Type', kind === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `${kind === 'pdf' ? 'inline' : 'attachment'}; filename="${filename}"`);
      res.status(200).send(file.bytes);
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/portal/admin/worldpay-applications/:id/resend - WP-01 again
  router.post('/portal/admin/worldpay-applications/:id/resend', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      const record = await resendWorldpayApplication(depsFor(req.context!), uuidParam.parse(req.params.id));
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({ record: adminRow(record) });
    } catch (error) {
      next(error);
    }
  });

  // POST /v1/portal/admin/worldpay-applications/:id/status - status and the note shown to the pharmacy
  router.post('/portal/admin/worldpay-applications/:id/status', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const input = statusSchema.parse(req.body);
      const record = await setWorldpayApplicationStatus(depsFor(req.context!), uuidParam.parse(req.params.id), { ...input, byUid: scope.uid });
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({ record: adminRow(record) });
    } catch (error) {
      next(error);
    }
  });

  // GET /v1/portal/admin/worldpay-content - the editable wording, recipients and service PDF
  router.get('/portal/admin/worldpay-content', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(await readWorldpayContent(depsFor(req.context!).content));
    } catch (error) {
      next(error);
    }
  });

  // PUT /v1/portal/admin/worldpay-content/:key - change one piece of content
  router.put('/portal/admin/worldpay-content/:key', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const key = z.enum(['recipients', 'wp01', 'pricingPanel', 'schemeAnswers', 's04Note']).parse(req.params.key) as Exclude<WorldpayContentKey, 'servicePdf'>;
      const value = WORLDPAY_CONTENT_SCHEMAS[key].parse((req.body as { value?: unknown })?.value);
      await depsFor(req.context!).content.write(WORLDPAY_CONTENT_KEYS[key], value, scope.uid);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(await readWorldpayContent(depsFor(req.context!).content));
    } catch (error) {
      next(error);
    }
  });

  // PUT /v1/portal/admin/worldpay-service-pdf - replace the service information PDF (raw PDF body)
  router.put(
    '/portal/admin/worldpay-service-pdf',
    requireCsrf,
    requireStaff('admin'),
    express.raw({ type: 'application/pdf', limit: MAX_SERVICE_PDF_BYTES }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const scope = assertPlatformScope(req.context!);
        const bytes = requestRawBody(req);
        if (!bytes || bytes.length === 0) throw new HttpError(400, 'Choose a PDF to upload.', 'INVALID_INPUT');
        if (bytes.length > MAX_SERVICE_PDF_BYTES) throw new HttpError(413, 'The PDF must be 10 MB or smaller.', 'FILE_TOO_LARGE');
        if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HttpError(400, 'That file is not a PDF.', 'INVALID_FILE');
        const rawName = String(req.headers['x-filename'] ?? 'Holistic-Health-Hub-service-information.pdf');
        const filename = decodeURIComponent(rawName).replace(/[^A-Za-z0-9 ._&'-]/g, '').slice(0, 120).replace(/\.pdf$/i, '') + '.pdf';
        const deps = depsFor(req.context!);
        const uploadedAt = new Date().toISOString();
        const storagePath = `worldpay-content/service-information-${uploadedAt.replace(/[^0-9]/g, '')}.pdf`;
        await deps.storage.saveObject(storagePath, bytes, 'application/pdf');
        await deps.content.write(WORLDPAY_CONTENT_KEYS.servicePdf, { storagePath, filename, uploadedAt }, scope.uid);
        res.setHeader('Cache-Control', 'private, no-store');
        res.status(200).json(await readWorldpayContent(deps.content));
      } catch (error) {
        next(error);
      }
    },
  );

  // GET /v1/portal/admin/worldpay-service-pdf - the current service information PDF
  router.get('/portal/admin/worldpay-service-pdf', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      const deps = depsFor(req.context!);
      const content = await readWorldpayContent(deps.content);
      if (!content.servicePdf) throw new HttpError(404, 'No service information PDF has been uploaded.', 'NOT_FOUND');
      const file = await deps.storage.downloadFile(content.servicePdf.storagePath);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${content.servicePdf.filename.replace(/"/g, '')}"`);
      res.status(200).send(file.bytes);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
