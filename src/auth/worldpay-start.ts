import type { CompanyLookup } from '../shared/api';
import type { WorldpayPrincipalStart, WorldpayStart } from './WorldpayForm';
import type { PharmsmartWelcome } from './types';
import { monthYear } from './company-prefill.ts';

/** What the Curaleaf form told us, when it was filled in during this visit. */
export type CuraleafStartValues = {
  registeredCompanyName?: string;
  pharmacyName?: string;
  pharmacistName?: string;
  gphcNumber?: string;
  invoiceAddress?: string;
  deliveryAddress?: string;
  pharmacyPhone?: string;
  pharmacyEmail?: string;
};

/**
 * The Worldpay form's start values on the PharmSmart onboarding page. PharmSmart's
 * pharmacy manager is Worldpay's day-to-day contact. Without one, the contact is the
 * name on the Curaleaf form, then the pharmacy's main contact, then whoever signed in.
 */
export function worldpayStartFromWelcome(
  welcome: PharmsmartWelcome,
  curaleaf: CuraleafStartValues | null,
  company: CompanyLookup | null = null,
): WorldpayStart {
  const knownName = [welcome.firstName, welcome.lastName].filter(Boolean).join(' ');
  const managerName = [welcome.prefill?.managerFirstName, welcome.prefill?.managerLastName].filter(Boolean).join(' ');
  return {
    legalName: curaleaf?.registeredCompanyName ?? company?.companyName ?? welcome.prefill?.registeredCompanyName,
    tradingName: curaleaf?.pharmacyName ?? welcome.prefill?.pharmacyName,
    contactName: managerName || (curaleaf?.pharmacistName ?? (welcome.prefill?.contactName || knownName)),
    contactPosition: managerName ? 'Pharmacy manager' : undefined,
    contactPhone: welcome.prefill?.managerPhone,
    gphcNumber: curaleaf?.gphcNumber ?? welcome.gphcNumber ?? undefined,
    // Companies House holds the registered office itself; otherwise the invoice address is the best guess.
    registeredAddress: company?.registeredAddress || (curaleaf?.invoiceAddress ?? welcome.prefill?.invoiceAddress),
    businessType: company?.businessType ?? undefined,
    registrationNumber: company?.companyNumber || undefined,
    tradingSince: monthYear(company?.incorporatedOn ?? null),
    tradingAddress: curaleaf?.deliveryAddress ?? welcome.prefill?.deliveryAddress,
    landline: curaleaf?.pharmacyPhone ?? welcome.prefill?.pharmacyPhone,
    businessEmail: curaleaf?.pharmacyEmail ?? welcome.prefill?.pharmacyEmail,
  };
}

/** PharmSmart's superintendent is the likeliest owner or director, so they start as the first principal. */
export function worldpayPrincipalFromWelcome(welcome: PharmsmartWelcome): WorldpayPrincipalStart {
  return {
    firstNames: welcome.prefill?.superintendentFirstName,
    surname: welcome.prefill?.superintendentLastName,
    email: welcome.prefill?.superintendentEmail,
    mobile: welcome.prefill?.superintendentPhone,
  };
}

const sameName = (a: string | undefined, b: string | undefined) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
const firstName = (names: string | undefined) => (names ?? '').trim().split(/\s+/)[0] ?? '';

/**
 * Worldpay's principals are the company's directors. With a lookup they come from
 * Companies House (up to `max`), and PharmSmart's superintendent lends their email and
 * mobile to the director with the same name. Without one, the superintendent starts alone.
 */
export function worldpayPrincipalsFrom(welcome: PharmsmartWelcome, company: CompanyLookup | null, max = 4): WorldpayPrincipalStart[] {
  const superintendent = worldpayPrincipalFromWelcome(welcome);
  if (!company?.directors.length) return [superintendent];
  return company.directors.slice(0, max).map(director => {
    const isSuperintendent = sameName(director.surname, superintendent.surname)
      && sameName(firstName(director.firstNames), firstName(superintendent.firstNames));
    return {
      firstNames: director.firstNames,
      surname: director.surname,
      nationality: director.nationality || undefined,
      countryOfResidence: director.countryOfResidence || undefined,
      ...(isSuperintendent ? { email: superintendent.email, mobile: superintendent.mobile } : {}),
    };
  });
}

/** The branch fields the portal already holds. `tradingName` is the owning company; `name` the pharmacy. */
export type BranchStartValues = {
  name: string;
  tradingName?: string | null;
  gphcNumber?: string | null;
  mainContactName?: string | null;
  mainContactPhone?: string | null;
  mainContactEmail?: string | null;
  pharmacyPhone?: string | null;
  pharmacyEmail?: string | null;
  address?: string | null;
};

/**
 * The same form's start values from inside the portal, where the branch record is what
 * we know. The registered company comes from the onboarding request when there is one.
 */
export function worldpayStartFromBranch(branch: BranchStartValues, registeredCompanyName?: string | null): WorldpayStart {
  const text = (value: string | null | undefined) => value?.trim() || undefined;
  return {
    legalName: text(registeredCompanyName) ?? text(branch.tradingName),
    tradingName: text(branch.name),
    contactName: text(branch.mainContactName),
    contactPhone: text(branch.mainContactPhone),
    gphcNumber: text(branch.gphcNumber),
    registeredAddress: text(branch.address),
    tradingAddress: text(branch.address),
    landline: text(branch.pharmacyPhone),
    businessEmail: text(branch.pharmacyEmail) ?? text(branch.mainContactEmail),
  };
}
