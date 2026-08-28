const DAY_MS = 24 * 60 * 60 * 1000;
const SERIAL_REUSE_WINDOW_DAYS = 24;
const LONDON_DATE = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export type SerialReuseWindowStatus = 'current' | 'future' | 'expired' | 'invalid';
export type SerialOccupancyReason = 'free' | 'source_owner' | 'self' | 'SERIAL_IN_USE';
export type CuraleafSerialGuard = 'create' | 'CURALEAF_SERIAL_STILL_LIVE' | 'unknown';

function dateOrdinal(value?: string | null) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').slice(0, 10));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return Math.floor(date.getTime() / DAY_MS);
}

function londonTodayOrdinal(now: Date | string = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(LONDON_DATE.formatToParts(date).map(part => [part.type, part.value]));
  return dateOrdinal(`${parts.year}-${parts.month}-${parts.day}`);
}

function ordinalDate(ordinal: number) {
  return new Date(ordinal * DAY_MS).toISOString().slice(0, 10);
}

export function normalizeSerialNumber(value?: string | null) {
  return String(value || '').trim();
}

export function serialReuseUntilDate(issueDate?: string | null) {
  const issued = dateOrdinal(issueDate);
  return issued === null ? null : ordinalDate(issued + SERIAL_REUSE_WINDOW_DAYS);
}

export function serialReuseWindowStatus(issueDate?: string | null, now: Date | string = new Date()): SerialReuseWindowStatus {
  const issued = dateOrdinal(issueDate);
  const today = londonTodayOrdinal(now);
  if (issued === null || today === null) return 'invalid';
  if (issued > today) return 'future';
  if (today > issued + SERIAL_REUSE_WINDOW_DAYS) return 'expired';
  return 'current';
}

export function serialReuseIsCurrent(issueDate?: string | null, now: Date | string = new Date()) {
  return serialReuseWindowStatus(issueDate, now) === 'current';
}

export function evaluateSerialOccupancy(input: {
  liveOrderId?: string | null;
  livePatientId?: string | null;
  sourceOrderId?: string | null;
  currentOrderId?: string | null;
  currentPatientId?: string | null;
}) {
  const liveOrderId = String(input.liveOrderId || '').trim();
  if (!liveOrderId) return { allowed: true as const, reason: 'free' as const };
  const sourceOrderId = String(input.sourceOrderId || '').trim();
  const currentOrderId = String(input.currentOrderId || '').trim();
  if (currentOrderId && liveOrderId === currentOrderId) return { allowed: true as const, reason: 'self' as const };
  if (sourceOrderId && liveOrderId === sourceOrderId) {
    const livePatientId = String(input.livePatientId || '').trim();
    const currentPatientId = String(input.currentPatientId || '').trim();
    if (livePatientId && currentPatientId && livePatientId !== currentPatientId) {
      return { allowed: false as const, reason: 'SERIAL_IN_USE' as const, occupyingOrderId: liveOrderId };
    }
    return { allowed: true as const, reason: 'source_owner' as const, occupyingOrderId: liveOrderId };
  }
  return { allowed: false as const, reason: 'SERIAL_IN_USE' as const, occupyingOrderId: liveOrderId };
}

export function normalisedSerialBasket(lines: Array<{ packId?: string | null; formulaId?: string | null; quantity?: number | null; unitsNeededCount?: number | null }>) {
  return lines
    .map(line => ({
      packId: String(line.packId || '').trim(),
      formulaId: String(line.formulaId || '').trim(),
      quantity: Math.trunc(Number(line.quantity || 0)),
      unitsNeededCount: Math.trunc(Number(line.unitsNeededCount || 0)),
    }))
    .filter(line => (line.packId || line.formulaId) && (line.quantity > 0 || line.unitsNeededCount > 0))
    .sort((left, right) => `${left.formulaId}:${left.packId}`.localeCompare(`${right.formulaId}:${right.packId}`));
}

export function serialBasketMatches(
  sourceLines: Array<{ packId?: string | null; formulaId?: string | null; quantity?: number | null; unitsNeededCount?: number | null }>,
  replacementLines: Array<{ packId?: string | null; formulaId?: string | null; quantity?: number | null; unitsNeededCount?: number | null }>,
) {
  return JSON.stringify(normalisedSerialBasket(sourceLines)) === JSON.stringify(normalisedSerialBasket(replacementLines));
}

export function prescriptionFileIsUsable(file?: { status?: string | null; deletedAt?: string | null } | null) {
  if (!file) return false;
  if (file.deletedAt) return false;
  return !['DELETED', 'QUARANTINED', 'REJECTED'].includes(String(file.status || '').toUpperCase());
}

export function curaleafSerialAllowsCreate(input: { state?: string | null; httpStatus?: number | null }) {
  if (input.httpStatus === 404) return { allowed: true as const, reason: 'create' as const };
  const state = String(input.state || '').toUpperCase();
  if (['CANCELLED', 'EXPIRED', 'FULFILLED'].includes(state)) return { allowed: true as const, reason: 'create' as const };
  if (['PENDING', 'ACTIVE'].includes(state)) return { allowed: false as const, reason: 'CURALEAF_SERIAL_STILL_LIVE' as const };
  if (input.httpStatus && input.httpStatus >= 400) return { allowed: false as const, reason: 'unknown' as const };
  if (!state) return { allowed: true as const, reason: 'create' as const };
  return { allowed: false as const, reason: 'unknown' as const };
}

export function curaleafSerialLookupDecision(input: { state?: string | null; httpStatus?: number | null }) {
  const guard = curaleafSerialAllowsCreate(input);
  if (guard.allowed) return 'allow' as const;
  if (guard.reason === 'CURALEAF_SERIAL_STILL_LIVE') return 'block_live' as const;
  const status = Number(input.httpStatus || 0);
  if (status === 400 || status === 409 || status === 422) return 'block_live' as const;
  return 'fail_open' as const;
}

export function manualSerialCreatePolicy(input: {
  serialNumber?: string | null;
  issueDate?: string | null;
  occupancy: ReturnType<typeof evaluateSerialOccupancy>;
  asOf?: Date | string;
}) {
  if (!normalizeSerialNumber(input.serialNumber)) {
    return { allowed: false as const, reason: 'SERIAL_REQUIRED' as const };
  }
  if (!serialReuseIsCurrent(input.issueDate, input.asOf)) {
    return { allowed: false as const, reason: 'SERIAL_REUSE_EXPIRED' as const };
  }
  if (!input.occupancy.allowed) {
    return { allowed: false as const, reason: 'SERIAL_IN_USE' as const, occupyingOrderId: input.occupancy.occupyingOrderId };
  }
  return { allowed: true as const, reason: 'ok' as const };
}

export function replacementSerialPolicy(input: {
  sourceSerial?: string | null;
  sourceIssueDate?: string | null;
  sourceOrderId?: string | null;
  sourcePatientId?: string | null;
  liveOrderId?: string | null;
  livePatientId?: string | null;
  currentOrderId?: string | null;
  currentPatientId?: string | null;
  replacementSerial?: string | null;
  replacementIssueDate?: string | null;
  replacementHasUsableFile: boolean;
  sourceLines: Array<{ packId?: string | null; formulaId?: string | null; quantity?: number | null; unitsNeededCount?: number | null }>;
  replacementLines: Array<{ packId?: string | null; formulaId?: string | null; quantity?: number | null; unitsNeededCount?: number | null }>;
  asOf?: Date | string;
}) {
  const sourceSerial = normalizeSerialNumber(input.sourceSerial);
  const replacementSerial = normalizeSerialNumber(input.replacementSerial);
  const reusesSourceSerial = Boolean(sourceSerial && replacementSerial && sourceSerial === replacementSerial);
  const occupancy = evaluateSerialOccupancy({
    liveOrderId: input.liveOrderId,
    livePatientId: input.livePatientId,
    sourceOrderId: input.sourceOrderId,
    currentOrderId: input.currentOrderId,
    currentPatientId: input.currentPatientId,
  });

  if (!replacementSerial) {
    return { allowed: false as const, reusesSourceSerial: false, reason: 'SERIAL_REQUIRED' as const };
  }
  if (!occupancy.allowed) {
    return { allowed: false as const, reusesSourceSerial, reason: 'SERIAL_IN_USE' as const, occupyingOrderId: occupancy.occupyingOrderId };
  }
  if (!input.replacementHasUsableFile) {
    return { allowed: false as const, reusesSourceSerial, reason: 'replacement_prescription_file_required' as const };
  }
  if (reusesSourceSerial) {
    if (serialReuseWindowStatus(input.sourceIssueDate || input.replacementIssueDate, input.asOf) !== 'current') {
      return { allowed: false as const, reusesSourceSerial: true, reason: 'SERIAL_REUSE_EXPIRED' as const };
    }
    if (!serialBasketMatches(input.sourceLines, input.replacementLines)) {
      return { allowed: false as const, reusesSourceSerial: true, reason: 'SERIAL_BASKET_MISMATCH' as const };
    }
    return { allowed: true as const, reusesSourceSerial: true };
  }
  return { allowed: true as const, reusesSourceSerial: false };
}
