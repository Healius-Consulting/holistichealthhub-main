import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { caseReference, fixedPharmacyIntakeSchema, intakeSchema, referralTokenSchema } from './intake-v2.router.js';

const token = '0a93ebde7ab143cfafd7c2a34329b3587148fb1ff9fb4e6fbf02f517fac05d30';

function validInput() {
  return {
    type: 'future_pharmacy_qr' as const,
    referralToken: token,
    firstName: 'Test',
    surname: 'Applicant',
    dob: '1990-01-01',
    mobile: '07000000000',
    email: 'test@example.test',
    postcode: 'SW1A 1AA',
    conditions: ['chronic-pain'],
    primaryCondition: 'chronic-pain',
    tried2: true,
    psychExclusion: false,
    consentReferral: true as const,
    consentShare: true as const,
    marketing: false,
    heardAbout: 'Pharmacy',
    consentVersion: 'pharmacy-qr-v2.1' as const,
    idempotencyKey: '11111111-1111-4111-8111-111111111111',
  };
}

describe('public SQL intake v2 validation', () => {
  it('accepts issued opaque tokens and rejects URL punctuation', () => {
    assert.equal(referralTokenSchema.safeParse(token).success, true);
    assert.equal(referralTokenSchema.safeParse(`${token}.`).success, false);
  });

  it('accepts a consented fixed-pharmacy intake', () => {
    assert.equal(fixedPharmacyIntakeSchema.safeParse(validInput()).success, true);
  });

  it('rejects duplicate conditions and a mismatched primary condition', () => {
    assert.equal(fixedPharmacyIntakeSchema.safeParse({
      ...validInput(),
      conditions: ['chronic-pain', 'chronic-pain'],
    }).success, false);
    assert.equal(fixedPharmacyIntakeSchema.safeParse({
      ...validInput(),
      primaryCondition: 'anxiety',
    }).success, false);
  });

  it('accepts a general website intake with conditions on the form', () => {
    const parsed = intakeSchema.safeParse({
      type: 'general_hhh_website',
      searchId: '11111111-1111-4111-8111-111111111111',
      selectedDirectoryProfileId: '70913a30-71c3-4a41-952e-d532927af58c',
      firstName: 'Test',
      surname: 'Applicant',
      dob: '1990-01-01',
      mobile: '07000000000',
      email: 'test@example.test',
      postcode: 'SW1A 1AA',
      conditions: ['endometriosis', 'chronic-pain'],
      primaryCondition: 'endometriosis',
      tried2: true,
      psychExclusion: false,
      consentReferral: true,
      consentShare: true,
      marketing: false,
      heardAbout: 'Website',
      consentVersion: 'general-public-v2.1',
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    });
    assert.equal(parsed.success, true);
  });

  it('accepts a screening answer that fails the criteria, so the decline can be recorded', () => {
    // The clinic's criteria are applied after the record is written, not by refusing it:
    // a patient cannot be told why they were declined, or ask a pharmacist to reconsider,
    // against an application that was never stored.
    assert.equal(fixedPharmacyIntakeSchema.safeParse({ ...validInput(), tried2: false }).success, true);
    assert.equal(fixedPharmacyIntakeSchema.safeParse({ ...validInput(), psychExclusion: true }).success, true);
  });

  it('still refuses an application from someone under 18', () => {
    const under18 = new Date();
    under18.setUTCFullYear(under18.getUTCFullYear() - 17);
    assert.equal(
      fixedPharmacyIntakeSchema.safeParse({ ...validInput(), dob: under18.toISOString().slice(0, 10) }).success,
      false,
    );
  });

  it('requires an answer to where the patient heard about the service', () => {
    assert.equal(fixedPharmacyIntakeSchema.safeParse({ ...validInput(), heardAbout: '' }).success, false);
    const { heardAbout: _omitted, ...withoutHeardAbout } = validInput();
    assert.equal(fixedPharmacyIntakeSchema.safeParse(withoutHeardAbout).success, false);
  });

  it('creates a stable, non-PII case reference', () => {
    assert.equal(
      caseReference('12345678-1234-4123-8123-123456789012', '2026-08-17T00:00:00.000Z'),
      'HHH-20260817-12345678',
    );
  });
});
