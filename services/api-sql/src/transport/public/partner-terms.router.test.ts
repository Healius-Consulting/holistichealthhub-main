import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ONBOARDING_CONTENT_KEYS } from '../../domain/pharmacy-onboarding/content.js';
import { createPublicPartnerTermsRouter } from './partner-terms.router.js';

async function get(stored: Record<string, unknown>) {
  const app = express();
  app.use('/v1', createPublicPartnerTermsRouter({ read: async () => stored }));
  app.use((error: { statusCode?: number; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ code: error.code });
  });
  const server = app.listen(0);
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/v1/public/partner-terms`);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } finally {
    server.close();
  }
}

test('the Partner Terms are public only once published with text', async () => {
  assert.deepEqual(await get({}), { status: 404, body: { code: 'NOT_FOUND' } });
  assert.equal((await get({ [ONBOARDING_CONTENT_KEYS.partnerTerms]: { published: false, version: 'v1', text: 'Terms' } })).status, 404);
  assert.equal((await get({ [ONBOARDING_CONTENT_KEYS.partnerTerms]: { published: true, version: 'v1', text: '   ' } })).status, 404);
  assert.deepEqual(
    await get({ [ONBOARDING_CONTENT_KEYS.partnerTerms]: { published: true, version: 'v1.0', text: 'Clause 1.\n\nClause 2.' } }),
    { status: 200, body: { version: 'v1.0', text: 'Clause 1.\n\nClause 2.' } },
  );
});
