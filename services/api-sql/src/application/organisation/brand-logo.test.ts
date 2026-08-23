import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../../domain/common/errors.js';
import {
  EMAIL_LOGO_CONTENT_TYPE,
  EMAIL_LOGO_HEIGHT,
  EMAIL_LOGO_WIDTH,
  assertBrandLogoPath,
  authoriseBrandLogoUpload,
  completeBrandLogoUpload,
  removeBrandLogo,
} from './brand-logo.js';

const organisationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function pngHeader(width = EMAIL_LOGO_WIDTH, height = EMAIL_LOGO_HEIGHT) {
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

describe('brand logo paths', () => {
  it('accepts a pharmacy-branding path for the same organisation', () => {
    assert.doesNotThrow(() => assertBrandLogoPath(organisationId, `pharmacy-branding/${organisationId}/email-logo-123.png`));
  });

  it('rejects a path for another organisation or a traversal', () => {
    assert.throws(
      () => assertBrandLogoPath(organisationId, 'pharmacy-branding/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/email-logo-123.png'),
      (error: unknown) => error instanceof HttpError && error.code === 'INVALID_LOGO_PATH',
    );
    assert.throws(
      () => assertBrandLogoPath(organisationId, `pharmacy-branding/${organisationId}/../secret.png`),
      (error: unknown) => error instanceof HttpError && error.code === 'INVALID_LOGO_PATH',
    );
  });
});

describe('brand logo replace and remove', () => {
  it('authorises a PNG upload and replaces the previous file on complete', async () => {
    const deleted: string[] = [];
    const files = [
      { storagePath: `pharmacy-branding/${organisationId}/email-logo-old.png`, updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    const storage = {
      async generateWriteUrl(storagePath: string) {
        return `https://upload.example/${storagePath}`;
      },
      async getObjectMetadata() {
        return { exists: true, sizeBytes: 1200, contentType: EMAIL_LOGO_CONTENT_TYPE };
      },
      async readPrefix() {
        return pngHeader();
      },
      async listPaths() {
        return files;
      },
      async deleteFile(storagePath: string) {
        deleted.push(storagePath);
      },
      async generateDownloadUrl(storagePath: string) {
        return `https://read.example/${storagePath}`;
      },
    };

    const target = await authoriseBrandLogoUpload(storage, organisationId, {
      filename: 'k-chem.png',
      contentType: EMAIL_LOGO_CONTENT_TYPE,
      sizeBytes: 1200,
    });
    assert.match(target.storagePath, new RegExp(`^pharmacy-branding/${organisationId}/email-logo-.+\\.png$`));
    files.push({ storagePath: target.storagePath, updatedAt: '2026-08-23T00:00:00.000Z' });

    const completed = await completeBrandLogoUpload(storage, organisationId, target.storagePath);
    assert.equal(completed.emailLogoStoragePath, target.storagePath);
    assert.equal(completed.emailLogoWidth, EMAIL_LOGO_WIDTH);
    assert.deepEqual(deleted, [`pharmacy-branding/${organisationId}/email-logo-old.png`]);
  });

  it('removes every stored logo for the pharmacy', async () => {
    const deleted: string[] = [];
    const removed = await removeBrandLogo({
      async listPaths() {
        return [
          { storagePath: `pharmacy-branding/${organisationId}/email-logo-a.png`, updatedAt: null },
          { storagePath: `pharmacy-branding/${organisationId}/email-logo-b.png`, updatedAt: null },
        ];
      },
      async deleteFile(storagePath: string) {
        deleted.push(storagePath);
      },
    }, organisationId);
    assert.equal(removed.emailLogoStoragePath, null);
    assert.equal(deleted.length, 2);
  });
});
