import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../../domain/common/errors.js';
import {
  applyContentPacksText,
  CONTENT_PACKS_KEY,
  contentPacksTextSchema,
  contentTypeFor,
  GROUP_IDS,
  groupVisible,
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
const versionHeader = z.string().trim().min(1, 'Give the version a name, such as v1.2.').max(40);

export interface ContentPacksRouterDeps {
  content: PlatformContentRepository;
  storage: {
    saveObject(path: string, bytes: Buffer, contentType: string): Promise<unknown>;
    downloadFile(path: string): Promise<{ bytes: Buffer }>;
    deleteFile(path: string): Promise<unknown>;
  };
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

function requestRawBody(req: Request) {
  const raw = (req as Request & { rawBody?: Buffer | Uint8Array }).rawBody;
  if (raw) return Buffer.from(raw);
  return Buffer.isBuffer(req.body) ? req.body : null;
}

/** The file's first bytes must match what its name says it is. */
function looksRight(bytes: Buffer, contentType: string) {
  const head = bytes.subarray(0, 5).toString('latin1');
  if (contentType === 'application/pdf') return head === '%PDF-';
  if (contentType === 'text/csv') return !bytes.subarray(0, 512).includes(0);
  // zip, docx and xlsx are all zip archives.
  return head.startsWith('PK\u0003\u0004');
}

function sendFile(res: Response, bytes: Buffer, filename: string, contentType: string) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Type', contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/["\\\r\n]/g, '')}"`);
  res.status(200).send(bytes);
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
 */
export function createPortalContentPacksRouter(depsFor: () => ContentPacksRouterDeps = sqlDeps): Router {
  const router = Router();
  const now = (deps: ContentPacksRouterDeps) => (deps.now ? deps.now() : new Date());
  const read = async (deps: ContentPacksRouterDeps) => resolveContentPacks((await deps.content.read([CONTENT_PACKS_KEY]))[CONTENT_PACKS_KEY]);

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

  router.get('/portal/content-packs/groups/:groupId/file', requireStaff('pharmacy'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertTenantScope(req.context!);
      const deps = depsFor();
      const group = (await read(deps)).groups.find(entry => entry.id === groupParam.parse(req.params.groupId));
      if (!group?.file) throw new HttpError(404, 'This download is not available yet.', 'NOT_FOUND');
      const file = await deps.storage.downloadFile(group.file.storagePath);
      sendFile(res, file.bytes, group.file.filename, group.file.contentType);
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

  router.get('/portal/admin/content-packs/groups/:groupId/file', requireStaff('admin'), async (req: Request, res: Response, next: NextFunction) => {
    try {
      assertPlatformScope(req.context!);
      const deps = depsFor();
      const group = (await read(deps)).groups.find(entry => entry.id === groupParam.parse(req.params.groupId));
      if (!group?.file) throw new HttpError(404, 'No file has been issued for this group.', 'NOT_FOUND');
      const file = await deps.storage.downloadFile(group.file.storagePath);
      sendFile(res, file.bytes, group.file.filename, group.file.contentType);
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

  // Issue or re-issue a group: the new file replaces the download for every pharmacy.
  router.put(
    '/portal/admin/content-packs/groups/:groupId/file',
    requireCsrf,
    requireStaff('admin'),
    express.raw({ type: () => true, limit: MAX_CONTENT_PACK_FILE_BYTES }),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const scope = assertPlatformScope(req.context!);
        const deps = depsFor();
        const groupId = groupParam.parse(req.params.groupId) as GroupId;
        if (groupId === 'C.2') throw new HttpError(400, 'Counter print is built for each pharmacy and takes no upload.', 'INVALID_INPUT');
        const version = versionHeader.parse(decodeURIComponent(String(req.headers['x-version'] ?? '')));
        const filename = safeFilename(decodeURIComponent(String(req.headers['x-filename'] ?? '')));
        const contentType = contentTypeFor(filename);
        if (!contentType) throw new HttpError(400, 'Upload a .zip, .pdf, .docx, .xlsx or .csv file.', 'INVALID_FILE');
        if (groupId === 'C.1' && contentType !== 'application/zip') throw new HttpError(400, 'The website kit must be a .zip file.', 'INVALID_FILE');
        const bytes = requestRawBody(req);
        if (!bytes || bytes.length === 0) throw new HttpError(400, 'Choose a file to upload.', 'INVALID_INPUT');
        if (bytes.length > MAX_CONTENT_PACK_FILE_BYTES) throw new HttpError(413, 'The file must be 25 MB or smaller.', 'FILE_TOO_LARGE');
        if (!looksRight(bytes, contentType)) throw new HttpError(400, `That file is not a real ${filename.split('.').pop()} file.`, 'INVALID_FILE');
        const issuedAt = now(deps).toISOString();
        const storagePath = `content-packs/${groupId}/${issuedAt.replace(/[^0-9]/g, '')}-${randomUUID()}-${filename.replace(/\s+/g, '-')}`;
        await deps.storage.saveObject(storagePath, bytes, contentType);
        const { config, replaced } = issueGroup(await read(deps), groupId, {
          version,
          issuedAt,
          file: { storagePath, filename, contentType, sizeBytes: bytes.length },
        });
        await deps.content.write(CONTENT_PACKS_KEY, config, scope.uid);
        if (replaced) await deps.storage.deleteFile(replaced.storagePath).catch(() => undefined);
        await deps.audit({ scope, event: replaced ? 'content_packs.group_reissued' : 'content_packs.group_issued', recordId: groupId, details: { version, filename, sizeBytes: bytes.length } }).catch(() => undefined);
        res.setHeader('Cache-Control', 'private, no-store');
        res.status(200).json(adminView(config));
      } catch (error) {
        next(error);
      }
    },
  );

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
