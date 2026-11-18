import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../../domain/common/errors.js';
import {
  canAcceptPublicIntake,
  canActivateReferredPatient,
  pharmacyOperationalAccess,
  pharmacyPortalRecordAccess,
} from '../../domain/organisation/access.js';
import { assertCuraleafTestPaymentAllowed } from '../../domain/organisation/curaleaf-payment-lock.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import { SqlOrganisationRepository } from '../../repositories/sql/organisation.sql.js';
import { requirePharmacyOperationalWrites } from './require-operational-writes.js';

/**
 * Step 1 (2.1): a pharmacy awaiting Curaleaf (ONBOARDING) has its eligibility link on
 * from Activate. Eligible patients are accepted and wait in its list, but nothing it
 * does may reach Curaleaf, create an order or take a payment until it is LIVE.
 */

const here = dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(join(here, file), 'utf8');

const awaitingCuraleaf: OrganisationRecord = {
  id: '3f9b1c2d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', companyId: null, name: 'Awaiting Pharmacy',
  tradingName: 'Awaiting Pharmacy Ltd', gphcNumber: '1123456', superintendentName: 'Test Pharmacist',
  mainContactName: null, mainContactPhone: null, mainContactEmail: null, address: 'Test address',
  addressLine1: null, addressLine2: null, locality: null, county: null, postcode: null, latitude: null, longitude: null,
  primaryColour: '#0f766e', logoText: 'AP', status: 'ONBOARDING', classification: 'STANDARD',
  portalName: 'Awaiting Pharmacy', intakeEnabled: true, prescriptionEnabled: true, paymentsEnabled: true,
  supplierOrdersEnabled: true, patientsEnabled: true, resourcesEnabled: true, worldpayEnabled: false,
  defaultPaymentRoute: 'MANUAL', pharmacyDeliveryEnabled: false, autoPlacementEnabled: false, gdprComplianceFlag: true,
  pausedReason: null, pausedAt: null, version: 1, archivedAt: null,
};

const realFind = SqlOrganisationRepository.prototype.findOrganisationById;
let stored: OrganisationRecord | null = awaitingCuraleaf;
SqlOrganisationRepository.prototype.findOrganisationById = async () => stored;
after(() => { SqlOrganisationRepository.prototype.findOrganisationById = realFind; });

const tenant = (organisationId: string) => ({
  kind: 'tenant', organisationId, uid: 'staff-1', email: null, role: 'PHARMACY_STAFF', surface: 'pharmacy',
  sessionHash: 'hash', requestId: 'request-1', idleExpiresAt: '', absoluteExpiresAt: '',
});

function run(req: Partial<Request>) {
  return new Promise<unknown>(resolve => {
    const next: NextFunction = (error?: unknown) => resolve(error);
    void requirePharmacyOperationalWrites(req as Request, {} as Response, next);
  });
}

describe('a pharmacy awaiting Curaleaf before Live', () => {
  it('takes eligible patients into its list but has no orders', () => {
    assert.equal(canAcceptPublicIntake(awaitingCuraleaf), true);
    assert.equal(canActivateReferredPatient(awaitingCuraleaf), true);
    assert.equal(pharmacyOperationalAccess(awaitingCuraleaf), false);
    assert.deepEqual(pharmacyPortalRecordAccess(awaitingCuraleaf), { patients: true, orders: false, pendingEnquiries: true });
    assert.equal(pharmacyOperationalAccess({ ...awaitingCuraleaf, status: 'LIVE' }), true);
  });

  it('is refused with a 409 on any order, payment or Curaleaf write from its staff', async () => {
    stored = awaitingCuraleaf;
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const error = await run({ method, context: tenant(awaitingCuraleaf.id) as Request['context'] });
      assert.ok(error instanceof HttpError, `${method} is refused`);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'WORKSPACE_NOT_LIVE');
      assert.match(error.message, /once this pharmacy is live/);
    }
  });

  it('lets the same writes through once the pharmacy is live, and never blocks reads or HHH admin', async () => {
    stored = { ...awaitingCuraleaf, status: 'LIVE' };
    assert.equal(await run({ method: 'POST', context: tenant(awaitingCuraleaf.id) as Request['context'] }), undefined);
    stored = awaitingCuraleaf;
    assert.equal(await run({ method: 'GET', context: tenant(awaitingCuraleaf.id) as Request['context'] }), undefined);
    assert.equal(await run({ method: 'POST', context: { kind: 'platform' } as Request['context'] }), undefined);
  });

  it('cannot create an order or take payment on Curaleaf test credentials either', () => {
    assert.throws(
      () => assertCuraleafTestPaymentAllowed(awaitingCuraleaf, 'TEST'),
      (error: unknown) => error instanceof HttpError && error.statusCode === 409 && error.code === 'CURALEAF_TEST_PAYMENT_LOCKED',
    );
  });
});

describe('every pharmacy order, payment and Curaleaf write route is shut until Live', () => {
  // Prescription upload, order drafts, order creation and placement, cancellation,
  // manual and Worldpay payment, payment links, refunds, collection and goods-in.
  for (const file of ['order.router.ts', 'payment.router.ts', 'prescription.router.ts', 'prescription-refund.router.ts', 'fulfilment.router.ts']) {
    it(`guards each pharmacy write in ${file}`, () => {
      const writes = source(file).split('\n').filter(line => /router\.(post|patch|put|delete)\(/.test(line) && /requireStaff\('pharmacy'\)/.test(line));
      assert.ok(writes.length > 0, `${file} has pharmacy write routes`);
      for (const line of writes) assert.match(line, /requirePharmacyOperationalWrites/, line.trim());
    });
  }

  it('names the paths that would otherwise reach Curaleaf or take money', () => {
    const routes: Array<[string, string]> = [
      ['order.router.ts', "'/portal/orders'"],
      ['order.router.ts', "'/portal/orders/:id/prescriptions/:prescriptionId/place'"],
      ['payment.router.ts', "'/portal/orders/:id/payments/manual'"],
      ['payment.router.ts', "'/portal/orders/:id/payments/worldpay-session'"],
      ['payment.router.ts', "'/portal/orders/:id/payment-links/resend'"],
      ['prescription.router.ts', "'/portal/prescription-files/upload-target'"],
      ['prescription.router.ts', "'/portal/prescription-serials/availability'"],
      ['integration.router.ts', "'/portal/integrations/curaleaf/quote'"],
      ['integration.router.ts', "'/portal/integrations/curaleaf/prescriptions/scan'"],
    ];
    for (const [file, route] of routes) {
      const line = source(file).split('\n').find(candidate => candidate.includes(`router.post(${route}`));
      assert.ok(line, `${route} is registered in ${file}`);
      assert.match(line, /requirePharmacyOperationalWrites/, `${route} is shut until Live`);
    }
  });

  it('records an accepted referral as REFERRED, so no patient fee accrues until a Curaleaf order is placed', () => {
    const intakeSql = readFileSync(join(here, '../../repositories/sql/intake.sql.ts'), 'utf8');
    const insert = intakeSql.slice(intakeSql.indexOf('patient_insert(data: {'));
    assert.match(insert.slice(0, 600), /status: REFERRED/);
  });
});
