/**
 * Enforces the retention periods published at /privacy (section 6).
 *
 *   npm run retention:dry-run   # report what would change, touch nothing
 *   npm run retention:apply     # reduce and delete what is due
 *
 * Intended to run daily. Scheduling it is an ops step (Cloud Scheduler or cron) —
 * the promise in the notice is only kept once something actually calls this.
 */
import { applyRetention } from '../services/api-sql/src/application/retention/apply-retention.js';
import { SqlIdentityRepository } from '../services/api-sql/src/repositories/sql/identity.sql.js';
import { SqlIntakeRepository } from '../services/api-sql/src/repositories/sql/intake.sql.js';

const dryRun = process.argv.includes('--dry-run');

const run = await applyRetention({
  intakeRepo: new SqlIntakeRepository(),
  identityRepo: new SqlIdentityRepository(),
  dryRun,
});

console.log(`${dryRun ? '[dry run] ' : ''}retention: examined ${run.examined}, reduced ${run.reduced.length}, deleted ${run.deleted.length}, failed ${run.failed.length}`);
for (const failure of run.failed) console.error(`  failed ${failure.id}: ${failure.reason}`);
if (run.failed.length) process.exitCode = 1;
