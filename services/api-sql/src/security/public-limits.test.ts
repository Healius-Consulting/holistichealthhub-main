import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import express, { type Request } from 'express';
import type { AddressInfo } from 'node:net';
import {
  ONBOARDING_FORM_LIMIT_PER_HOUR,
  publicClientIp,
  publicCuraleafFormLimiter,
  publicPartnerTermsLimiter,
  publicWorldpayFormLimiter,
} from './public-limits.js';

function requestWith(headers: Record<string, string | undefined>, ip?: string): Request {
  return {
    ip,
    headers: {
      'x-forwarded-for': headers['x-forwarded-for'],
    },
  } as unknown as Request;
}

describe('publicClientIp', () => {
  it('uses the original client address in front of Vercel and Cloud Run hops', () => {
    assert.equal(
      publicClientIp(requestWith({ 'x-forwarded-for': '203.0.113.10, 76.76.21.21, 169.254.1.1' })),
      '203.0.113.10',
    );
  });
});

describe('pharmacy onboarding form limits', () => {
  it('counts each form on its own, so a few Curaleaf retries never block the Terms or Worldpay', async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.post('/curaleaf', publicCuraleafFormLimiter, (_req, res) => { res.status(400).end(); });
    app.post('/terms', publicPartnerTermsLimiter, (_req, res) => { res.status(201).end(); });
    app.post('/worldpay', publicWorldpayFormLimiter, (_req, res) => { res.status(201).end(); });
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const send = (path: string) => fetch(`${base}${path}`, { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.77' } }).then(res => res.status);
      // A pharmacy fixing its Curaleaf form several times, failed attempts included.
      for (let attempt = 0; attempt < ONBOARDING_FORM_LIMIT_PER_HOUR; attempt++) assert.equal(await send('/curaleaf'), 400);
      assert.equal(await send('/curaleaf'), 429, 'the Curaleaf form still has a limit');
      assert.equal(await send('/terms'), 201, 'the Terms are counted separately');
      assert.equal(await send('/worldpay'), 201, 'so is Worldpay');
    } finally {
      server.close();
    }
  });

  it('leaves room to correct a form a few times', () => {
    assert.ok(ONBOARDING_FORM_LIMIT_PER_HOUR >= 5);
  });
});
