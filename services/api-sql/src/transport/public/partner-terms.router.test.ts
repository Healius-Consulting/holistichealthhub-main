import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express, { type NextFunction, type Request, type Response } from 'express';
import { PARTNER_TERMS_SETTINGS_KEY } from '../../application/pharmacy-onboarding/partner-terms.service.js';
import type { PartnerTermsDocumentRecord } from '../../domain/pharmacy-onboarding/partner-terms.js';
import type { PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';
import { createPublicPartnerTermsRouter, type PublicPartnerTermsDeps } from './partner-terms.router.js';

const DOC = '11111111-1111-4111-8111-111111111111';
const REQUEST = '33333333-3333-4333-8333-333333333333';
const document: PartnerTermsDocumentRecord = {
  id: DOC, version: 'v1.0', storagePath: 'partner-terms/v1.pdf', filename: 'v1.pdf', sizeBytes: 9, uploadedAt: '2026-11-19T09:00:00Z',
  uploadedByUid: 'admin', publishedAt: '2026-11-19T09:05:00Z', publishedByUid: 'admin', withdrawnAt: null, withdrawnByUid: null,
};

function deps(options: { enabled?: boolean; status?: string; accepted?: boolean } = {}): PublicPartnerTermsDeps {
  return {
    content: { read: async () => ({ [PARTNER_TERMS_SETTINGS_KEY]: { enabled: options.enabled ?? false, currentDocumentId: DOC } }) },
    repo: { findDocument: async id => (id === DOC ? document : null) },
    requests: {
      findById: async id => (id === REQUEST ? { id, status: options.status ?? 'PENDING' } as PharmacyOnboardingRequestRecord : null),
      findTermsAcceptances: async () => (options.accepted ? [{ id: 'a' }] as never : []),
    },
    storage: { downloadFile: async () => ({ bytes: Buffer.from('%PDF-1.7 terms') }) },
  };
}

async function call(path: string, given: PublicPartnerTermsDeps) {
  const app = express();
  app.use('/v1', createPublicPartnerTermsRouter(() => given));
  app.use((error: { statusCode?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ code: error.code });
  });
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/v1${path}`);
    return { status: response.status, type: response.headers.get('content-type'), text: await response.text() };
  } finally {
    server.close();
  }
}

test('sign-up learns whether the Partner Terms are required, and the version, but never gets a public file link', async () => {
  assert.deepEqual(JSON.parse((await call('/public/partner-terms', deps())).text), { required: false, version: null });
  assert.deepEqual(JSON.parse((await call('/public/partner-terms', deps({ enabled: true }))).text), { required: true, version: 'v1.0' });
});

test('the PDF is served only to a pending request that still has to sign, while the Terms are on', async () => {
  const ok = await call(`/public/partner-terms/file?request=${REQUEST}`, deps({ enabled: true }));
  assert.equal(ok.status, 200);
  assert.equal(ok.type, 'application/pdf');
  assert.equal((await call(`/public/partner-terms/file?request=${REQUEST}`, deps({ enabled: false }))).status, 404);
  assert.equal((await call(`/public/partner-terms/file?request=${REQUEST}`, deps({ enabled: true, accepted: true }))).status, 404);
  assert.equal((await call(`/public/partner-terms/file?request=${REQUEST}`, deps({ enabled: true, status: 'ACTIVATED' }))).status, 404);
  assert.equal((await call('/public/partner-terms/file?request=44444444-4444-4444-8444-444444444444', deps({ enabled: true }))).status, 404);
});
