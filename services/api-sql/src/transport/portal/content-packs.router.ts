import { Router, type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../../domain/common/errors.js';
import {
  applyContentPacksText,
  belongsToGroup,
  CONTENT_PACKS_KEY,
  contentPackStoragePath,
  contentPacksTextSchema,
  contentTypeFor,
  GROUP_IDS,
  groupVisible,
  issueDate,
  issueGroup,
  MAX_CONTENT_PACK_FILE_BYTES,
  pharmacyContentPacks,
  resolveContentPacks,
  safeFilename,
  withdrawGroup,
  type ContentPacksConfig,
  type GroupId,
} from '../../domain/content-packs/content-packs.js';
import { StorageProvider } from '../../providers/storage/storage.provider.js';
import type { PlatformContentRepository } from '../../repositories/ports/worldpay-application.port.js';
import { SqlIdentityRepository } from '../../repositories/sql/identity.sql.js';
import { SqlPlatformContentRepository } from '../../repositories/sql/worldpay-application.sql.js';
import { requireCsrf } from '../../security/csrf.js';
import { assertPlatformScope, assertTenantScope, type PlatformScope } from '../../security/request-context.js';
import { requireStaff } from '../../security/require-staff.js';

const groupParam = z.enum(GROUP_IDS);
const uploadUrlSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  sizeBytes: z.number().int().positive(),
});
const issueSchema = z.object({
  storagePath: z.string().min(1).max(400),
  filename: z.string().trim().min(1).max(200),
  version: z.string().trim().max(40).nullable().default(null),
  issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
});

export interface ContentPacksRouterDeps {
  content: PlatformContentRepository;
  storage: Pick<StorageProvider, 'generateWriteUrl' | 'generateDownloadUrl' | 'getObjectMetadata' | 'readPrefix' | 'deleteFile'>;
  audit(entry: { scope: PlatformScope; event: string; recordId: string; details: Record<string, unknown> }): Promise<void>;
  now?: () => Date;
}

function sqlDeps(): ContentPacksRouterDeps {
  const identityRepo = new SqlIdentityRepository();
  return {
    content: new SqlPlatformContentRepository(),
    storage: new StorageProvider(),
    audit: async ({ scope, event, recordId, details }) => {
      await identityRepo.appendAudit({
        organisationId: null,
        actorUid: scope.uid,
        actorRole: scope.role,
        event,
        recordType: 'ContentPackGroup',
        recordId,
        requestId: scope.requestId,
        sessionHashPrefix: scope.sessionHash.slice(0, 12),
        surface: scope.surface,
        details,
      });
    },
  };
}

/** The file's first bytes must match what its name says it is. */
export function looksRight(head: Buffer, contentType: string) {
  const start = head.subarray(0, 5).toString('latin1');
  if (contentType === 'application/pdf') return start === '%PDF-';
  if (contentType === 'text/csv') return !head.includes(0);
  // zip, docx, xlsx and pptx are all zip archives.
  return start.startsWith('PK\u0003\u0004');
}

/** Admin view: everything but storage paths. */
function adminView(config: ContentPacksConfig) {
  return {
    cards: config.cards,
    groups: config.groups.map(group => ({
      ...group,
      file: group.file ? { filename: group.file.filename, contentType: group.file.contentType, sizeBytes: group.file.sizeBytes } : null,
      visible: groupVisible(group),
    })),
  };
}

/**
 * Settings → Assets → Content packs (FB-20). Pharmacies read the cards and download a
 * group's file; HHH admin edits the words and issues, re-issues or withdraws group files.
 * Files never pass through the API: the browser uploads to and downloads from Storage with
 * short-lived signed links, so a group can be far larger than a request can carry.
 */
export function createPortalContentPacksRouter(depsFor: () => ContentPacksRouterDeps = sqlDeps): Router {
  const router = Router();
  const now = (deps: ContentPacksRouterDeps) => (deps.now ? deps.now() : new Date());
  const read = async (deps: ContentPacksRouterDeps) => resolveContentPacks((await deps.content.read([CONTENT_PACKS_KEY]))[CONTENT_PACKS_KEY]);

  const downloadLink = async (deps: ContentPacksRouterDeps, groupId: GroupId, missing: string) => {
    const group = (await read(deps)).groups.find(entry => entry.id === groupId);
    if (!group?.file) throw new HttpError(404, missing, 'NOT_FOUND');
    const url = await deps.storage.generateDownloadUrl(group.file.storagePath, 300, group.file.filename);
    return { url, filename: group.file.filename, sizeBytes: group.file.sizeBytes };
  };

  // ---- Pharmacy --------------------------------------------------------------

  router.get('/portal/content-packs', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertTenantScope(req.context!);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(pharmacyContentPacks(await read(depsFor())));
    } catch (error) {
      next(error);
    }
  });

  // A five-minute link to the group's file in Storage.
  router.get('/portal/content-packs/groups/:groupId/download', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertTenantScope(req.context!);
      const link = await downloadLink(depsFor(), groupParam.parse(req.params.groupId), 'This download is not available yet.');
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(link);
    } catch (error) {
      next(error);
    }
  });

  // ---- Admin -----------------------------------------------------------------

  router.get('/portal/admin/content-packs', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(adminView(await read(depsFor())));
    } catch (error) {
      next(error);
    }
  });

  router.get('/portal/admin/content-packs/groups/:groupId/download', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      const link = await downloadLink(depsFor(), groupParam.parse(req.params.groupId), 'No file has been issued for this group.');
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(link);
    } catch (error) {
      next(error);
    }
  });

  // Card titles, descriptions, group labels and the block library link: no release needed.
  router.put('/portal/admin/content-packs', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const deps = depsFor();
      const input = contentPacksTextSchema.parse(req.body);
      const next = applyContentPacksText(await read(deps), input);
      await deps.content.write(CONTENT_PACKS_KEY, next, scope.uid);
      await deps.audit({ scope, event: 'content_packs.text_updated', recordId: 'all', details: {} }).catch(() => undefined);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(adminView(next));
    } catch (error) {
      next(error);
    }
  });

  // Step 1 of an issue: a fifteen-minute link the browser uploads the file to.
  router.post('/portal/admin/content-packs/groups/:groupId/upload-url', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      const deps = depsFor();
      const groupId = groupParam.parse(req.params.groupId) as GroupId;
      if (groupId === 'C.2') throw new HttpError(400, 'Counter print is built for each pharmacy and takes no upload.', 'INVALID_INPUT');
      const input = uploadUrlSchema.parse(req.body);
      const filename = safeFilename(input.filename);
      const contentType = contentTypeFor(filename);
      if (!contentType) throw new HttpError(400, 'Upload a .zip, .pdf, .docx, .xlsx, .pptx or .csv file.', 'INVALID_FILE');
      if (groupId === 'C.1' && contentType !== 'application/zip') throw new HttpError(400, 'The website kit must be a .zip file.', 'INVALID_FILE');
      if (input.sizeBytes > MAX_CONTENT_PACK_FILE_BYTES) throw new HttpError(413, 'The file must be 250 MB or smaller.', 'FILE_TOO_LARGE');
      const stamp = now(deps).toISOString().replace(/[^0-9]/g, '');
      const storagePath = contentPackStoragePath(groupId, filename, stamp, randomUUID());
      const uploadUrl = await deps.storage.generateWriteUrl(storagePath, contentType, 900);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json({ uploadUrl, storagePath, contentType, filename });
    } catch (error) {
      next(error);
    }
  });

  // Step 2: the file is in Storage; check it and make it the group's download for every pharmacy.
  router.post('/portal/admin/content-packs/groups/:groupId/issue', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const deps = depsFor();
      const groupId = groupParam.parse(req.params.groupId) as GroupId;
      if (groupId === 'C.2') throw new HttpError(400, 'Counter print is built for each pharmacy and takes no upload.', 'INVALID_INPUT');
      const input = issueSchema.parse(req.body);
      if (!belongsToGroup(input.storagePath, groupId)) throw new HttpError(400, 'That upload does not belong to this group.', 'INVALID_INPUT');
      const filename = safeFilename(input.filename);
      const contentType = contentTypeFor(filename);
      if (!contentType) throw new HttpError(400, 'Upload a .zip, .pdf, .docx, .xlsx, .pptx or .csv file.', 'INVALID_FILE');
      let issuedAt: string;
      try { issuedAt = issueDate(input.issuedOn, now(deps)); } catch { throw new HttpError(400, 'Use a date like 2026-11-19.', 'INVALID_INPUT'); }
      const meta = await deps.storage.getObjectMetadata(input.storagePath);
      if (!meta.exists) throw new HttpError(409, 'The upload did not finish. Choose the file and try again.', 'UPLOAD_MISSING');
      if (meta.sizeBytes > MAX_CONTENT_PACK_FILE_BYTES) {
        await deps.storage.deleteFile(input.storagePath).catch(() => undefined);
        throw new HttpError(413, 'The file must be 250 MB or smaller.', 'FILE_TOO_LARGE');
      }
      if (!looksRight(await deps.storage.readPrefix(input.storagePath, 512), contentType)) {
        await deps.storage.deleteFile(input.storagePath).catch(() => undefined);
        throw new HttpError(400, `That file is not a real ${filename.split('.').pop()} file.`, 'INVALID_FILE');
      }
      const { config, replaced } = issueGroup(await read(deps), groupId, {
        version: input.version,
        issuedAt,
        file: { storagePath: input.storagePath, filename, contentType, sizeBytes: meta.sizeBytes },
      });
      try {
        await deps.content.write(CONTENT_PACKS_KEY, config, scope.uid);
      } catch (error) {
        // Not issued after all: don't leave the new file behind in Storage.
        await deps.storage.deleteFile(input.storagePath).catch(() => undefined);
        throw error;
      }
      if (replaced && replaced.storagePath !== input.storagePath) await deps.storage.deleteFile(replaced.storagePath).catch(() => undefined);
      await deps.audit({ scope, event: replaced ? 'content_packs.group_reissued' : 'content_packs.group_issued', recordId: groupId, details: { version: input.version, issuedOn: input.issuedOn, filename, sizeBytes: meta.sizeBytes } }).catch(() => undefined);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(adminView(config));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/portal/admin/content-packs/groups/:groupId/file', requireCsrf, requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const scope = assertPlatformScope(req.context!);
      const deps = depsFor();
      const groupId = groupParam.parse(req.params.groupId) as GroupId;
      const { config, removed } = withdrawGroup(await read(deps), groupId);
      await deps.content.write(CONTENT_PACKS_KEY, config, scope.uid);
      if (removed) await deps.storage.deleteFile(removed.storagePath).catch(() => undefined);
      await deps.audit({ scope, event: 'content_packs.group_withdrawn', recordId: groupId, details: {} }).catch(() => undefined);
      res.setHeader('Cache-Control', 'private, no-store');
      res.status(200).json(adminView(config));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
