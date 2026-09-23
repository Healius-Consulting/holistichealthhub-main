import type { IntegrationEnvironment, IntegrationStatus } from '../ports/integration.port.js';

export interface RestorableConnection {
  id: string;
  environment: IntegrationEnvironment;
  status: IntegrationStatus;
  version: number;
  updatedAt: string;
}

function statusRank(status: IntegrationStatus) {
  if (status === 'ACTIVE') return 0;
  if (status === 'PENDING_VALIDATION') return 1;
  return 2;
}

/**
 * One pharmacy can have a test row and a live row. Callers that do not name an
 * estate need the one that is actually in use, and the newest one when two are.
 */
export function preferIntegrationConnection<T extends Pick<RestorableConnection, 'status' | 'updatedAt'>>(rows: T[]): T | null {
  return [...rows].sort((left, right) => {
    const byStatus = statusRank(left.status) - statusRank(right.status);
    if (byStatus !== 0) return byStatus;
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  })[0] ?? null;
}

export interface ConnectionRestorePlan {
  /** Existing row to overwrite. Null means insert a new row. */
  update: { id: string; version: number } | null;
  /** Other live rows that must be retired so the next read cannot return the previous estate. */
  disconnectIds: string[];
}

function nextVersion(version: number) {
  const current = Number(version);
  return (Number.isFinite(current) ? current : 0) + 1;
}

/**
 * The connection table is unique on organisation + integration + environment.
 * A credential save has to land on the estate the vendor just accepted.
 * Updating "whichever row we found" and leaving its environment untouched kept
 * a live key labelled as test, so the next call went to the wrong host.
 */
export function planConnectionRestore(
  rows: RestorableConnection[],
  environment: IntegrationEnvironment,
): ConnectionRestorePlan {
  const onEstate = rows.filter(row => row.environment === environment);
  const target = preferIntegrationConnection(onEstate);
  const liveOthers = (keepId: string | null) => rows
    .filter(row => row.id !== keepId && row.status !== 'DISCONNECTED')
    .map(row => row.id);

  if (target) {
    return {
      update: { id: target.id, version: nextVersion(target.version) },
      disconnectIds: liveOthers(target.id),
    };
  }

  // A single row can change estate in place. Two rows cannot: the other estate
  // already occupies its unique slot, so this save inserts and retires the rest.
  if (rows.length <= 1) {
    const only = rows[0];
    return only
      ? { update: { id: only.id, version: nextVersion(only.version) }, disconnectIds: [] }
      : { update: null, disconnectIds: [] };
  }

  return { update: null, disconnectIds: liveOthers(null) };
}
