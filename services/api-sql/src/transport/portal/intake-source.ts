export type PortalSourceType = 'general_hhh_website' | 'future_pharmacy_qr' | 'legacy_pharmacy_qr';

export function portalSourceType(sourceType: string | null | undefined): PortalSourceType | null {
  if (sourceType === 'GENERAL_HHH_WEBSITE') return 'general_hhh_website';
  if (sourceType === 'PHARMACY_QR') return 'future_pharmacy_qr';
  if (sourceType === 'LEGACY_PHARMACY_QR') return 'legacy_pharmacy_qr';
  return null;
}

export function portalSourceLabel(sourceType: PortalSourceType | string | null | undefined) {
  switch (sourceType) {
    case 'future_pharmacy_qr':
    case 'PHARMACY_QR':
      return 'Pharmacy QR link';
    case 'legacy_pharmacy_qr':
    case 'LEGACY_PHARMACY_QR':
      return 'Legacy pharmacy QR';
    case 'general_hhh_website':
    case 'GENERAL_HHH_WEBSITE':
      return 'HHH website';
    default:
      return null;
  }
}

/** New until HHH records any review status, then In progress until referred, declined or withdrawn. */
export function pendingEnquiryDisplayStatus(followUpStatus: string | null | undefined) {
  return !followUpStatus || followUpStatus === 'NOT_STARTED' ? 'New enquiry' as const : 'In progress' as const;
}
