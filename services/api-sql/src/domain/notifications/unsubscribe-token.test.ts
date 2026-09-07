import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { signUnsubscribe, unsubscribeUrl, verifyUnsubscribe } from './unsubscribe-token.js';

const contactHash = 'a'.repeat(64);

describe('unsubscribe token', () => {
  it('verifies a signature it produced', () => {
    assert.equal(verifyUnsubscribe(contactHash, signUnsubscribe(contactHash)), true);
  });

  it('refuses a signature made for a different contact', () => {
    assert.equal(verifyUnsubscribe(contactHash, signUnsubscribe('b'.repeat(64))), false);
  });

  it('refuses a tampered or malformed signature', () => {
    assert.equal(verifyUnsubscribe(contactHash, 'not-a-signature'), false);
    assert.equal(verifyUnsubscribe(contactHash, ''), false);
  });

  it('builds a link that carries no readable address', () => {
    const url = new URL(unsubscribeUrl('https://holistichealthhub.live', contactHash));
    assert.equal(url.pathname, '/unsubscribe');
    assert.equal(url.searchParams.get('c'), contactHash);
    assert.equal(verifyUnsubscribe(contactHash, url.searchParams.get('s')!), true);
  });
});
