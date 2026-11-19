import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../../domain/common/errors.js';
import { assertPharmacyOpenForSession } from './session.service.js';

const hold = {
  reason: 'EXISTING_CURALEAF_CUSTOMER' as const,
  heading: 'Your application is on hold',
  paragraphs: ['Curaleaf Laboratories have told us that Shah Pharmacy already has an account with them.'],
  footer: 'Questions? Email onboarding@holistichealthhub.live',
};

describe('password sign-in for a pharmacy that is not open', () => {
  it('refuses a held branch with 403 PHARMACY_ON_HOLD and its hold message in details.hold', async () => {
    const looked: string[] = [];
    await assert.rejects(
      () => assertPharmacyOpenForSession(
        { organisationId: 'org-1', organisation: { status: 'ON_HOLD' } },
        async organisationId => { looked.push(organisationId); return hold; },
      ),
      (error: unknown) => error instanceof HttpError
        && error.statusCode === 403
        && error.code === 'PHARMACY_ON_HOLD'
        && JSON.stringify(error.details) === JSON.stringify({ hold }),
    );
    assert.deepEqual(looked, ['org-1']);
  });

  it('still refuses a held branch when its hold message cannot be read', async () => {
    await assert.rejects(
      () => assertPharmacyOpenForSession({ organisationId: 'org-1', organisation: { status: 'ON_HOLD' } }, async () => { throw new Error('down'); }),
      (error: unknown) => error instanceof HttpError && error.code === 'PHARMACY_ON_HOLD' && JSON.stringify(error.details) === '{"hold":null}',
    );
  });

  it('refuses a suspended pharmacy as before, and lets every other status through', async () => {
    await assert.rejects(
      () => assertPharmacyOpenForSession({ organisationId: 'org-1', organisation: { status: 'PAUSED' } }, async () => hold),
      (error: unknown) => error instanceof HttpError && error.code === 'PHARMACY_SUSPENDED',
    );
    for (const status of ['ONBOARDING', 'INTAKE_LIVE', 'LIVE']) {
      await assertPharmacyOpenForSession({ organisationId: 'org-1', organisation: { status } }, async () => hold);
    }
  });
});
