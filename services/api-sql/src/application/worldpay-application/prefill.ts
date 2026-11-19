import type { PharmacyOnboardingRequestRecord } from '../../domain/pharmacy-onboarding/request.js';
import type { PartnerTermsAcceptanceRecord } from '../../domain/pharmacy-onboarding/terms.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import type { WorldpayPrefill } from './applications.js';

const ROLE_LABEL: Record<string, string> = {
  SUPERINTENDENT_PHARMACIST: 'Superintendent pharmacist',
  PHARMACIST: 'Pharmacist',
  DIRECTOR: 'Director',
  PHARMACY_MANAGER: 'Pharmacy manager',
  OTHER: '',
};

/**
 * What the platform already knows about the pharmacy, for a new application: the
 * branch (or the onboarding request before the branch exists) and the Partner Terms
 * signer as Worldpay's contact (spec B-16 to B-19).
 */
export function worldpayPrefill(input: {
  organisation?: OrganisationRecord | null;
  request?: PharmacyOnboardingRequestRecord | null;
  terms?: PartnerTermsAcceptanceRecord | null;
}): WorldpayPrefill {
  const { organisation, request, terms } = input;
  return {
    legalName: request?.registeredCompanyName || organisation?.tradingName || null,
    tradingName: organisation?.name || request?.pharmacyName || null,
    gphcNumber: organisation?.gphcNumber || request?.gphcNumber || null,
    tradingAddress: organisation?.address || request?.deliveryAddress || null,
    landline: organisation?.pharmacyPhone || request?.pharmacyPhone || null,
    businessEmail: organisation?.pharmacyEmail || request?.pharmacyEmail || null,
    contactName: terms?.signerName || organisation?.mainContactName || request?.pharmacistName || null,
    contactPosition: terms ? (terms.signerRole === 'OTHER' ? terms.signerRoleOther ?? '' : ROLE_LABEL[terms.signerRole] ?? '') : null,
    contactPhone: organisation?.mainContactPhone || request?.pharmacyPhone || null,
    contactEmail: terms?.signerEmail || organisation?.mainContactEmail || null,
  };
}
