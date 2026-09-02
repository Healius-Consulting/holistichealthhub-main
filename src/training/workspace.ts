import type { CRMPatient, PharmacyTenant } from '../context/AppContext';
import { hydrateSandboxWorkspace } from './sandboxPack';

export { TRAINING_PRESCRIBER, TRAINING_PRODUCT, TRAINING_REFERRAL_SOURCE } from './sandboxPack';
export { hydrateSandboxWorkspace, sandboxOverviewForOrganisation, sandboxOverviewSnapshot } from './sandboxPack';
export {
  isOpenPharmacyWorkspace,
  pharmacyWorkspaceStatusLabel,
  resolvePharmacyWorkspaceMode,
  usesSandboxDummyPack,
  type PharmacyWorkspaceMode,
} from './workspaceMode';

export const ORGANISATIONS: PharmacyTenant[] = [
  {
    id: '70913a30-71c3-4a41-952e-d532927af58c',
    slug: 'primary-branch',
    referralToken: 'primary-branch-7x4p9k',
    name: 'Primary Branch',
    tradingName: 'Primary Branch',
    logoText: 'PB',
    gphcNumber: 'TRAINING-PRIMARY',
    superintendent: 'Training superintendent',
    companyNumber: 'TRAINING-PRIMARY',
    mainContactName: 'Training owner',
    mainContactPhone: '0113 000 0000',
    mainContactEmail: 'pharmacy@primarybranch.test',
    curaleafPharmacyCode: '00000000-0000-4000-8000-000000000001',
    address: 'Leeds, West Yorkshire, United Kingdom',
    websiteDomains: ['primarybranch.test'],
    status: 'onboarding',
    staffCount: 4,
    defaultPaymentRoute: 'manual',
    pharmacyDeliveryEnabled: false,
    brand: { primary: '#0f766e', portalName: 'Primary Branch' },
    worldpay: { enabled: false, status: 'not-connected', environment: 'sandbox', merchantId: null, merchantName: null, lastSyncedAt: null },
  },
  {
    id: 'f486a221-2236-44a5-b072-f06de399ab0e',
    slug: 'alternate-pharmacy',
    referralToken: 'alternate-pharmacy-3m8q2v',
    name: 'Alternate Pharmacy',
    tradingName: 'Alternate Pharmacy',
    logoText: 'AP',
    gphcNumber: 'TRAINING-ALTERNATE',
    superintendent: 'Training superintendent',
    companyNumber: 'TRAINING-ALTERNATE',
    mainContactName: 'Training owner',
    mainContactPhone: '0113 000 0001',
    mainContactEmail: 'pharmacy@alternatepharmacy.test',
    curaleafPharmacyCode: '00000000-0000-4000-8000-000000000002',
    address: 'Manchester, United Kingdom',
    websiteDomains: ['alternatepharmacy.test'],
    status: 'onboarding',
    staffCount: 2,
    defaultPaymentRoute: 'manual',
    pharmacyDeliveryEnabled: false,
    brand: { primary: '#334155', portalName: 'Alternate Pharmacy' },
    worldpay: { enabled: false, status: 'not-connected', environment: 'sandbox', merchantId: null, merchantName: null, lastSyncedAt: null },
  },
];

export function isTrainingSandboxPatient(patient: Pick<CRMPatient, 'referralSource' | 'id'>): boolean {
  return patient.referralSource === 'training_sandbox' || patient.id.startsWith('training-');
}

export function trainingWorkspace(organisationId: string) {
  return hydrateSandboxWorkspace(organisationId);
}
