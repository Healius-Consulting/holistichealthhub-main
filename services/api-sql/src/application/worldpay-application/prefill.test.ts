import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';
import type { PartnerTermsAcceptanceRecord } from '../../domain/pharmacy-onboarding/terms.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import { worldpayPrefill } from './prefill.js';

const request = {
  registeredCompanyName: 'Carlton Holdings Ltd', pharmacyName: 'Carlton Pharmacy', gphcNumber: '1234567',
  deliveryAddress: '1 High Street, Leeds, LS1 1AA', pharmacyPhone: '0113 000 0000', pharmacyEmail: 'shop@carlton.example', pharmacistName: 'Asha Patel',
} as PharmacyOnboardingRequestRecord;
const terms = { signerName: 'Asha Patel', signerRole: 'SUPERINTENDENT_PHARMACIST', signerEmail: 'asha@carlton.example' } as PartnerTermsAcceptanceRecord;

describe('Worldpay application prefill', () => {
  it('starts from the onboarding request, with the Partner Terms signer as Worldpay’s contact', () => {
    const prefill = worldpayPrefill({ request, terms });
    assert.equal(prefill.legalName, 'Carlton Holdings Ltd');
    assert.equal(prefill.tradingName, 'Carlton Pharmacy');
    assert.equal(prefill.tradingAddress, '1 High Street, Leeds, LS1 1AA');
    assert.equal(prefill.contactName, 'Asha Patel');
    assert.equal(prefill.contactPosition, 'Superintendent pharmacist');
    assert.equal(prefill.contactEmail, 'asha@carlton.example');
  });

  it('prefers the branch record once the branch exists', () => {
    const organisation = { name: 'Carlton Pharmacy (Leeds)', tradingName: 'Carlton Health Ltd', gphcNumber: '7654321', address: '2 Market Street, Leeds', pharmacyPhone: '', pharmacyEmail: 'leeds@carlton.example', mainContactName: 'Sam Lee', mainContactPhone: '07700 900123', mainContactEmail: 'sam@carlton.example' } as OrganisationRecord;
    const prefill = worldpayPrefill({ organisation, request, terms: null });
    assert.equal(prefill.legalName, 'Carlton Holdings Ltd', 'the registered company on the request beats the branch trading name');
    assert.equal(prefill.tradingName, 'Carlton Pharmacy (Leeds)');
    assert.equal(prefill.gphcNumber, '7654321');
    assert.equal(prefill.landline, '0113 000 0000');
    assert.equal(prefill.contactName, 'Sam Lee');
    assert.equal(prefill.contactPosition, null);
    assert.equal(worldpayPrefill({ organisation }).legalName, 'Carlton Health Ltd');
  });
});
