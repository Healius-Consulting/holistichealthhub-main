/**
 * Collection emails are read by patients who then travel to the pharmacy, so
 * they must not land after hours: an email sent at 20:00 invites a wasted trip
 * to a closed pharmacy, and one sent at 03:00 reads as an error.
 *
 * Weekdays before the cutoff send immediately. Everything else waits for 09:00
 * on the next working day. All reasoning is in Europe/London, which is the
 * pharmacy's wall clock, not the server's.
 */

const LONDON = 'Europe/London';

/** Latest hour a same-day collection email may be sent. */
export const COLLECTION_EMAIL_CUTOFF_HOUR = 15;

/** Hour the next working day's collection emails go out. */
export const COLLECTION_EMAIL_SEND_HOUR = 9;

type LondonParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function londonParts(instant: Date): LondonParts {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // 24-hour formatting renders midnight as "24" in some ICU versions.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAY_INDEX[String(parts.weekday)] ?? 0,
  };
}

/** London's UTC offset in minutes at the given instant, so DST is never assumed. */
function londonOffsetMinutes(instant: Date) {
  const parts = londonParts(instant);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return Math.round((asUtc - Math.floor(instant.getTime() / 60000) * 60000) / 60000);
}

/** The instant matching the given London wall-clock time. */
function londonWallClockToInstant(year: number, month: number, day: number, hour: number): Date {
  const naive = Date.UTC(year, month - 1, day, hour, 0, 0, 0);
  // Resolve with the offset in force around that date, then confirm it still
  // holds — a DST boundary can shift the offset between the two readings.
  const firstGuess = new Date(naive - londonOffsetMinutes(new Date(naive)) * 60000);
  const settled = new Date(naive - londonOffsetMinutes(firstGuess) * 60000);
  return settled;
}

function isWeekend(weekday: number) {
  return weekday === 0 || weekday === 6;
}

/**
 * When a ready-to-collect email for `now` should actually be sent.
 * Returns `now` itself when it may go immediately.
 */
export function collectionEmailSendAt(now: Date): Date {
  const parts = londonParts(now);
  if (!isWeekend(parts.weekday) && parts.hour < COLLECTION_EMAIL_CUTOFF_HOUR) return now;

  // Walk forward to the next working day.
  let cursor = new Date(now.getTime());
  let cursorParts = parts;
  do {
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    cursorParts = londonParts(cursor);
  } while (isWeekend(cursorParts.weekday));

  return londonWallClockToInstant(cursorParts.year, cursorParts.month, cursorParts.day, COLLECTION_EMAIL_SEND_HOUR);
}

/** Null when the email may send immediately, otherwise the scheduled instant. */
export function collectionEmailDelayUntil(now: Date): Date | null {
  const sendAt = collectionEmailSendAt(now);
  return sendAt.getTime() <= now.getTime() ? null : sendAt;
}
