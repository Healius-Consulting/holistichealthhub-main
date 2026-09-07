import { retentionActionFor } from '../../domain/retention/policy.js';
import type { IdentityRepositoryPort } from '../../repositories/ports/identity.port.js';
import type { IntakeRepositoryPort } from '../../repositories/ports/intake.port.js';

export type RetentionRun = {
  examined: number;
  reduced: string[];
  deleted: string[];
  failed: Array<{ id: string; reason: string }>;
};

/**
 * Enforces the retention table published in Privacy 6. Deliberately reports rather
 * than throws on a per-record failure: one stuck row must not stop the rest of the
 * run, or a single bad record quietly suspends deletion for everyone.
 *
 * Pass `dryRun` to see what a run would do before letting it delete anything.
 */
export async function applyRetention(deps: {
  intakeRepo: Pick<IntakeRepositoryPort, 'listRetentionCandidates' | 'reduceToMinimalRecord' | 'deleteSubmission'>;
  identityRepo?: Pick<IdentityRepositoryPort, 'appendAudit'>;
  now?: Date;
  dryRun?: boolean;
  limit?: number;
}): Promise<RetentionRun> {
  const now = deps.now ?? new Date();
  const candidates = await deps.intakeRepo.listRetentionCandidates(deps.limit);
  const run: RetentionRun = { examined: candidates.length, reduced: [], deleted: [], failed: [] };

  for (const candidate of candidates) {
    const decision = retentionActionFor({
      outcomeStatus: candidate.outcomeStatus,
      closedAt: candidate.completedAt,
      lastActivityAt: candidate.updatedAt,
      minimalSince: candidate.minimalRecordSince,
    }, now);
    if (decision.action === 'retain') continue;

    try {
      if (decision.action === 'reduce_to_minimal_record') {
        if (!deps.dryRun) await deps.intakeRepo.reduceToMinimalRecord(candidate.id);
        run.reduced.push(candidate.id);
      } else {
        if (!deps.dryRun) await deps.intakeRepo.deleteSubmission(candidate.id);
        run.deleted.push(candidate.id);
      }
    } catch (error) {
      run.failed.push({ id: candidate.id, reason: error instanceof Error ? error.message : 'unknown' });
    }
  }

  if (!deps.dryRun && deps.identityRepo && (run.reduced.length || run.deleted.length || run.failed.length)) {
    await deps.identityRepo.appendAudit({
      event: 'retention.applied',
      surface: 'system',
      details: {
        examined: run.examined,
        reduced: run.reduced.length,
        deleted: run.deleted.length,
        failed: run.failed.length,
      },
    });
  }

  return run;
}
