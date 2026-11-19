import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sqlClickupHooks, type ClickupHooks } from '../../application/clickup/clickup-hooks.js';
import { branchAcceptances, type BranchOnboardingRepo } from '../../application/pharmacy-onboarding/branch-onboarding.js';
import {
  isLiveDocument,
  owesSignature,
  PARTNER_TERMS_SETTINGS_KEY,
  partnerTermsState,
  readPartnerTermsSettings,
  recordPromptSkipped,
  recordPromptViewed,
  type PartnerTermsSettings,
} from '../../application/pharmacy-onboarding/partner-terms.service.js';
import { signedCopyFilename } from '../../application/pharmacy-onboarding/partner-terms-signing.js';
import { HttpError } from '../../domain/common/errors.js';
import { asUuid, sameUuid, uuidKey } from '../../domain/common/uuid.js';
import { MAX_PARTNER_TERMS_PDF_BYTES, PROMPTED_BRANCH_STATUSES, type PartnerTermsDocumentRecord } from '../../domain/pharmacy-onboarding/partner-terms.js';
import { StorageProvider } from '../../providers/storage/storage.provider.js';
import type { PartnerTermsRepository } from '../../repositories/ports/partner-terms.port.js';
import type { PlatformContentRepository } from '../../repositories/ports/worldpay-application.port.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import type { PartnerTermsAcceptanceRecord } from '../../domain/pharmacy-onboarding/terms.js';
import { SqlIdentityRepository } from '../../repositories/sql/identity.sql.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { SqlPartnerTermsRepository } from '../../repositories/sql/partner-terms.sql.js';
import { SqlPharmacyOnboardingRepository } from '../../repositories/sql/pharmacy-onboarding.sql.js';
import { SqlPlatformContentRepository } from '../../repositories/sql/worldpay-application.sql.js';
import { requireCsrf } from '../../security/csrf.js';
import { assertPlatformScope, assertTenantScope, type PlatformScope, type RequestContext, type TenantScope } from '../../security/request-context.js';
import { requireStaff } from '../../security/require-staff.js';
import { uuidParam } from './uuid-param.js';

type Scope = TenantScope | PlatformScope;

export interface PartnerTermsRouterDeps {
  content: PlatformContentRepository;
  terms: PartnerTermsRepository;
  storage: { saveObject(path: string, bytes: Buffer, contentType: string): Promise<unknown>; downloadFile(path: string): Promise<{ bytes: Buffer }> };
  organisations: { listOrganisations(): Promise<OrganisationRecord[]>; findOrganisationById(id: string): Promise<OrganisationRecord | null> };
  acceptances: Pick<BranchOnboardingRepo, 'findByOrganisationId' | 'findTermsAcceptances' | 'findTermsAcceptancesForOrganisation'> & {
    listTermsAcceptances(limit?: number): Promise<PartnerTermsAcceptanceRecord[]>;
  };
  clickup: Pick<ClickupHooks, 'termsSkipped' | 'termsVersionPublished'>;
  audit(entry: { scope: Scope; organisationId: string | null; event: string; recordType: string; recordId: string; details: Record<string, unknown> }): Promise<void>;
  now?: () => Date;
}

function sqlDeps(): PartnerTermsRouterDeps {
  const identityRepo = new SqlIdentityRepository();
  return {
    content: new SqlPlatformContentRepository(),
    terms: new SqlPartnerTermsRepository(),
    storage: new StorageProvider(),
    organisations: new SqlOrganisationRepository(),
    acceptances: new SqlPharmacyOnboardingRepository(),
    clickup: sqlClickupHooks(),
    audit: async ({ scope, organisationId, event, recordType, recordId, details }) => {
      await identityRepo.appendAudit({
        organisationId,
        actorUid: scope.uid,
        actorRole: scope.role,
        event,
        recordType,
        recordId,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
        details,
      });
    },
  };
}

const settingsBody = z.object({ enabled: z.boolean() });
const versionHeader = z.string().trim().min(1, 'Name the version, for example v1.0.').max(60);

function requestRawBody(req: Request) {
  const raw = (req as Request & { rawBody?: Buffer | Uint8Array }).rawBody;
  if (raw) return Buffer.from(raw);
  return Buffer.isBuffer(req.body) ? req.body : null;
}

function sendPdf(res: Response, bytes: Buffer, filename: string) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename.replace(/["\\\r\n]/g, '')}"`);
  res.status(200).send(bytes);
}

/** Every activated branch that can log in: the ones the login prompt asks. Test branches included. */
function promptedBranches(organisations: OrganisationRecord[]) {
  return organisations.filter(organisation => PROMPTED_BRANCH_STATUSES.has(organisation.status));
}

/**
 * Partner Terms as uploaded, versioned PDFs.
 * Admin:
 *   GET  /portal/admin/partner-terms                       switch, versions, per-pharmacy status for the current one
 *   PUT  /portal/admin/partner-terms/documents             upload a draft (raw PDF; X-Filename, X-Version)
 *   GET  /portal/admin/partner-terms/documents/:id/file
 *   POST /portal/admin/partner-terms/documents/:id/publish
 *   POST /portal/admin/partner-terms/documents/:id/withdraw only while nobody has signed it
 *   PUT  /portal/admin/partner-terms/settings              { enabled }
 * Pharmacy (its own branch, from the session):
 *   GET  /portal/pharmacy/partner-terms/file               the current version, to read before signing
 *   POST /portal/pharmacy/partner-terms/viewed             the login prompt was shown
 *   POST /portal/pharmacy/partner-terms/skip
 *   GET  /portal/pharmacy/partner-terms/history            versions this branch has signed
 *   GET  /portal/pharmacy/partner-terms/history/:id/file   a signed copy
 * Signing itself is POST /portal/pharmacy/onboarding/terms (pharmacy-onboarding.router.ts).
 */
export function createPortalPartnerTermsRouter(depsFor: (context: RequestContext) => PartnerTermsRouterDeps = (() => {
  let deps: PartnerTermsRouterDeps | null = null;
  return () => (deps ??= sqlDeps());
})()): Router {
  const router = Router();
  const now = (deps: PartnerTermsRouterDeps) => deps.now?.() ?? new Date();

  const adminView = async (deps: PartnerTermsRouterDeps) => {
    const [settings, documents] = await Promise.all([readPartnerTermsSettings(deps.content), deps.terms.listDocuments()]);
    const current = documents.find(document => sameUuid(document.id, settings.currentDocumentId) && isLiveDocument(document)) ?? null;
    let pharmacies: Array<Record<string, unknown>> = [];
    if (current) {
      const [organisations, prompts, acceptances] = await Promise.all([
        deps.organisations.listOrganisations(),
        deps.terms.listPrompts(current.id),
        deps.acceptances.listTermsAcceptances(2000),
      ]);
      const promptFor = new Map(prompts.map(prompt => [uuidKey(prompt.organisationId), prompt]));
      const signedFor = new Map(acceptances.filter(row => sameUuid(row.documentId, current.id) && row.organisationId).map(row => [uuidKey(row.organisationId!), row]));
      pharmacies = promptedBranches(organisations).map(organisation => {
        const prompt = promptFor.get(uuidKey(organisation.id)) ?? null;
        const signed = signedFor.get(uuidKey(organisation.id)) ?? null;
        return {
          organisationId: organisation.id,
          name: organisation.name,
          gphcNumber: organisation.gphcNumber,
          test: organisation.classification ? organisation.classification !== 'STANDARD' : /^TRAINING-/i.test(organisation.gphcNumber),
          status: signed ? 'signed' : prompt?.skipCount ? 'skipped' : prompt?.firstViewedAt ? 'viewed' : 'not_seen',
          signedAt: signed?.acceptedAt ?? null,
          signerName: signed?.signerName ?? null,
          firstViewedAt: prompt?.firstViewedAt ?? null,
          skipCount: prompt?.skipCount ?? 0,
          lastSkippedAt: prompt?.lastSkippedAt ?? null,
          reminderSentAt: prompt?.reminderSentAt ?? null,
        };
      });
    }
    const signedDocuments = new Set((await deps.acceptances.listTermsAcceptances(2000)).map(row => row.documentId).filter((id): id is string => Boolean(id)).map(uuidKey));
    return {
      settings,
      currentDocumentId: current?.id ?? null,
      documents: documents.map(document => ({ ...document, storagePath: undefined, signed: signedDocuments.has(uuidKey(document.id)) })),
      pharmacies,
    };
  };

  const queuePublishedComments = async (deps: PartnerTermsRouterDeps, document: PartnerTermsDocumentRecord) => {
    const organisations = promptedBranches(await deps.organisations.listOrganisations());
    for (const organisation of organisations) {
      await deps.clickup.termsVersionPublished({ organisation, version: document.version, documentId: document.id });
    }
  };

  // ---- Admin ---------------------------------------------------------------

  router.get('/portal/admin/partner-terms', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(await adminView(depsFor(req.context!)));
    } catch (error) {
      next(error);
    }
  });

  router.put(
    '/portal/admin/partner-terms/documents',
    requireCsrf,
    requireStaff('admin'),
    express.raw({ type: 'application/pdf', limit: MAX_PARTNER_TERMS_PDF_BYTES }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const scope = assertPlatformScope(req.context!);
        const deps = depsFor(req.context!);
        const version = versionHeader.parse(decodeURIComponent(String(req.headers['x-version'] ?? '')));
        const bytes = requestRawBody(req);
        if (!bytes || bytes.length === 0) throw new HttpError(400, 'Choose a PDF to upload.', 'INVALID_INPUT');
        if (bytes.length > MAX_PARTNER_TERMS_PDF_BYTES) throw new HttpError(413, 'The PDF must be 10 MB or smaller.', 'FILE_TOO_LARGE');
        if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new HttpError(400, 'That file is not a PDF.', 'INVALID_FILE');
        const existing = await deps.terms.listDocuments();
        if (existing.some(document => document.version.toLowerCase() === version.toLowerCase() && !document.withdrawnAt)) {
          throw new HttpError(409, `There is already a version called ${version}. Use a new name.`, 'VERSION_EXISTS');
        }
        const rawName = String(req.headers['x-filename'] ?? 'Partner-Terms.pdf');
        const filename = decodeURIComponent(rawName).replace(/[^A-Za-z0-9 ._&'-]/g, '').slice(0, 120).replace(/\.pdf$/i, '') + '.pdf';
        const id = randomUUID();
        const uploadedAt = now(deps).toISOString();
        const storagePath = `partner-terms/${uploadedAt.replace(/[^0-9]/g, '')}-${id}.pdf`;
        await deps.storage.saveObject(storagePath, bytes, 'application/pdf');
        await deps.terms.insertDocument({
          id, version, storagePath, filename, sizeBytes: bytes.length, uploadedAt, uploadedByUid: scope.uid,
          publishedAt: null, publishedByUid: null, withdrawnAt: null, withdrawnByUid: null,
        });
        await deps.audit({ scope, organisationId: null, event: 'partner_terms.uploaded', recordType: 'PartnerTermsDocument', recordId: id, details: { version } }).catch(() => undefined);
        res.setHeader('Cache-Control', 'private, no-store');
        res.status(201).json(await adminView(deps));
      } catch (error) {
        next(error);
      }
    },
  );

  router.get('/portal/admin/partner-terms/documents/:id/file', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      const deps = depsFor(req.context!);
      const document = await deps.terms.findDocument(uuidParam.parse(req.params.id));
      if (!document) throw new HttpError(404, 'That version could not be found.', 'NOT_FOUND');
      const file = await deps.storage.downloadFile(document.storagePath);
      sendPdf(res, file.bytes, document.filename);
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/admin/partner-terms/documents/:id/publish', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const deps = depsFor(req.context!);
      const document = await deps.terms.findDocument(uuidParam.parse(req.params.id));
      if (!document) throw new HttpError(404, 'That version could not be found.', 'NOT_FOUND');
      if (document.withdrawnAt) throw new HttpError(409, 'A withdrawn version cannot be published again. Upload it as a new version.', 'VERSION_WITHDRAWN');
      if (document.publishedAt) throw new HttpError(409, 'This version is already published.', 'ALREADY_PUBLISHED');
      const at = now(deps).toISOString();
      await deps.terms.publishDocument(document.id, at, scope.uid);
      const settings = await readPartnerTermsSettings(deps.content);
      const next: PartnerTermsSettings = { ...settings, currentDocumentId: asUuid(document.id) };
      await deps.content.write(PARTNER_TERMS_SETTINGS_KEY, next, scope.uid);
      await deps.audit({ scope, organisationId: null, event: 'partner_terms.published', recordType: 'PartnerTermsDocument', recordId: document.id, details: { version: document.version, enabled: next.enabled } }).catch(() => undefined);
      if (next.enabled) await queuePublishedComments(deps, document);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(await adminView(deps));
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/admin/partner-terms/documents/:id/withdraw', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const deps = depsFor(req.context!);
      const document = await deps.terms.findDocument(uuidParam.parse(req.params.id));
      if (!document) throw new HttpError(404, 'That version could not be found.', 'NOT_FOUND');
      if (!document.publishedAt || document.withdrawnAt) throw new HttpError(409, 'Only a published version can be withdrawn.', 'NOT_PUBLISHED');
      if (await deps.terms.hasAcceptances(document.id)) {
        throw new HttpError(409, 'A pharmacy has already signed this version, so it can no longer be withdrawn. Publish a corrected version instead.', 'VERSION_SIGNED');
      }
      const at = now(deps).toISOString();
      await deps.terms.withdrawDocument(document.id, at, scope.uid);
      const settings = await readPartnerTermsSettings(deps.content);
      if (sameUuid(settings.currentDocumentId, document.id)) {
        // Back to the latest published version still standing, or none.
        const previous = (await deps.terms.listDocuments())
          .filter(row => !sameUuid(row.id, document.id) && isLiveDocument(row))
          .sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)))[0] ?? null;
        await deps.content.write(PARTNER_TERMS_SETTINGS_KEY, { ...settings, currentDocumentId: previous ? asUuid(previous.id) : null }, scope.uid);
      }
      await deps.audit({ scope, organisationId: null, event: 'partner_terms.withdrawn', recordType: 'PartnerTermsDocument', recordId: document.id, details: { version: document.version } }).catch(() => undefined);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(await adminView(deps));
    } catch (error) {
      next(error);
    }
  });

  router.put('/portal/admin/partner-terms/settings', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const deps = depsFor(req.context!);
      const { enabled } = settingsBody.parse(req.body);
      const settings = await readPartnerTermsSettings(deps.content);
      const current = settings.currentDocumentId ? await deps.terms.findDocument(settings.currentDocumentId) : null;
      if (enabled && !isLiveDocument(current)) {
        throw new HttpError(409, 'Publish a version of the Partner Terms before switching them on.', 'NO_PUBLISHED_VERSION');
      }
      await deps.content.write(PARTNER_TERMS_SETTINGS_KEY, { ...settings, enabled }, scope.uid);
      await deps.audit({ scope, organisationId: null, event: 'partner_terms.switched', recordType: 'PlatformContent', recordId: PARTNER_TERMS_SETTINGS_KEY, details: { enabled } }).catch(() => undefined);
      if (enabled && !settings.enabled && isLiveDocument(current)) await queuePublishedComments(deps, current);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(await adminView(deps));
    } catch (error) {
      next(error);
    }
  });

  // ---- Pharmacy ------------------------------------------------------------

  const branchFor = async (req: Request) => {
    const scope = assertTenantScope(req.context!);
    const deps = depsFor(req.context!);
    const organisation = await deps.organisations.findOrganisationById(scope.organisationId);
    if (!organisation) throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
    return { scope, deps, organisation };
  };

  /** The current version, only while this branch still owes it a signature. */
  const owedDocument = async (deps: PartnerTermsRouterDeps, organisation: OrganisationRecord) => {
    const state = await partnerTermsState({ content: deps.content, repo: deps.terms });
    const acceptances = await branchAcceptances(deps.acceptances, organisation);
    if (!state.document || !owesSignature(state, organisation, acceptances)) return null;
    return state.document;
  };

  router.get('/portal/pharmacy/partner-terms/file', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { deps } = await branchFor(req);
      const state = await partnerTermsState({ content: deps.content, repo: deps.terms });
      if (!state.on || !state.document) throw new HttpError(404, 'The Partner Terms are not available at the moment.', 'NOT_FOUND');
      const file = await deps.storage.downloadFile(state.document.storagePath);
      sendPdf(res, file.bytes, `Partner-Terms-${state.document.version}.pdf`);
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/pharmacy/partner-terms/viewed', requireCsrf, requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { scope, deps, organisation } = await branchFor(req);
      const document = await owedDocument(deps, organisation);
      if (document) {
        await recordPromptViewed(deps.terms, organisation.id, document.id, { uid: scope.uid, email: scope.email }, now(deps));
        await deps.audit({ scope, organisationId: organisation.id, event: 'partner_terms.viewed', recordType: 'PartnerTermsDocument', recordId: document.id, details: { version: document.version } }).catch(() => undefined);
      }
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.post('/portal/pharmacy/partner-terms/skip', requireCsrf, requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { scope, deps, organisation } = await branchFor(req);
      const document = await owedDocument(deps, organisation);
      if (document) {
        const at = now(deps);
        const prompt = await recordPromptSkipped(deps.terms, organisation.id, document.id, scope.uid, at);
        await deps.audit({ scope, organisationId: organisation.id, event: 'partner_terms.skipped', recordType: 'PartnerTermsDocument', recordId: document.id, details: { version: document.version, skipCount: prompt.skipCount } }).catch(() => undefined);
        const who = scope.email ?? scope.uid;
        await deps.clickup.termsSkipped({ organisation, version: document.version, skippedBy: who, skipCount: prompt.skipCount, at: at.toISOString() });
      }
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get('/portal/pharmacy/partner-terms/history', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { deps, organisation } = await branchFor(req);
      const rows = (await branchAcceptances(deps.acceptances, organisation)).filter(row => row.documentId);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({
        signed: rows.map(row => ({
          id: row.id,
          version: row.termsVersion,
          signerName: row.signerName,
          signedAt: row.acceptedAt,
          hasCopy: Boolean(row.signedCopyPath),
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/portal/pharmacy/partner-terms/history/:id/file', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { deps, organisation } = await branchFor(req);
      const id = uuidParam.parse(req.params.id);
      const row = (await branchAcceptances(deps.acceptances, organisation)).find(item => sameUuid(item.id, id));
      if (!row?.signedCopyPath) throw new HttpError(404, 'That signed copy could not be found.', 'NOT_FOUND');
      const file = await deps.storage.downloadFile(row.signedCopyPath);
      sendPdf(res, file.bytes, signedCopyFilename(row.termsVersion, organisation.name));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
