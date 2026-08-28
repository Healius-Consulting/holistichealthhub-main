import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveOwnerUid } from './pharmacy-owner.js';

describe('pharmacy owner', () => {
  it('tags the earliest account as owner', () => {
    assert.equal(resolveOwnerUid([
      { uid: 'staff', createdAt: '2026-01-02T10:00:00.000Z' },
      { uid: 'owner', createdAt: '2026-01-01T10:00:00.000Z' },
    ]), 'owner');
  });

  it('returns null when the pharmacy has no staff', () => {
    assert.equal(resolveOwnerUid([]), null);
  });
});
