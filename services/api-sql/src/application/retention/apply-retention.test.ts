import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyRetention } from './apply-retention.js';
import type { RetentionCandidateRecord } from '../../repositories/ports/intake.port.js';

function repo(candidates: RetentionCandidateRecord[], failOn: string[] = []) {
  const reduced: string[] = [];
  const deleted: string[] = [];
  return {
    reduced,
    deleted,
    listRetentionCandidates: async () => candidates,
    reduceToMinimalRecord: async (id: string) => {
      if (failOn.includes(id)) throw new Error('conflict');
      reduced.push(id);
    },
    deleteSubmission: async (id: string) => {
      if (failOn.includes(id)) throw new Error('conflict');
      deleted.push(id);
    },
  };
}

const declined = (id: string, completedAt: string, minimalRecordSince: string | null = null): RetentionCandidateRecord => ({
  id, outcomeStatus: 'DECLINED', completedAt, updatedAt: completedAt, minimalRecordSince,
});

describe('applying retention', () => {
  it('reduces and deletes according to the published periods', async () => {
    const intakeRepo = repo([
      declined('fresh', '2026-08-01T00:00:00.000Z'),
      declined('three-months', '2026-01-01T00:00:00.000Z'),
      declined('twelve-months', '2025-01-01T00:00:00.000Z', '2025-04-01T00:00:00.000Z'),
    ]);
    const run = await applyRetention({ intakeRepo, now: new Date('2026-09-07T00:00:00.000Z') });
    assert.deepEqual(run.reduced, ['three-months']);
    assert.deepEqual(run.deleted, ['twelve-months']);
    assert.equal(run.examined, 3);
  });

  it('changes nothing on a dry run', async () => {
    const intakeRepo = repo([declined('due', '2026-01-01T00:00:00.000Z')]);
    const run = await applyRetention({ intakeRepo, now: new Date('2026-09-07T00:00:00.000Z'), dryRun: true });
    assert.deepEqual(run.reduced, ['due']);
    assert.deepEqual(intakeRepo.reduced, []);
  });

  it('keeps going when one record fails, and reports it', async () => {
    const intakeRepo = repo([
      declined('stuck', '2026-01-01T00:00:00.000Z'),
      declined('fine', '2026-01-02T00:00:00.000Z'),
    ], ['stuck']);
    const run = await applyRetention({ intakeRepo, now: new Date('2026-09-07T00:00:00.000Z') });
    assert.deepEqual(run.reduced, ['fine']);
    assert.deepEqual(run.failed, [{ id: 'stuck', reason: 'conflict' }]);
  });

  it('leaves an open application alone', async () => {
    const intakeRepo = repo([
      { id: 'open', outcomeStatus: 'OPEN', completedAt: null, updatedAt: '2020-01-01T00:00:00.000Z', minimalRecordSince: null },
    ]);
    const run = await applyRetention({ intakeRepo, now: new Date('2030-01-01T00:00:00.000Z') });
    assert.deepEqual(run.reduced, []);
    assert.deepEqual(run.deleted, []);
  });
});
