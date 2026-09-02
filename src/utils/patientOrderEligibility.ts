type OrderPatientStatus = 'Referred' | 'HHH approved' | 'Suspended';

export function canCreateOrderForPatient<T extends { status: OrderPatientStatus }>(
  patient: T | null | undefined,
): patient is T & { status: 'Referred' | 'HHH approved' } {
  return patient?.status === 'Referred' || patient?.status === 'HHH approved';
}

/** Pre-live workspaces may only attach local training drafts, not real referred patients. */
export function canLinkPatientOnOrderDraft<T extends {
  status: OrderPatientStatus;
  referralSource?: string | null;
  id: string;
}>(patient: T | null | undefined, liveWorkspace: boolean): boolean {
  if (!canCreateOrderForPatient(patient)) return false;
  if (liveWorkspace) return true;
  return patient.referralSource === 'training_sandbox' || patient.id.startsWith('training-');
}
