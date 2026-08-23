import { Storage } from '@google-cloud/storage';
import { config } from '../../bootstrap/config.js';
import { HttpError } from '../../domain/common/errors.js';
import { MAX_PRESCRIPTION_UPLOAD_BYTES } from './upload-constraints.js';

function wrapStorageError(error: unknown, fallback: HttpError): never {
  if (error instanceof HttpError) throw error;
  console.error('Storage operation failed:', error instanceof Error ? error.message : 'unknown');
  throw fallback;
}

export interface SignedUploadTarget {
  id: string;
  storagePath: string;
  uploadUrl: string;
  expiresAt: string;
  requiredHeaders: Record<string, string>;
}

export class StorageProvider {
  private readonly storage: Storage;
  private readonly bucketName: string;

  constructor() {
    this.storage = new Storage({ projectId: config.FIREBASE_PROJECT_ID });
    this.bucketName = `${config.FIREBASE_PROJECT_ID}.firebasestorage.app`;
  }

  async generateUploadTarget(params: {
    organisationId: string;
    fileId: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    expiresInSeconds?: number;
  }): Promise<SignedUploadTarget> {
    const { organisationId, fileId, filename, contentType, sizeBytes, expiresInSeconds = 900 } = params;
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `prescriptions/${organisationId}/${fileId}/${sanitizedFilename}`;
    const maxBytes = Math.min(Math.max(1, sizeBytes), MAX_PRESCRIPTION_UPLOAD_BYTES);
    const contentLengthRange = `1,${maxBytes}`;

    const bucket = this.storage.bucket(this.bucketName);
    const file = bucket.file(storagePath);

    try {
      const [uploadUrl] = await file.getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: Date.now() + expiresInSeconds * 1000,
        contentType,
        extensionHeaders: {
          'x-goog-content-length-range': contentLengthRange,
        },
      });

      return {
        id: fileId,
        storagePath,
        uploadUrl,
        expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
        requiredHeaders: {
          'Content-Type': contentType,
          'x-goog-content-length-range': contentLengthRange,
        },
      };
    } catch (error) {
      wrapStorageError(error, new HttpError(503, 'A secure upload location could not be created.', 'STORAGE_SIGN_FAILED'));
    }
  }

  async getObjectMetadata(storagePath: string): Promise<{ exists: boolean; sizeBytes: number; contentType: string | null }> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const file = bucket.file(storagePath);
      const [exists] = await file.exists();
      if (!exists) return { exists: false, sizeBytes: 0, contentType: null };
      const [metadata] = await file.getMetadata();
      const sizeBytes = Number(metadata.size ?? 0);
      return {
        exists: true,
        sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0,
        contentType: typeof metadata.contentType === 'string' ? metadata.contentType : null,
      };
    } catch (error) {
      wrapStorageError(error, new HttpError(503, 'The uploaded prescription could not be verified in storage.', 'STORAGE_METADATA_FAILED'));
    }
  }

  async readPrefix(storagePath: string, byteCount = 16): Promise<Buffer> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const file = bucket.file(storagePath);
      const [bytes] = await file.download({ start: 0, end: Math.max(0, byteCount - 1) });
      return bytes;
    } catch (error) {
      wrapStorageError(error, new HttpError(503, 'The uploaded prescription could not be read from storage.', 'STORAGE_READ_FAILED'));
    }
  }

  async readCustomMetadata(storagePath: string): Promise<Record<string, string>> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const file = bucket.file(storagePath);
      const [exists] = await file.exists();
      if (!exists) return {};
      const [metadata] = await file.getMetadata();
      const custom = metadata.metadata;
      if (!custom || typeof custom !== 'object') return {};
      return Object.fromEntries(
        Object.entries(custom).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      );
    } catch (error) {
      wrapStorageError(error, new HttpError(503, 'The uploaded prescription could not be verified in storage.', 'STORAGE_METADATA_FAILED'));
    }
  }

  async patchCustomMetadata(storagePath: string, patch: Record<string, string>): Promise<void> {
    try {
      const existing = await this.readCustomMetadata(storagePath);
      const bucket = this.storage.bucket(this.bucketName);
      const file = bucket.file(storagePath);
      await file.setMetadata({ metadata: { ...existing, ...patch } });
    } catch (error) {
      console.warn('Storage metadata update failed:', error instanceof Error ? error.message : 'unknown');
    }
  }

  async generateWriteUrl(storagePath: string, contentType: string, expiresInSeconds = 900): Promise<string> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const file = bucket.file(storagePath);
      const [uploadUrl] = await file.getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: Date.now() + expiresInSeconds * 1000,
        contentType,
      });
      return uploadUrl;
    } catch (error) {
      wrapStorageError(error, new HttpError(503, 'A secure upload location could not be created.', 'STORAGE_SIGN_FAILED'));
    }
  }

  async listPaths(prefix: string): Promise<Array<{ storagePath: string; updatedAt: string | null }>> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const [files] = await bucket.getFiles({ prefix });
      return files.map(file => ({
        storagePath: file.name,
        updatedAt: typeof file.metadata.updated === 'string' ? file.metadata.updated : null,
      }));
    } catch (error) {
      wrapStorageError(error, new HttpError(503, 'Stored pharmacy files could not be listed.', 'STORAGE_LIST_FAILED'));
    }
  }

  async generateDownloadUrl(storagePath: string, expiresInSeconds = 300): Promise<string> {
    const bucket = this.storage.bucket(this.bucketName);
    const file = bucket.file(storagePath);

    const [downloadUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + expiresInSeconds * 1000,
    });

    return downloadUrl;
  }

  async deleteFile(storagePath: string): Promise<void> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const file = bucket.file(storagePath);
      await file.delete({ ignoreNotFound: true });
    } catch (error) {
      console.warn(`Storage delete failed for ${storagePath}:`, error);
    }
  }

  async downloadFile(storagePath: string): Promise<{ bytes: Buffer; contentType: string | null }> {
    try {
      const bucket = this.storage.bucket(this.bucketName);
      const file = bucket.file(storagePath);
      const [exists] = await file.exists();
      if (!exists) {
        throw new HttpError(409, 'Complete the prescription file upload first.', 'UPLOAD_INCOMPLETE');
      }
      const [bytes] = await file.download();
      const [metadata] = await file.getMetadata();
      return {
        bytes,
        contentType: typeof metadata.contentType === 'string' ? metadata.contentType : null,
      };
    } catch (error) {
      wrapStorageError(error, new HttpError(503, 'The prescription file could not be read from storage.', 'STORAGE_READ_FAILED'));
    }
  }
}
