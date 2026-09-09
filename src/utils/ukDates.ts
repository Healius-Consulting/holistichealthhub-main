/**
 * Every date the portals show is written the way UK staff and patients read
 * one: dd/mm/yyyy, in London time. A date-only value (a date of birth, an
 * issue date) is formatted as written, never shifted by a time zone.
 */
const LONDON = 'Europe/London';
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parse(value: Date | string | number | null | undefined): Date | null {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatUkDate(value: Date | string | number | null | undefined, fallback = '—'): string {
  if (typeof value === 'string') {
    const dateOnly = DATE_ONLY.exec(value.trim());
    if (dateOnly) return `${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]}`;
  }
  const date = parse(value);
  return date ? date.toLocaleDateString('en-GB', { timeZone: LONDON }) : fallback;
}

export function formatUkDateTime(value: Date | string | number | null | undefined, fallback = '—'): string {
  const date = parse(value);
  if (!date) return fallback;
  return `${formatUkDate(date)}, ${date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: LONDON })}`;
}

/** A delivery day keeps its weekday for planning: "Tue 09/09/2026". */
export function formatUkDayDate(dateKey: string): string {
  const date = parse(`${dateKey}T12:00:00Z`);
  if (!date) return '—';
  const weekday = date.toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
  return `${weekday} ${formatUkDate(dateKey)}`;
}
