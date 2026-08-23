import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { isTenantScope } from '../../security/request-context.js';
import { requirePharmacyOperationalWrites } from './require-operational-writes.js';

function nextResult(req: Partial<Request>) {
  return new Promise<{ error: unknown }>(resolve => {
    const next: NextFunction = (error?: unknown) => resolve({ error });
    void requirePharmacyOperationalWrites(req as Request, {} as Response, next);
  });
}

describe('requirePharmacyOperationalWrites', () => {
  it('treats a missing request context as not a pharmacy tenant', () => {
    assert.equal(isTenantScope(undefined), false);
  });

  it('lets admin and unmatched portal writes continue instead of crashing', async () => {
    const { error } = await nextResult({ method: 'POST', context: undefined });
    assert.equal(error, undefined);
  });
});
