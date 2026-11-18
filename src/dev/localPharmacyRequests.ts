import type { PharmacyTenant } from '../context/AppContext';
import type { PharmacyOnboardingRequestView } from '../shared/api';

/** Sample requests for `?devPortal=admin` on localhost only. Never shipped data. */
const base = {
  faxNumber: null,
  licenceFilename: '',
  organisationId: null,
  declineReason: null,
  decidedAt: null,
} satisfies Partial<PharmacyOnboardingRequestView>;

export const LOCAL_PREVIEW_PHARMACY_REQUESTS: PharmacyOnboardingRequestView[] = [
  {
    ...base,
    id: 'preview-request-1',
    status: 'activated',
    organisationId: 'preview-new-pharmacy-1',
    pharmacistName: 'Asha Shah',
    pharmacyName: 'Kirkgate Pharmacy',
    registeredCompanyName: 'Kirkgate Health Ltd',
    invoiceAddress: '12 Kirkgate, Leeds, LS1 6BY',
    deliveryAddress: '12 Kirkgate, Leeds, LS1 6BY',
    gphcNumber: '1123456',
    pharmacyEmail: 'shop@kirkgate.example',
    accountsEmail: 'accounts@kirkgate.example',
    pharmacyPhone: '0113 496 0001',
    accountsPhone: '0113 496 0002',
    signatureName: 'Asha Shah',
    signedOn: '2026-11-15',
    createdAt: '2026-11-15T09:12:00Z',
    worldpaySubmittedAt: '2026-11-15T09:40:00Z',
  },
  {
    ...base,
    id: 'preview-request-2',
    status: 'activated',
    organisationId: 'preview-new-pharmacy-2',
    pharmacistName: 'Tom Hughes',
    pharmacyName: 'Harbour Lane Chemist',
    registeredCompanyName: 'Harbour Lane Pharmacy LLP',
    invoiceAddress: '4 Harbour Lane, Whitby, YO21 3PU',
    deliveryAddress: '4 Harbour Lane, Whitby, YO21 3PU',
    gphcNumber: '1198765',
    pharmacyEmail: 'hello@harbourlane.example',
    accountsEmail: 'finance@harbourlane.example',
    pharmacyPhone: '01947 600 100',
    accountsPhone: '01947 600 101',
    signatureName: 'Tom Hughes',
    signedOn: '2026-11-16',
    createdAt: '2026-11-16T08:05:00Z',
    worldpaySubmittedAt: null,
  },
  {
    ...base,
    id: 'preview-request-3',
    status: 'on_hold',
    pharmacistName: 'Priya Nair',
    pharmacyName: 'Northgate Pharmacy',
    registeredCompanyName: 'Northgate Retail Ltd',
    invoiceAddress: '88 Northgate, Wakefield, WF1 3AP',
    deliveryAddress: '88 Northgate, Wakefield, WF1 3AP',
    gphcNumber: '1100222',
    pharmacyEmail: 'northgate@example.com',
    accountsEmail: 'northgate@example.com',
    pharmacyPhone: '01924 000 111',
    accountsPhone: '01924 000 111',
    signatureName: 'Priya Nair',
    signedOn: '2026-11-10',
    createdAt: '2026-11-10T14:30:00Z',
    decidedAt: '2026-11-11T10:00:00Z',
    declineReason: 'This GPhC number belongs to a pharmacy that is already part of a group on the platform.',
    worldpaySubmittedAt: null,
  },
  {
    ...base,
    id: 'preview-request-4',
    status: 'pending',
    pharmacistName: 'Ravi Patel',
    pharmacyName: 'Parkside Pharmacy',
    registeredCompanyName: 'Parkside Healthcare Ltd',
    invoiceAddress: '5 Park Row, Bradford, BD1 2AB',
    deliveryAddress: '5 Park Row, Bradford, BD1 2AB',
    gphcNumber: '1133557',
    pharmacyEmail: 'team@parkside.example',
    accountsEmail: 'accounts@parkside.example',
    pharmacyPhone: '01274 000 222',
    accountsPhone: '01274 000 223',
    signatureName: 'Ravi Patel',
    signedOn: '2026-11-18',
    createdAt: '2026-11-18T11:20:00Z',
    worldpaySubmittedAt: null,
  },
];

function newPharmacy(id: string, request: PharmacyOnboardingRequestView, logoText: string, primary: string): PharmacyTenant {
  return {
    id,
    slug: id,
    referralToken: `${id}-preview-token`,
    name: request.pharmacyName,
    tradingName: request.registeredCompanyName,
    logoText,
    gphcNumber: request.gphcNumber,
    superintendent: request.pharmacistName,
    mainContactName: request.pharmacistName,
    mainContactPhone: request.pharmacyPhone,
    mainContactEmail: request.pharmacyEmail,
    pharmacyPhone: request.pharmacyPhone,
    pharmacyEmail: request.pharmacyEmail,
    address: request.deliveryAddress,
    websiteDomains: [],
    status: 'onboarding',
    intakeEnabled: false,
    staffCount: 0,
    defaultPaymentRoute: 'manual',
    worldpayState: 'unconnected',
    pharmacyDeliveryEnabled: false,
    brand: { primary, portalName: request.pharmacyName },
    worldpay: { enabled: false, status: 'not-connected', environment: 'sandbox', merchantId: null, merchantName: null, lastSyncedAt: null },
  };
}

function withState(base: PharmacyTenant, state: Partial<PharmacyTenant>): PharmacyTenant {
  return { ...base, ...state };
}

/**
 * One preview pharmacy per state the overview shows: waiting with no Curaleaf
 * credentials, waiting on test credentials, and live. Held requests
 * appear through the on-hold request above; test pharmacies come from the demo data.
 */
export const LOCAL_PREVIEW_NEW_PHARMACIES: PharmacyTenant[] = [
  newPharmacy('preview-new-pharmacy-1', LOCAL_PREVIEW_PHARMACY_REQUESTS[0]!, 'KP', '#0f766e'),
  withState(newPharmacy('preview-new-pharmacy-2', LOCAL_PREVIEW_PHARMACY_REQUESTS[1]!, 'HL', '#1d4ed8'), {
    curaleafPharmacyCode: 'PHAR-TEST-2210',
    curaleafEnvironment: 'test',
  }),
  withState(newPharmacy('preview-live-pharmacy', {
    ...LOCAL_PREVIEW_PHARMACY_REQUESTS[0]!,
    pharmacyName: 'Meadowbank Pharmacy',
    registeredCompanyName: 'Meadowbank Healthcare Ltd',
    gphcNumber: '1077341',
    pharmacistName: 'Daniel Okafor',
    pharmacyEmail: 'team@meadowbank.example',
    pharmacyPhone: '0161 496 0123',
    deliveryAddress: '27 Meadowbank Road, Manchester, M14 5LS',
  }, 'MB', '#7c3aed'), {
    status: 'live',
    intakeEnabled: true,
    curaleafPharmacyCode: 'PHAR10442',
    curaleafEnvironment: 'production',
    worldpayState: 'live',
    staffCount: 4,
  }),
];
