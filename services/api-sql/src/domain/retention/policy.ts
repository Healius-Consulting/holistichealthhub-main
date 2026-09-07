/**
 * The retention periods published in Privacy 6. Kept as one table so the notice and
 * the job that enforces it can be read side by side — a promise to delete that no
 * code carries out is worse than no promise at all.
 */
export const RETENTION = {
  /** Not referred or withdrawn: deleted 3 months after the decision. */
  closedApplicationMonths: 3,
  /** A minimal record (name, date, outcome) survives 12 months to answer queries. */
  minimalRecordMonths: 12,
  /** Referred: deleted 2 years after the last activity with the service. */
  referredApplicationYears: 2,
  /** Upload logs for an NHS record view, which never stores the record itself. */
  uploadLogDays: 90,
} as const;

export type RetentionAction =
  | { action: 'retain' }
  | { action: 'reduce_to_minimal_record'; dueAt: string }
  | { action: 'delete'; dueAt: string };

export type RetentionSubject = {
  outcomeStatus: 'OPEN' | 'COMPLETED' | 'DECLINED' | 'WITHDRAWN';
  /** When the application was decided or withdrawn; null while it is still open. */
  closedAt: string | null;
  /** Last order, message or referral event for a referred patient. */
  lastActivityAt: string | null;
  /** Set once the record has already been reduced to name, date and outcome. */
  minimalSince: string | null;
};

function shift(iso: string, apply: (date: Date) => void): Date {
  const original = new Date(iso);
  const shifted = new Date(original);
  apply(shifted);
  // A 31st that lands in a short month rolls forward; pull it back to the month end
  // so a retention deadline never silently gains a day.
  if (shifted.getUTCDate() !== original.getUTCDate()) shifted.setUTCDate(0);
  return shifted;
}

const addMonths = (iso: string, months: number) =>
  shift(iso, date => date.setUTCMonth(date.getUTCMonth() + months));

const addYears = (iso: string, years: number) =>
  shift(iso, date => date.setUTCFullYear(date.getUTCFullYear() + years));

/**
 * What should happen to one application today. A closed application first loses
 * everything but name, date and outcome, and that stub is deleted 12 months after
 * the same decision date — not 12 months after the reduction, which would quietly
 * extend the total to 15.
 */
export function retentionActionFor(subject: RetentionSubject, now: Date = new Date()): RetentionAction {
  if (subject.outcomeStatus === 'DECLINED' || subject.outcomeStatus === 'WITHDRAWN') {
    if (!subject.closedAt) return { action: 'retain' };
    const purgeAt = addMonths(subject.closedAt, RETENTION.minimalRecordMonths);
    if (now >= purgeAt) return { action: 'delete', dueAt: purgeAt.toISOString() };
    if (subject.minimalSince) return { action: 'retain' };
    const reduceAt = addMonths(subject.closedAt, RETENTION.closedApplicationMonths);
    if (now >= reduceAt) return { action: 'reduce_to_minimal_record', dueAt: reduceAt.toISOString() };
    return { action: 'retain' };
  }

  if (subject.outcomeStatus === 'COMPLETED') {
    const from = subject.lastActivityAt ?? subject.closedAt;
    if (!from) return { action: 'retain' };
    const purgeAt = addYears(from, RETENTION.referredApplicationYears);
    if (now >= purgeAt) return { action: 'delete', dueAt: purgeAt.toISOString() };
    return { action: 'retain' };
  }

  // An open application is still being worked; nothing expires while it is live.
  return { action: 'retain' };
}
