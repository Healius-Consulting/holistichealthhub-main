import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attachPublicPharmacyLogo } from './public-pharmacy-logo.js';

const pharmacy = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Eastwood Health',
};

describe('attachPublicPharmacyLogo', () => {
  it('adds the uploaded logo download URL when one exists', async () => {
    const attached = await attachPublicPharmacyLogo({
      async listPaths() {
        return [{ storagePath: `pharmacy-branding/${pharmacy.id}/email-logo-1.png`, updatedAt: '2026-09-01T00:00:00.000Z' }];
      },
      async generateDownloadUrl() {
        return 'https://storage.googleapis.com/logo.png';
      },
    }, pharmacy);
    assert.equal(attached.logoUrl, 'https://storage.googleapis.com/logo.png');
    assert.equal(attached.name, pharmacy.name);
  });

  it('keeps the form working when the pharmacy has not uploaded a logo', async () => {
    const attached = await attachPublicPharmacyLogo({
      async listPaths() {
        return [];
      },
      async generateDownloadUrl() {
        throw new Error('should not sign');
      },
    }, pharmacy);
    assert.equal(attached.logoUrl, null);
  });

  it('falls back to no logo when storage is unavailable', async () => {
    const attached = await attachPublicPharmacyLogo({
      async listPaths() {
        throw new Error('bucket down');
      },
      async generateDownloadUrl() {
        return 'https://storage.googleapis.com/logo.png';
      },
    }, pharmacy);
    assert.equal(attached.logoUrl, null);
  });
});
