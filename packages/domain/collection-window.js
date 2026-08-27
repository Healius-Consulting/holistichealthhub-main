/**
 * When the patient's "ready to collect" email actually goes out.
 *
 * The pharmacy never sends this by hand: recording goods-in is the act that tells the
 * patient. But an email that lands at 20:00 invites a wasted trip to a closed
 * dispensary, so a weekday check-in before 15:00 London sends immediately and
 * everything else is held to 09:00 on the next working day.
 *
 * This mirrors the server's `collection-email-schedule.ts` so the workspace can state
 * the same answer the queue will reach. `tests/collectionWindow.test.ts` runs both
 * implementations over the same instants and fails if they ever disagree.
 */

const LONDON = 'Europe/London';

/** Latest London hour a same-day collection email may be sent. */
export const COLLECTION_EMAIL_CUTOFF_HOUR = 15;

/** London hour the next working day's collection emails go out. */
export const COLLECTION_EMAIL_SEND_HOUR = 9;

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function londonParts(instant) {
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
function londonOffsetMinutes(instant) {
  const parts = londonParts(instant);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return Math.round((asUtc - Math.floor(instant.getTime() / 60000) * 60000) / 60000);
}

function londonWallClockToInstant(year, month, day, hour) {
  const naive = Date.UTC(year, month - 1, day, hour, 0, 0, 0);
  // Resolve with the offset in force around that date, then confirm it still holds —
  // a DST boundary can shift the offset between the two readings.
  const firstGuess = new Date(naive - londonOffsetMinutes(new Date(naive)) * 60000);
  return new Date(naive - londonOffsetMinutes(firstGuess) * 60000);
}

function isWeekend(weekday) {
  return weekday === 0 || weekday === 6;
}

/** The instant a collection email queued at `now` will send. `now` itself when immediate. */
export function collectionEmailSendAt(now) {
  const parts = londonParts(now);
  if (!isWeekend(parts.weekday) && parts.hour < COLLECTION_EMAIL_CUTOFF_HOUR) return now;

  let cursor = new Date(now.getTime());
  let cursorParts = parts;
  do {
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    cursorParts = londonParts(cursor);
  } while (isWeekend(cursorParts.weekday));

  return londonWallClockToInstant(cursorParts.year, cursorParts.month, cursorParts.day, COLLECTION_EMAIL_SEND_HOUR);
}

/** Null when the email sends immediately, otherwise the instant it is held until. */
export function collectionEmailDelayUntil(now) {
  const sendAt = collectionEmailSendAt(now);
  return sendAt.getTime() <= now.getTime() ? null : sendAt;
}

/**
 * One sentence the workspace can show a member of staff, so "when does the patient
 * find out?" is answered on screen instead of being folklore.
 */
export function collectionEmailNotice(now = new Date()) {
  const heldUntil = collectionEmailDelayUntil(now);
  if (!heldUntil) {
    return {
      immediate: true,
      sendAt: now,
      summary: 'Patient emailed now',
      detail: `Checked in before the ${COLLECTION_EMAIL_CUTOFF_HOUR}:00 cut-off, so the collection email goes out on the next delivery run.`,
    };
  }
  const when = new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON,
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(heldUntil);
  return {
    immediate: false,
    sendAt: heldUntil,
    summary: `Patient emailed ${when}`,
    detail: `Past the ${COLLECTION_EMAIL_CUTOFF_HOUR}:00 cut-off or outside the working week, so the collection email is held to ${COLLECTION_EMAIL_SEND_HOUR}:00 on the next working day. A patient is never invited to a closed dispensary.`,
  };
}
