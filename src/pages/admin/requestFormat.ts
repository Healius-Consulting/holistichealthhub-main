import type { PharmacyOnboardingRequestView } from '../../shared/api';

const dateFormatter = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export function formatRequestDate(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : dateFormatter.format(date);
}

/** GPhC numbers are matched with spaces and punctuation removed, as the server stores them. */
export function compactGphc(value: string) {
  return value.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

export function requestTone(status: PharmacyOnboardingRequestView['status']) {
  return status === 'on_hold' ? 'danger' : 'warning';
}

export function requestStatusLabel(status: PharmacyOnboardingRequestView['status']) {
  if (status === 'on_hold') return 'On hold';
  if (status === 'activated') return 'Activated';
  return 'New request';
}
