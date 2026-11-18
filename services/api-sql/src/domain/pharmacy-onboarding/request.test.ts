import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pharmacyOnboardingFieldsSchema } from './request.js';

const submission = {
  pharmacistName: 'Amina Khan',
  pharmacyName: 'Eastwood Health',
  registeredCompanyName: 'Eastwood Health Ltd',
  invoiceAddress: '1 High Street, Leeds, LS1 1AA',
  deliveryAddress: '2 High Street, Leeds, LS1 1AB',
  gphcNumber: '2078912',
  pharmacyEmail: 'pharmacy@eastwood.test',
  accountsEmail: 'accounts@eastwood.test',
  pharmacyPhone: '0113 000 0000',
  accountsPhone: '0113 000 0001',
  faxNumber: '',
  signatureName: 'Amina Khan',
  idempotencyKey: 'idempotency-key-1',
};

describe('pharmacyOnboardingFieldsSchema', () => {
  it('accepts a submission without the retired licence fields', () => {
    assert.equal(pharmacyOnboardingFieldsSchema.parse(submission).gphcNumber, '2078912');
  });

  it('drops licence numbers an older onboarding page still sends, rather than refusing it', () => {
    const parsed = pharmacyOnboardingFieldsSchema.parse({ ...submission, wdaNumber: 'WDA-44', licenceDetails: 'CD licence 2026' });
    assert.equal('wdaNumber' in parsed, false);
    assert.equal('licenceDetails' in parsed, false);
  });
});
