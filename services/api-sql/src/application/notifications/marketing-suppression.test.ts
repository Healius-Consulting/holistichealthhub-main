import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { filterSuppressedRecipients } from './email-outbox.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function repoWith(suppressed: string[]) {
  const set = new Set(suppressed.map(hash));
  return { isSuppressed: async (contactHash: string) => set.has(contactHash) };
}

describe('marketing suppression', () => {
  it('drops a recipient who has unsubscribed', async () => {
    const allowed = await filterSuppressedRecipients(repoWith(['gone@example.test']), [
      { email: 'here@example.test' },
      { email: 'gone@example.test' },
    ]);
    assert.deepEqual(allowed.map(r => r.email), ['here@example.test']);
  });

  it('matches an unsubscribe regardless of case or padding', async () => {
    const allowed = await filterSuppressedRecipients(repoWith(['gone@example.test']), [
      { email: '  GONE@Example.TEST ' },
    ]);
    assert.deepEqual(allowed, []);
  });

  it('sends nothing when the suppression list cannot be read', async () => {
    const broken = { isSuppressed: async () => { throw new Error('unavailable'); } };
    const allowed = await filterSuppressedRecipients(broken, [{ email: 'here@example.test' }]);
    assert.deepEqual(allowed, []);
  });

  it('ignores a recipient with no address', async () => {
    const allowed = await filterSuppressedRecipients(repoWith([]), [{ email: '' }, { email: 'ok@example.test' }]);
    assert.deepEqual(allowed.map(r => r.email), ['ok@example.test']);
  });
});
