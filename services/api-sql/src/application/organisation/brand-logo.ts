import { randomUUID } from 'node:crypto';
import { HttpError } from '../../domain/common/errors.js';
import { asUuid } from '../../domain/common/uuid.js';
import type { StorageProvider } from '../../providers/storage/storage.provider.js';

export const EMAIL_LOGO_WIDTH = 640;
export const EMAIL_LOGO_HEIGHT = 192;
export const MAX_EMAIL_LOGO_BYTES = 2_000_000;
export const EMAIL_LOGO_CONTENT_TYPE = 'image/png';
const EMAIL_LOGO_PREFIX = 'pharmacy-branding';
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface OrganisationLogoView {
  emailLogoUrl: string | null;
  emailLogoStoragePath: string | null;
  emailLogoWidth: number | null;
  emailLogoHeight: number | null;
  emailLogoUpdatedAt: string | null;
}

export function brandLogoPrefix(organisationId: string) {
  return `${EMAIL_LOGO_PREFIX}/${asUuid(organisationId)}/`;
}

export function brandLogoStoragePath(organisationId: string) {
  return `${brandLogoPrefix(organisationId)}email-logo-${randomUUID()}.png`;
}

export function assertBrandLogoPath(organisationId: string, storagePath: string) {
  const expectedPrefix = `${brandLogoPrefix(organisationId)}email-logo-`;
  if (!storagePath.startsWith(expectedPrefix) || !storagePath.endsWith('.png') || storagePath.includes('..')) {
    throw new HttpError(400, 'The logo upload path is invalid.', 'INVALID_LOGO_PATH');
  }
}

function latestLogo(files: Array<{ storagePath: string; updatedAt: string | null }>) {
  return [...files].sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))[0] ?? null;
}

export async function resolveOrganisationLogo(
  storage: Pick<StorageProvider, 'listPaths' | 'generateDownloadUrl'>,
  organisationId: string,
  expiresInSeconds = 60 * 60,
): Promise<OrganisationLogoView> {
  const files = await storage.listPaths(brandLogoPrefix(organisationId));
  const current = latestLogo(files.filter(file => file.storagePath.includes('/email-logo-') && file.storagePath.endsWith('.png')));
  if (!current) {
    return {
      emailLogoUrl: null,
      emailLogoStoragePath: null,
      emailLogoWidth: null,
      emailLogoHeight: null,
      emailLogoUpdatedAt: null,
    };
  }
  return {
    emailLogoUrl: await storage.generateDownloadUrl(current.storagePath, expiresInSeconds),
    emailLogoStoragePath: current.storagePath,
    emailLogoWidth: EMAIL_LOGO_WIDTH,
    emailLogoHeight: EMAIL_LOGO_HEIGHT,
    emailLogoUpdatedAt: current.updatedAt,
  };
}

export async function resolveOrganisationLogos(
  storage: Pick<StorageProvider, 'listPaths' | 'generateDownloadUrl'>,
  organisationIds: string[],
): Promise<Map<string, OrganisationLogoView>> {
  const files = await storage.listPaths(`${EMAIL_LOGO_PREFIX}/`);
  const byOrganisation = new Map<string, Array<{ storagePath: string; updatedAt: string | null }>>();
  for (const file of files) {
    const match = file.storagePath.match(/^pharmacy-branding\/([0-9a-f-]{36})\/email-logo-/i);
    if (!match?.[1]) continue;
    const list = byOrganisation.get(match[1]) ?? [];
    list.push(file);
    byOrganisation.set(match[1], list);
  }

  const resolved = new Map<string, OrganisationLogoView>();
  await Promise.all(organisationIds.map(async organisationId => {
    const current = latestLogo(byOrganisation.get(asUuid(organisationId)) ?? []);
    if (!current) {
      resolved.set(organisationId, {
        emailLogoUrl: null,
        emailLogoStoragePath: null,
        emailLogoWidth: null,
        emailLogoHeight: null,
        emailLogoUpdatedAt: null,
      });
      return;
    }
    resolved.set(organisationId, {
      emailLogoUrl: await storage.generateDownloadUrl(current.storagePath, 60 * 60),
      emailLogoStoragePath: current.storagePath,
      emailLogoWidth: EMAIL_LOGO_WIDTH,
      emailLogoHeight: EMAIL_LOGO_HEIGHT,
      emailLogoUpdatedAt: current.updatedAt,
    });
  }));
  return resolved;
}

export async function authoriseBrandLogoUpload(
  storage: Pick<StorageProvider, 'generateWriteUrl'>,
  organisationId: string,
  input: { filename: string; contentType: string; sizeBytes: number },
) {
  if (input.contentType !== EMAIL_LOGO_CONTENT_TYPE) {
    throw new HttpError(400, 'Upload the normalised PNG logo prepared by the admin form.', 'INVALID_LOGO_TYPE');
  }
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > MAX_EMAIL_LOGO_BYTES) {
    throw new HttpError(400, 'The logo file is too large to store.', 'INVALID_LOGO_SIZE');
  }
  const storagePath = brandLogoStoragePath(organisationId);
  const uploadUrl = await storage.generateWriteUrl(storagePath, EMAIL_LOGO_CONTENT_TYPE);
  return {
    uploadUrl,
    storagePath,
    requiredHeaders: { 'Content-Type': EMAIL_LOGO_CONTENT_TYPE },
    sourceFilename: input.filename,
  };
}

export async function completeBrandLogoUpload(
  storage: Pick<StorageProvider, 'getObjectMetadata' | 'readPrefix' | 'listPaths' | 'deleteFile' | 'generateDownloadUrl'>,
  organisationId: string,
  storagePath: string,
): Promise<OrganisationLogoView> {
  assertBrandLogoPath(organisationId, storagePath);
  const metadata = await storage.getObjectMetadata(storagePath);
  if (!metadata.exists || metadata.contentType !== EMAIL_LOGO_CONTENT_TYPE || metadata.sizeBytes <= 0 || metadata.sizeBytes > MAX_EMAIL_LOGO_BYTES) {
    if (metadata.exists) await storage.deleteFile(storagePath);
    throw new HttpError(400, 'The uploaded logo is not a valid email PNG.', 'INVALID_LOGO_FILE');
  }
  const header = await storage.readPrefix(storagePath, 24);
  const pngSignature = header.length >= 24 && header.subarray(0, 8).equals(PNG_SIGNATURE);
  const width = pngSignature ? header.readUInt32BE(16) : 0;
  const height = pngSignature ? header.readUInt32BE(20) : 0;
  if (!pngSignature || width !== EMAIL_LOGO_WIDTH || height !== EMAIL_LOGO_HEIGHT) {
    await storage.deleteFile(storagePath);
    throw new HttpError(400, `Logos must be normalised to ${EMAIL_LOGO_WIDTH} × ${EMAIL_LOGO_HEIGHT} pixels.`, 'INVALID_LOGO_DIMENSIONS');
  }

  const previous = await storage.listPaths(brandLogoPrefix(organisationId));
  await Promise.all(
    previous
      .filter(file => file.storagePath !== storagePath)
      .map(file => storage.deleteFile(file.storagePath)),
  );

  return resolveOrganisationLogo(storage, organisationId);
}

export async function removeBrandLogo(
  storage: Pick<StorageProvider, 'listPaths' | 'deleteFile'>,
  organisationId: string,
): Promise<OrganisationLogoView> {
  const files = await storage.listPaths(brandLogoPrefix(organisationId));
  await Promise.all(files.map(file => storage.deleteFile(file.storagePath)));
  return {
    emailLogoUrl: null,
    emailLogoStoragePath: null,
    emailLogoWidth: null,
    emailLogoHeight: null,
    emailLogoUpdatedAt: null,
  };
}
