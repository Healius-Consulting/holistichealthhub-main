import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('./directory.sql.ts', import.meta.url)), 'utf8');
const organisationQuery = source.slice(
  source.indexOf('query ListDirectoryOrganisations'),
  source.indexOf('query ListDirectoryDomains'),
);

const listedProfile = source.slice(
  source.indexOf('function toListedProfile'),
  source.indexOf('export class SqlDirectoryRepository'),
);

describe('public directory organisation query', () => {
  it('loads website hostnames from OrganisationDomain, not a missing Organisation field', () => {
    assert.match(organisationQuery, /query ListDirectoryOrganisations/);
    assert.doesNotMatch(organisationQuery, /websiteDomains/);
    assert.match(source, /query ListDirectoryDomains/);
    assert.match(source, /organisationDomains\(limit: 500\)/);
  });

  it('publishes the pharmacy trading name, never the owning company name', () => {
    // `organisation.name` is the registered company. It belongs on the admin
    // identity tab and nowhere a patient can see.
    assert.match(listedProfile, /name: profile\?\.tradingName \|\| organisation\.tradingName/);
    assert.doesNotMatch(listedProfile, /organisation\.name/);
  });
});
