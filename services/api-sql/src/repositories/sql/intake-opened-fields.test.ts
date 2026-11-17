import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/*
 * The "new" dot clears only if the list each queue is drawn from reads the
 * opened marker back. The admin list once read it on the single-record query
 * only, so every refresh showed opened enquiries as new again.
 */
const source = readFileSync(new URL('./intake.sql.ts', import.meta.url), 'utf8');
const query = (name: string) => {
  const start = source.indexOf(`const ${name} = \``);
  assert.ok(start >= 0, `${name} exists`);
  return source.slice(start, source.indexOf('`;', start));
};

describe('opened markers on the queue lists', () => {
  it('the admin queue list reads when HHH opened each enquiry', () => {
    assert.match(query('LIST_PLATFORM_SUBMISSIONS_GQL'), /\bhhhOpenedAt\b/);
    assert.match(query('GET_SUBMISSION_BY_ID_GQL'), /\bhhhOpenedAt\b/);
  });

  it('the pharmacy enquiry list reads whether the pharmacy opened each one', () => {
    assert.match(query('LIST_TENANT_PENDING_ENQUIRIES_GQL'), /\bpharmacyReviewStatus\b/);
  });
});
