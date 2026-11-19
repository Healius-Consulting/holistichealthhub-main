import {
  CLICKUP_FIELD_KEYS,
  clickupStageFor,
  type ClickupCardFields,
  type ClickupStage,
} from '../../domain/clickup/clickup-events.js';
import type {
  ClickupOutboxRecord,
  ClickupRepositoryPort,
  PharmacyOnboardingVisitRepositoryPort,
} from '../../repositories/ports/clickup.port.js';
import { httpClickupClient, type ClickupClient, type ClickupFieldValue } from './clickup-client.js';
import type { ClickupConfig, ClickupFieldName } from './clickup-config.js';

export const CLICKUP_MAX_ATTEMPTS = 8;

/** 5, 10, 20 … minutes, capped at 6 hours: eight tries cover about a day of ClickUp outage. */
export function clickupRetryAt(now: Date, attemptCount: number) {
  const delayMinutes = Math.min(5 * (2 ** Math.max(0, attemptCount - 1)), 360);
  return new Date(now.getTime() + delayMinutes * 60_000);
}

export type ClickupSyncDeps = {
  clickupRepo: ClickupRepositoryPort;
  /** Null until HHH sets the list id. */
  config: () => ClickupConfig | null;
  /** Null until the CLICKUP connection and its secret exist. */
  token: () => Promise<string | null>;
  client?: (token: string) => ClickupClient;
  now?: () => Date;
};

export type ClickupSyncSummary = {
  checked: number;
  sent: number;
  retried: number;
  failed: number;
  /** Left queued: not due yet, behind an earlier event for the same card, or ClickUp not set up. */
  waiting: number;
  notConfigured: boolean;
};

function cardName(fields: ClickupCardFields) {
  return fields.tradingName ? `${fields.tradingName} (GPhC ${fields.gphcNumber})` : `GPhC ${fields.gphcNumber}`;
}

function fieldValue(key: keyof ClickupCardFields, value: unknown): ClickupFieldValue | null {
  if (value == null || value === '') return null;
  if (key === 'checklistPercent') return Number(value);
  if (key === 'termsAcceptedAt') {
    const at = Date.parse(String(value));
    return Number.isFinite(at) ? at : null;
  }
  return String(value);
}

/** The custom field values this event writes, for the fields HHH has configured. */
export function clickupFieldValues(
  config: ClickupConfig,
  fields: ClickupCardFields,
  flags: { pharCodeEntered: boolean; apiKeyEntered: boolean; event: ClickupOutboxRecord['event'] },
) {
  const values: Array<{ id: string; value: ClickupFieldValue }> = [];
  const add = (name: ClickupFieldName, value: ClickupFieldValue | null) => {
    const id = config.fields[name];
    if (id && value !== null) values.push({ id, value });
  };
  for (const key of CLICKUP_FIELD_KEYS) {
    if (key === 'tradingName') continue;
    add(key, fieldValue(key, fields[key]));
  }
  if (flags.event === 'phar_code_entered') add('pharCodeEntered', true);
  if (flags.event === 'api_key_entered') add('apiKeyEntered', true);
  if ((flags.event === 'phar_code_entered' || flags.event === 'api_key_entered') && flags.pharCodeEntered && flags.apiKeyEntered) {
    add('setupComplete', true);
  }
  if (flags.event === 'worldpay_validated') add('worldpayValidated', true);
  return values;
}

async function applyEvent(record: ClickupOutboxRecord, config: ClickupConfig, client: ClickupClient, repo: ClickupRepositoryPort) {
  const fields = record.payload;
  const card = await repo.findCard({
    gphcNumber: record.gphcNumber,
    onboardingRequestId: fields.onboardingRequestId,
    organisationId: fields.branchId,
  });
  const gphcNumber = card?.gphcNumber ?? record.gphcNumber;
  // Our row is the record of the card. If it was lost after ClickUp made the task,
  // the GPhC field finds that task again, so a retry never makes a second card.
  let taskId = card?.clickupTaskId ?? null;
  if (!taskId && config.fields.gphcNumber) {
    taskId = await client.findTaskByField(config.listId, config.fields.gphcNumber, gphcNumber);
  }
  const pharCodeEntered = Boolean(card?.pharCodeEntered) || record.event === 'phar_code_entered';
  const apiKeyEntered = Boolean(card?.apiKeyEntered) || record.event === 'api_key_entered';
  const stage = clickupStageFor(record.event, {
    exists: Boolean(taskId),
    stage: card?.stage ?? null,
    pharCodeEntered,
    apiKeyEntered,
  });
  const values = clickupFieldValues(config, { ...fields, gphcNumber }, { pharCodeEntered, apiKeyEntered, event: record.event });
  const saved = {
    gphcNumber,
    onboardingRequestId: fields.onboardingRequestId ?? card?.onboardingRequestId ?? null,
    organisationId: fields.branchId ?? card?.organisationId ?? null,
    stage: (stage ?? card?.stage ?? null) as ClickupStage | null,
    pharCodeEntered,
    apiKeyEntered,
  };

  if (!taskId) {
    const created = await client.createTask(config.listId, {
      name: cardName({ ...fields, gphcNumber }),
      status: config.statuses[stage ?? 'awaiting_curaleaf'],
      customFields: values,
    });
    await repo.saveCard({ ...saved, clickupTaskId: created, stage: stage ?? 'awaiting_curaleaf' });
    if (fields.comment) await client.addComment(created, fields.comment);
    return;
  }

  const change: { name?: string; status?: string } = {};
  if (stage) change.status = config.statuses[stage];
  if (fields.tradingName) change.name = cardName({ ...fields, gphcNumber });
  if (change.name || change.status) await client.updateTask(taskId, change);
  for (const value of values) await client.setField(taskId, value.id, value.value);
  if (fields.comment) await client.addComment(taskId, fields.comment);
  await repo.saveCard({ ...saved, clickupTaskId: taskId });
}

let warnedNotConfigured = false;

/**
 * Drains the ClickUp outbox, oldest first. A card's events go in order: once one
 * waits or fails, the rest of that card's events wait behind it. A failure is
 * retried with backoff and never thrown; with no config or token every event
 * simply stays queued until HHH sets them up.
 */
export async function syncClickup(deps: ClickupSyncDeps, limit = 100): Promise<ClickupSyncSummary> {
  const now = deps.now?.() ?? new Date();
  const pending = await deps.clickupRepo.listPending(limit);
  const summary: ClickupSyncSummary = { checked: pending.length, sent: 0, retried: 0, failed: 0, waiting: 0, notConfigured: false };
  if (pending.length === 0) return summary;

  const config = deps.config();
  const token = config ? await deps.token() : null;
  if (!config || !token) {
    summary.notConfigured = true;
    summary.waiting = pending.length;
    if (!warnedNotConfigured) {
      warnedNotConfigured = true;
      console.warn('ClickUp is not set up yet; events stay queued', { missing: !config ? 'CLICKUP_LIST_ID' : 'CLICKUP connection token' });
    }
    return summary;
  }
  const client = (deps.client ?? httpClickupClient)(token);

  const blocked = new Set<string>();
  for (const record of pending) {
    if (blocked.has(record.gphcNumber)) {
      summary.waiting += 1;
      continue;
    }
    if (record.nextAttemptAt && Date.parse(record.nextAttemptAt) > now.getTime()) {
      blocked.add(record.gphcNumber);
      summary.waiting += 1;
      continue;
    }
    const attemptCount = record.attemptCount + 1;
    try {
      await deps.clickupRepo.markProcessing(record.id, attemptCount);
      await applyEvent(record, config, client, deps.clickupRepo);
      await deps.clickupRepo.markSent(record.id);
      summary.sent += 1;
    } catch (error) {
      blocked.add(record.gphcNumber);
      const reason = (error instanceof Error ? error.message : 'Unknown ClickUp error').slice(0, 180);
      console.warn('ClickUp sync failed', { event: record.event, attemptCount, reason });
      if (attemptCount < CLICKUP_MAX_ATTEMPTS) {
        summary.retried += 1;
        await deps.clickupRepo.markRetry(record.id, attemptCount, clickupRetryAt(now, attemptCount).toISOString(), reason)
          .catch(() => undefined);
      } else {
        summary.failed += 1;
        await deps.clickupRepo.markFailed(record.id, attemptCount, reason).catch(() => undefined);
      }
    }
  }
  return summary;
}

export const VISIT_RETENTION_MONTHS = 12;

/**
 * 2.11 retention: a "visited, not submitted" record goes after 12 months with no
 * submission. A GPhC that did submit (say from the public page, which can't mark
 * the visit) is marked submitted instead of deleted.
 */
export async function pruneStaleOnboardingVisits(deps: {
  visitRepo: Pick<PharmacyOnboardingVisitRepositoryPort, 'listUnsubmittedBefore' | 'deleteVisit' | 'markSubmitted'>;
  findLatestRequest: (gphcNumber: string) => Promise<{ id: string } | null>;
  now?: () => Date;
}, limit = 200) {
  const now = deps.now?.() ?? new Date();
  const cutoff = new Date(now);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - VISIT_RETENTION_MONTHS);
  const stale = await deps.visitRepo.listUnsubmittedBefore(cutoff.toISOString(), limit);
  const summary = { examined: stale.length, deleted: 0, keptSubmitted: 0, failed: 0 };
  for (const visit of stale) {
    try {
      if (await deps.findLatestRequest(visit.gphcNumber)) {
        await deps.visitRepo.markSubmitted(visit.gphcNumber, now.toISOString());
        summary.keptSubmitted += 1;
      } else {
        await deps.visitRepo.deleteVisit(visit.gphcNumber);
        summary.deleted += 1;
      }
    } catch (error) {
      summary.failed += 1;
      console.error('Onboarding visit pruning failed', error instanceof Error ? error.message : 'unknown');
    }
  }
  return summary;
}
