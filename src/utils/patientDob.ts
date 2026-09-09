import { formatUkDate } from './ukDates';

export function formatPatientDob(value?: string | null): string {
  if (!value) return 'Not recorded';
  return formatUkDate(value, value);
}
