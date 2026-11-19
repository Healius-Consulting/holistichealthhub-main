import type { PharmacyTenant } from '../context/AppContext';
import type { OnboardingEmailLogEntry, PharmacyOnboardingRequestView } from '../shared/api';

/** Sample requests for `?devPortal=admin` on localhost only. Never shipped data. */
const base = {
  faxNumber: null,
  licenceFilename: '',
  organisationId: null,
  holdReason: null,
  heldAt: null,
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
    holdReason: 'EXISTING_CURALEAF_CUSTOMER',
    heldAt: '2026-11-11T10:00:00Z',
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
  {
    ...base,
    id: 'preview-request-5',
    status: 'on_hold',
    organisationId: 'preview-new-pharmacy-3',
    pharmacistName: 'Grace Lee',
    pharmacyName: 'Riverside Pharmacy',
    registeredCompanyName: 'Riverside Chemists Ltd',
    invoiceAddress: '3 River Street, York, YO1 7AB',
    deliveryAddress: '3 River Street, York, YO1 7AB',
    gphcNumber: '1144668',
    pharmacyEmail: 'riverside@example.com',
    accountsEmail: 'accounts@riverside.example',
    pharmacyPhone: '01904 000 333',
    accountsPhone: '01904 000 334',
    signatureName: 'Grace Lee',
    signedOn: '2026-11-12',
    createdAt: '2026-11-12T10:00:00Z',
    decidedAt: '2026-11-17T15:30:00Z',
    holdReason: 'MORE_INFORMATION_NEEDED',
    heldAt: '2026-11-17T15:30:00Z',
    worldpaySubmittedAt: '2026-11-12T10:30:00Z',
  },
  {
    ...base,
    id: 'preview-request-6',
    status: 'activated',
    organisationId: 'preview-live-pharmacy',
    pharmacistName: 'Daniel Okafor',
    pharmacyName: 'Meadowbank Pharmacy',
    registeredCompanyName: 'Meadowbank Healthcare Ltd',
    invoiceAddress: '27 Meadowbank Road, Manchester, M14 5LS',
    deliveryAddress: '27 Meadowbank Road, Manchester, M14 5LS',
    gphcNumber: '1077341',
    pharmacyEmail: 'team@meadowbank.example',
    accountsEmail: 'team@meadowbank.example',
    pharmacyPhone: '0161 496 0123',
    accountsPhone: '0161 496 0123',
    signatureName: 'Daniel Okafor',
    signedOn: '2026-10-01',
    createdAt: '2026-10-01T09:00:00Z',
    worldpaySubmittedAt: '2026-10-01T09:30:00Z',
  },
];

const sent = (id: string, kind: OnboardingEmailLogEntry['kind'], recipients: string[], at: string): OnboardingEmailLogEntry => ({
  id, kind, recipients, status: 'SENT', queuedAt: at, sentAt: at, failedAt: null, failureCode: null,
});

/** Sample send logs for the preview requests, newest first; one failed send to show Resend. */
export const LOCAL_PREVIEW_ONBOARDING_EMAILS: Record<string, OnboardingEmailLogEntry[]> = {
  'preview-request-1': [
    sent('pe-1c', 'activation', ['asha@kirkgate.example', 'shop@kirkgate.example'], '2026-11-16T10:00:00Z'),
    sent('pe-1b', 'curaleafApplication', ['accounts@curaleaf.example', 'spatel@healiusconsulting.com'], '2026-11-15T09:12:30Z'),
    sent('pe-1a', 'sent', ['asha@kirkgate.example', 'shop@kirkgate.example'], '2026-11-15T09:12:30Z'),
  ],
  'preview-request-2': [
    { ...sent('pe-2b', 'curaleafApplication', ['accounts@curaleaf.example'], '2026-11-16T08:05:30Z'), status: 'FAILED', sentAt: null, failedAt: '2026-11-16T08:06:00Z', failureCode: 'SMTP_TIMEOUT' },
    sent('pe-2a', 'sent', ['hello@harbourlane.example'], '2026-11-16T08:05:30Z'),
  ],
  'preview-request-3': [
    sent('pe-3b', 'hold', ['northgate@example.com'], '2026-11-11T10:00:10Z'),
    sent('pe-3a', 'sent', ['northgate@example.com'], '2026-11-10T14:30:30Z'),
  ],
  'preview-request-6': [
    sent('pe-6d', 'live', ['team@meadowbank.example'], '2026-10-20T12:00:00Z'),
    sent('pe-6c', 'activation', ['team@meadowbank.example'], '2026-10-02T09:00:00Z'),
    sent('pe-6b', 'curaleafApplication', ['accounts@curaleaf.example', 'spatel@healiusconsulting.com'], '2026-10-01T09:00:30Z'),
    sent('pe-6a', 'sent', ['team@meadowbank.example'], '2026-10-01T09:00:30Z'),
  ],
  'preview-request-5': [
    { ...sent('pe-5c', 'hold', ['riverside@example.com'], '2026-11-17T15:30:10Z'), status: 'PENDING', sentAt: null },
    sent('pe-5b', 'activation', ['riverside@example.com'], '2026-11-13T09:00:00Z'),
    sent('pe-5a', 'sent', ['riverside@example.com'], '2026-11-12T10:00:30Z'),
  ],
};

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
 * credentials, waiting on test credentials, on hold after activation, and live.
 * A request held before activation appears through the on-hold request above; test
 * pharmacies come from the demo data.
 */
export const LOCAL_PREVIEW_NEW_PHARMACIES: PharmacyTenant[] = [
  newPharmacy('preview-new-pharmacy-1', LOCAL_PREVIEW_PHARMACY_REQUESTS[0]!, 'KP', '#0f766e'),
  // Activated, then put on hold (preview-request-5): staff see only the hold message.
  newPharmacy('preview-new-pharmacy-3', LOCAL_PREVIEW_PHARMACY_REQUESTS[4]!, 'RP', '#b45309'),
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
