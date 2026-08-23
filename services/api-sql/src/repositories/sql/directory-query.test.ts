import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./directory.sql.ts', import.meta.url)), 'utf8');
const organisationQuery = source.slice(
  source.indexOf('query ListDirectoryOrganisations'),
  source.indexOf('query ListDirectoryDomains'),
);

describe('public directory organisation query', () => {
  it('loads website hostnames from OrganisationDomain, not a missing Organisation field', () => {
    assert.match(organisationQuery, /query ListDirectoryOrganisations/);
    assert.doesNotMatch(organisationQuery, /websiteDomains/);
    assert.match(source, /query ListDirectoryDomains/);
    assert.match(source, /organisationDomains\(limit: 500\)/);
  });
});
