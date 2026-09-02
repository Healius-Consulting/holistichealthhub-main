import type { CRMPatient, PharmacyTenant } from '../context/AppContext';
import { isTrainingDirectoryPharmacy } from '../shared/contracts';
import { hydrateSandboxWorkspace } from './sandboxPack';

export { TRAINING_PRESCRIBER, TRAINING_PRODUCT, TRAINING_REFERRAL_SOURCE } from './sandboxPack';
export { hydrateSandboxWorkspace, sandboxOverviewForOrganisation, sandboxOverviewSnapshot } from './sandboxPack';

export const ORGANISATIONS: PharmacyTenant[] = [
  {
    id: '3e9f74ff-4fed-497d-904d-4d3ee3e5e126',
    slug: 'primary-branch',
    referralToken: 'primary-branch-7x4p9k',
    name: 'Primary Branch',
    tradingName: 'Primary Branch',
    logoText: 'PB',
    gphcNumber: '1099224',
    superintendent: 'Shaylen Patel',
    companyNumber: '1099224',
    mainContactName: 'Shaylen Patel',
    mainContactPhone: '0113 000 0000',
    mainContactEmail: 'pharmacy@primarybranch.co.uk',
    curaleafPharmacyCode: '109c6bca-585a-4b69-b6bb-072e0731dd10',
    address: 'Leeds, West Yorkshire, United Kingdom',
    websiteDomains: ['primarybranch.co.uk'],
    status: 'onboarding',
    staffCount: 4,
    defaultPaymentRoute: 'manual',
    pharmacyDeliveryEnabled: false,
    brand: { primary: '#0f766e', portalName: 'Primary Branch' },
    worldpay: { enabled: false, status: 'not-connected', environment: 'sandbox', merchantId: null, merchantName: null, lastSyncedAt: null },
  },
  {
    id: '6d0176bb-89a0-4e32-9bce-c934c9557c42',
    slug: 'eastwood-health-pharmacy',
    referralToken: 'eastwood-3m8q2v',
    name: 'Eastwood Health Pharmacy',
    tradingName: 'Eastwood Health Ltd',
    logoText: 'EH',
    gphcNumber: '9012726',
    superintendent: 'Shaylen Patel',
    companyNumber: '9012726',
    mainContactName: 'Shaylen Patel',
    mainContactPhone: '01522 000 000',
    mainContactEmail: 'contact@eastwoodhealthpharmacy.co.uk',
    curaleafPharmacyCode: '04568c82-b3d2-4082-9277-3313b48d10f4',
    address: 'Nottinghamshire, United Kingdom',
    websiteDomains: ['eastwoodhealthpharmacy.co.uk'],
    status: 'live',
    staffCount: 2,
    defaultPaymentRoute: 'manual',
    pharmacyDeliveryEnabled: false,
    brand: { primary: '#1e40af', portalName: 'Eastwood Health Pharmacy' },
    worldpay: { enabled: false, status: 'not-connected', environment: 'sandbox', merchantId: null, merchantName: null, lastSyncedAt: null },
  },
];

export function isTrainingSandboxPatient(patient: Pick<CRMPatient, 'referralSource' | 'id'>): boolean {
  return patient.referralSource === 'training_sandbox' || patient.id.startsWith('training-');
}

/** Pharmacy staff only have two workspaces: Live (real referred patients) or Training (examples). */
export function resolvePharmacyWorkspaceMode(organisation: Pick<PharmacyTenant, 'status' | 'workspaceClassification' | 'testAccount'> | null | undefined): 'live' | 'training' {
  if (!organisation) return 'training';
  if (organisation.workspaceClassification === 'allocation_holding') return 'live';
  if (organisation.workspaceClassification === 'training' || organisation.testAccount) return 'training';
  if (organisation.status === 'live' || organisation.status === 'paused') return 'live';
  return 'training';
}

export function usesSandboxDummyPack(organisation: Pick<PharmacyTenant, 'id' | 'name' | 'tradingName' | 'testAccount' | 'workspaceClassification'> | null | undefined, localPreview: boolean) {
  if (organisation) return isTrainingDirectoryPharmacy(organisation);
  return localPreview;
}

export function trainingWorkspace(organisationId: string) {
  return hydrateSandboxWorkspace(organisationId);
}
