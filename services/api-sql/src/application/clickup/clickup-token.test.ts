import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IntegrationConnectionRecord } from '../../repositories/ports/integration.port.js';
import { allowedClickupSecretResource, clickupSecretResource, defaultClickupSecretResource, tokenFromSecret } from './clickup-token.js';

const connection = (secretResourceName: string, overrides: Partial<IntegrationConnectionRecord> = {}) => ({
  integration: 'CLICKUP',
  status: 'ACTIVE',
  secretResourceName,
  ...overrides,
}) as IntegrationConnectionRecord;

describe('ClickUp token secret', () => {
  it('uses the one London-pinned default secret when there is no CLICKUP connection', () => {
    assert.match(defaultClickupSecretResource(), /\/secrets\/hhh-clickup-token-europe-west2$/);
    assert.equal(clickupSecretResource([]), defaultClickupSecretResource());
    assert.equal(allowedClickupSecretResource(defaultClickupSecretResource()), true);
  });

  it('prefers an active CLICKUP connection, and ignores one naming a secret outside the allow-list', () => {
    const named = defaultClickupSecretResource().replace('hhh-clickup-token', 'hhh-clickup-board2');
    assert.equal(clickupSecretResource([connection(named)]), named);
    assert.equal(clickupSecretResource([connection('projects/other/secrets/stolen')]), defaultClickupSecretResource());
    assert.equal(clickupSecretResource([connection(named, { status: 'PAUSED' })]), defaultClickupSecretResource());
  });

  it('reads the token as plain text or JSON', () => {
    assert.equal(tokenFromSecret(' pk_abc \n'), 'pk_abc');
    assert.equal(tokenFromSecret('{"token":"pk_abc"}'), 'pk_abc');
    assert.equal(tokenFromSecret('{"token":""}'), null);
    assert.equal(tokenFromSecret(''), null);
  });
});
