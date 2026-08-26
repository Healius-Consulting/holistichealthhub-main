const LONDON_TIME_ZONE = 'Europe/London';
const THREE_HOURS_MS = 3 * 60 * 60 * 1_000;

type LondonParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
};

function londonParts(date: Date): LondonParts {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: LONDON_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: String(parts.weekday),
  };
}

function londonLocalToUtc(year: number, month: number, day: number, hour: number, minute: number) {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
  const rendered = londonParts(new Date(utcGuess));
  const renderedAsUtc = Date.UTC(
    rendered.year,
    rendered.month - 1,
    rendered.day,
    rendered.hour,
    rendered.minute,
  );
  return new Date(utcGuess - (renderedAsUtc - utcGuess));
}

function nextWorkingDayNoon(startedAt: Date) {
  const local = londonParts(startedAt);
  const cursor = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
  while (true) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      return londonLocalToUtc(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate(), 12, 0);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

export function curaleafWaitingSla(startedAtValue: string, now = new Date()) {
  const startedAt = new Date(startedAtValue);
  if (!Number.isFinite(startedAt.getTime())) return null;
  const local = londonParts(startedAt);
  const isWorkingDay = !['Sat', 'Sun'].includes(local.weekday);
  const isIntakeWindow = isWorkingDay && local.hour >= 9 && local.hour <= 15;
  const dueAt = isIntakeWindow
    ? new Date(startedAt.getTime() + THREE_HOURS_MS)
    : nextWorkingDayNoon(startedAt);
  return {
    startedAt: startedAt.toISOString(),
    dueAt: dueAt.toISOString(),
    alert: now.getTime() >= dueAt.getTime(),
    policy: isIntakeWindow ? 'three_hours' as const : 'next_working_day_noon' as const,
    timeZone: LONDON_TIME_ZONE,
  };
}
