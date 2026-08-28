const DAY_MS = 24 * 60 * 60 * 1000;
const PRESCRIPTION_WINDOW_DAYS = 28;
const SERIAL_REUSE_WINDOW_DAYS = 24;
const LONDON_DATE = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function dateOrdinal(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return Math.floor(date.getTime() / DAY_MS);
}

function londonTodayOrdinal(now) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(LONDON_DATE.formatToParts(date).map(part => [part.type, part.value]));
  return dateOrdinal(`${parts.year}-${parts.month}-${parts.day}`);
}

function ordinalDate(ordinal) {
  return new Date(ordinal * DAY_MS).toISOString().slice(0, 10);
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

export function normalisePrescriptionDateParts(day, month, year) {
  const values = [day, month, year].map(value => String(value ?? '').trim());
  if (values.every(value => !value)) return { status: 'empty', value: '' };
  if (values.some(value => !value) || !/^\d{1,2}$/.test(values[0]) || !/^\d{1,2}$/.test(values[1]) || !/^\d{2}(?:\d{2})?$/.test(values[2])) {
    return { status: 'incomplete', value: '' };
  }
  const fullYear = values[2].length === 2 ? `20${values[2]}` : values[2];
  const candidate = `${fullYear}-${values[1].padStart(2, '0')}-${values[0].padStart(2, '0')}`;
  if (dateOrdinal(candidate) === null) return { status: 'invalid', value: '' };
  return { status: 'valid', value: candidate, display: `${values[0].padStart(2, '0')}/${values[1].padStart(2, '0')}/${fullYear}` };
}

export function prescriptionExpiryDisplay(issueDate, now = new Date()) {
  const issued = dateOrdinal(issueDate);
  const today = londonTodayOrdinal(now);
  if (issued === null || today === null) return null;
  const expiryOrdinal = issued + PRESCRIPTION_WINDOW_DAYS;
  const expiryDate = ordinalDate(expiryOrdinal);
  const [, month, day] = expiryDate.split('-').map(Number);
  const daysRemaining = expiryOrdinal - today;
  const formattedExpiry = `${String(day).padStart(2, '0')} ${MONTH_LABELS[month - 1]} ${expiryDate.slice(0, 4)}`;
  return {
    expiryDate,
    daysRemaining,
    tone: daysRemaining < 0 ? 'red' : daysRemaining < 7 ? 'amber' : 'green',
    text: daysRemaining < 0
      ? `Expired on ${formattedExpiry} · ${Math.abs(daysRemaining)}d ago.`
      : `Valid until ${formattedExpiry} · ${daysRemaining}d left.`,
  };
}

export function prescriptionIssueDateBounds(now = new Date()) {
  const today = londonTodayOrdinal(now);
  if (today === null) return null;
  return { min: ordinalDate(today - PRESCRIPTION_WINDOW_DAYS), max: ordinalDate(today) };
}

export function calculatePrescriptionExpiryDate(issueDate) {
  const issued = dateOrdinal(issueDate);
  return issued === null ? null : ordinalDate(issued + PRESCRIPTION_WINDOW_DAYS);
}

export function prescriptionDateWindowStatus(issueDate, suppliedExpiryDate, now = new Date()) {
  const issued = dateOrdinal(issueDate);
  const today = londonTodayOrdinal(now);
  if (issued === null || today === null) return 'invalid';
  if (issued > today) return 'future';
  if (issued < today - PRESCRIPTION_WINDOW_DAYS) return 'expired';

  const maximumExpiry = issued + PRESCRIPTION_WINDOW_DAYS;
  const expires = suppliedExpiryDate ? dateOrdinal(suppliedExpiryDate) : maximumExpiry;
  if (expires === null || expires < issued || expires > maximumExpiry) return 'invalid';
  if (expires < today) return 'expired';
  return 'current';
}

export function prescriptionDateIsCurrent(issueDate, suppliedExpiryDate, now = new Date()) {
  return prescriptionDateWindowStatus(issueDate, suppliedExpiryDate, now) === 'current';
}

export function serialReuseUntilDate(issueDate) {
  const issued = dateOrdinal(issueDate);
  return issued === null ? null : ordinalDate(issued + SERIAL_REUSE_WINDOW_DAYS);
}

export function serialReuseWindowStatus(issueDate, now = new Date()) {
  const issued = dateOrdinal(issueDate);
  const today = londonTodayOrdinal(now);
  if (issued === null || today === null) return 'invalid';
  if (issued > today) return 'future';
  if (today > issued + SERIAL_REUSE_WINDOW_DAYS) return 'expired';
  return 'current';
}

export function serialReuseIsCurrent(issueDate, now = new Date()) {
  return serialReuseWindowStatus(issueDate, now) === 'current';
}

export function serialReuseDisplay(issueDate, now = new Date()) {
  const until = serialReuseUntilDate(issueDate);
  const issued = dateOrdinal(issueDate);
  const today = londonTodayOrdinal(now);
  if (!until || issued === null || today === null) return null;
  const daysRemaining = issued + SERIAL_REUSE_WINDOW_DAYS - today;
  const [, month, day] = until.split('-').map(Number);
  const formattedUntil = `${String(day).padStart(2, '0')} ${MONTH_LABELS[month - 1]} ${until.slice(0, 4)}`;
  return {
    untilDate: until,
    daysRemaining,
    tone: daysRemaining < 0 ? 'red' : daysRemaining < 7 ? 'amber' : 'green',
    text: daysRemaining < 0
      ? `Serial expired on ${formattedUntil} · cannot be reused.`
      : daysRemaining === 0
        ? `Serial reusable until ${formattedUntil} · last day.`
        : `Serial reusable until ${formattedUntil} · ${daysRemaining}d left.`,
  };
}
