/** Performance windows on the admin pharmacy record. */
export type PerformancePeriod = '1m' | '3m' | 'all';

/** The first day a period covers, as a London calendar date (YYYY-MM-DD); null for All. */
export function performancePeriodStart(period: PerformancePeriod, now = new Date()): string | null {
  if (period === 'all') return null;
  const start = new Date(now);
  start.setMonth(start.getMonth() - (period === '1m' ? 1 : 3));
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(start);
}
