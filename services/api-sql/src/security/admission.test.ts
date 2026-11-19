import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validatePortalAdmission } from './admission.js';
import {
  SYNTHETIC_PHARMACY_A_ID,
  SYNTHETIC_STAFF_ADMIN,
  SYNTHETIC_STAFF_DISABLED,
  SYNTHETIC_STAFF_PHARMACY_A,
  createSyntheticSession,
} from '../testing/synthetic-fixtures.js';

describe('validatePortalAdmission', () => {
  const dummyClaims = {
    uid: SYNTHETIC_STAFF_PHARMACY_A.uid,
    email: SYNTHETIC_STAFF_PHARMACY_A.email,
    role: 'pharmacy_staff',
    organisationId: SYNTHETIC_PHARMACY_A_ID,
    email_verified: true,
  } as any;

  it('approves a valid, active pharmacy staff session', () => {
    const session = createSyntheticSession('test-cookie-1', SYNTHETIC_STAFF_PHARMACY_A);
    const failure = validatePortalAdmission({
      claims: dummyClaims,
      admission: { session, staff: SYNTHETIC_STAFF_PHARMACY_A },
      sessionHash: session.sessionHash,
      surface: 'pharmacy',
    });
    assert.equal(failure, null);
  });

  it('approves an active admin session for a surface-neutral auth endpoint', () => {
    const session = createSyntheticSession('test-admin-cookie', SYNTHETIC_STAFF_ADMIN);
    const failure = validatePortalAdmission({
      claims: {
        ...dummyClaims,
        uid: SYNTHETIC_STAFF_ADMIN.uid,
        email: SYNTHETIC_STAFF_ADMIN.email,
        role: 'hhh_admin',
        organisationId: undefined,
      },
      admission: { session, staff: SYNTHETIC_STAFF_ADMIN },
      sessionHash: session.sessionHash,
      surface: 'any',
    });
    assert.equal(failure, null);
  });

  it('locks out staff of a suspended or held pharmacy, each with its own code', () => {
    const session = createSyntheticSession('test-cookie-closed', SYNTHETIC_STAFF_PHARMACY_A);
    for (const [status, code] of [['PAUSED', 'PHARMACY_SUSPENDED'], ['ON_HOLD', 'PHARMACY_ON_HOLD']] as const) {
      const failure = validatePortalAdmission({
        claims: dummyClaims,
        admission: { session, staff: { ...SYNTHETIC_STAFF_PHARMACY_A, organisation: { status } } },
        sessionHash: session.sessionHash,
        surface: 'pharmacy',
      });
      assert.equal(failure?.status, 403);
      assert.equal(failure?.code, code);
    }
  });

  it('shows a held branch its hold, not a sign-in error, after its sessions were revoked', () => {
    const session = { ...createSyntheticSession('test-cookie-held', SYNTHETIC_STAFF_PHARMACY_A), revokedAt: new Date().toISOString(), revokeReason: 'onboarding_on_hold' };
    const failure = validatePortalAdmission({
      claims: dummyClaims,
      admission: { session, staff: { ...SYNTHETIC_STAFF_PHARMACY_A, organisation: { status: 'ON_HOLD' } } },
      sessionHash: session.sessionHash,
      surface: 'pharmacy',
    });
    assert.equal(failure?.code, 'PHARMACY_ON_HOLD');
  });

  it('rejects when session record is missing in SQL (SEC-01)', () => {
    const failure = validatePortalAdmission({
      claims: dummyClaims,
      admission: { session: null, staff: SYNTHETIC_STAFF_PHARMACY_A },
      sessionHash: 'missing-hash',
      surface: 'pharmacy',
    });
    assert.equal(failure?.status, 401);
    assert.equal(failure?.code, 'SESSION_NOT_FOUND');
  });

  it('rejects when staff record is disabled in SQL (SEC-04)', () => {
    const session = createSyntheticSession('test-cookie-2', SYNTHETIC_STAFF_DISABLED);
    const failure = validatePortalAdmission({
      claims: { ...dummyClaims, uid: SYNTHETIC_STAFF_DISABLED.uid },
      admission: { session, staff: SYNTHETIC_STAFF_DISABLED },
      sessionHash: session.sessionHash,
      surface: 'pharmacy',
    });
    assert.equal(failure?.status, 403);
    assert.equal(failure?.code, 'ACCOUNT_DISABLED');
  });

  it('rejects when session has been revoked (SEC-04)', () => {
    const session = createSyntheticSession('test-cookie-3', SYNTHETIC_STAFF_PHARMACY_A, {
      revokedAt: new Date().toISOString(),
      revokeReason: 'logout',
    });
    const failure = validatePortalAdmission({
      claims: dummyClaims,
      admission: { session, staff: SYNTHETIC_STAFF_PHARMACY_A },
      sessionHash: session.sessionHash,
      surface: 'pharmacy',
    });
    assert.equal(failure?.status, 401);
    assert.equal(failure?.code, 'SESSION_REVOKED');
  });

  it('rejects when idle timeout has expired (SEC-01)', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const session = createSyntheticSession('test-cookie-4', SYNTHETIC_STAFF_PHARMACY_A, {
      idleExpiresAt: past,
    });
    const failure = validatePortalAdmission({
      claims: dummyClaims,
      admission: { session, staff: SYNTHETIC_STAFF_PHARMACY_A },
      sessionHash: session.sessionHash,
      surface: 'pharmacy',
    });
    assert.equal(failure?.status, 401);
    assert.equal(failure?.code, 'SESSION_IDLE_EXPIRED');
  });

  it('rejects surface mismatch when pharmacy staff attempts admin portal access (SEC-05)', () => {
    const session = createSyntheticSession('test-cookie-5', SYNTHETIC_STAFF_PHARMACY_A);
    const failure = validatePortalAdmission({
      claims: dummyClaims,
      admission: { session, staff: SYNTHETIC_STAFF_PHARMACY_A },
      sessionHash: session.sessionHash,
      surface: 'admin',
    });
    assert.equal(failure?.status, 403);
    assert.equal(failure?.code, 'SURFACE_DENIED');
  });

  it('rejects tenant mismatch when claims differ from database staff scope (SEC-08)', () => {
    const session = createSyntheticSession('test-cookie-6', SYNTHETIC_STAFF_PHARMACY_A);
    const hijackedClaims = {
      ...dummyClaims,
      organisationId: 'different-tenant-id',
    };
    const failure = validatePortalAdmission({
      claims: hijackedClaims,
      admission: { session, staff: SYNTHETIC_STAFF_PHARMACY_A },
      sessionHash: session.sessionHash,
      surface: 'pharmacy',
    });
    assert.equal(failure?.status, 403);
    assert.equal(failure?.code, 'STAFF_SCOPE_INVALID');
  });

  it('accepts equivalent hyphenated and compact UUID tenant claims', () => {
    const hyphenatedId = '70913a30-71c3-4a41-952e-d532927af58c';
    const compactId = hyphenatedId.replaceAll('-', '');
    const baseSession = createSyntheticSession('test-cookie-7', SYNTHETIC_STAFF_PHARMACY_A);
    const failure = validatePortalAdmission({
      claims: { ...dummyClaims, organisationId: hyphenatedId },
      admission: {
        staff: { ...SYNTHETIC_STAFF_PHARMACY_A, organisationId: compactId },
        session: { ...baseSession, organisationId: compactId },
      },
      sessionHash: baseSession.sessionHash,
      surface: 'pharmacy',
    });
    assert.equal(failure, null);
  });
});
