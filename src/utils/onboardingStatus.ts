const ONBOARDING_STATUS_LABELS: Record<string, string> = {
  New: 'New Enquiry',
  'Under HHH review': 'Under Review',
  Approved: 'Referred',
  Declined: 'Declined',
  Rejected: 'Rejected',
  'HHH approved': 'Active',
  Referred: 'Referred',
  Suspended: 'Suspended',
  Withdrawn: 'Withdrawn',
};

export function onboardingStatusLabel(status: string) {
  return ONBOARDING_STATUS_LABELS[status] ?? status;
}

export function onboardingStatusPillClass(status: string) {
  if (status === 'Approved' || status === 'HHH approved') return 'pill-green';
  if (status === 'Declined' || status === 'Rejected' || status === 'Suspended') return 'pill-red';
  if (status === 'Under HHH review') return 'pill-amber';
  if (status === 'Withdrawn') return 'pill-neutral';
  return 'pill-info';
}
