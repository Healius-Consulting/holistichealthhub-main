import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../../domain/common/errors.js';
import { companiesHouseSecretResource, formatAddress, lookUpCompany, mapCompany, normaliseCompanyNumber, splitOfficerName } from './companies-house.js';

const profile = {
  company_number: '01234567',
  company_name: 'SHAH HEALTH LIMITED',
  company_status: 'active',
  type: 'ltd',
  date_of_creation: '2015-03-02',
  registered_office_address: { premises: '12', address_line_1: 'High Street', locality: 'Leicester', postal_code: 'LE1 1AA', country: 'England' },
};

const officers = [
  { name: 'SHAH, Priya Anjali', officer_role: 'director', nationality: 'British', country_of_residence: 'England' },
  { name: "O'BRIEN-SMITH, Sean", officer_role: 'director', nationality: 'Irish', country_of_residence: 'United Kingdom' },
  { name: 'FORMER, Director', officer_role: 'director', resigned_on: '2020-01-01' },
  { name: 'JONES, Sam', officer_role: 'secretary' },
];

function response(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('Companies House lookup', () => {
  it('keeps the key in the one London-pinned secret', () => {
    assert.match(companiesHouseSecretResource(), /\/secrets\/hhh-companies-house-key-europe-west2$/);
  });

  it('accepts company numbers the way people type them', () => {
    assert.equal(normaliseCompanyNumber('1234567'), '01234567');
    assert.equal(normaliseCompanyNumber(' 0123 4567 '), '01234567');
    assert.equal(normaliseCompanyNumber('sc123456'), 'SC123456');
    assert.equal(normaliseCompanyNumber('NI 1234'), 'NI001234');
    assert.equal(normaliseCompanyNumber('123456789'), null);
    assert.equal(normaliseCompanyNumber('GB123456789'), null);
    assert.equal(normaliseCompanyNumber(''), null);
  });

  it('reads officer names and addresses into form text', () => {
    assert.deepEqual(splitOfficerName('SHAH, Priya Anjali'), { firstNames: 'Priya Anjali', surname: 'Shah' });
    assert.deepEqual(splitOfficerName("O'BRIEN-SMITH, Sean"), { firstNames: 'Sean', surname: "O'Brien-Smith" });
    assert.equal(formatAddress(profile.registered_office_address), '12 High Street, Leicester, LE1 1AA');
    assert.equal(formatAddress(undefined), '');
  });

  it('maps the company and only its current directors', () => {
    const company = mapCompany(profile, officers);
    assert.equal(company.companyName, 'SHAH HEALTH LIMITED');
    assert.equal(company.active, true);
    assert.equal(company.businessType, 'Ltd Co');
    assert.equal(company.incorporatedOn, '2015-03-02');
    assert.deepEqual(company.directors.map(d => `${d.firstNames} ${d.surname}`), ['Priya Anjali Shah', "Sean O'Brien-Smith"]);
    assert.equal(mapCompany({ ...profile, type: 'llp' }, []).businessType, 'LLP');
    assert.equal(mapCompany({ ...profile, type: 'plc' }, []).businessType, 'PLC');
    assert.equal(mapCompany({ ...profile, type: 'private-unlimited' }, []).businessType, null);
    assert.equal(mapCompany({ ...profile, company_status: 'liquidation' }, []).active, false);
  });

  it('looks the company up with the key, and still fills the company in when directors fail', async () => {
    const paths: string[] = [];
    let auth = '';
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      paths.push(new URL(url).pathname);
      auth = new Headers(init?.headers).get('Authorization') ?? '';
      return url.includes('/officers') ? response(500, {}) : response(200, profile);
    }) as typeof fetch;
    const company = await lookUpCompany('1234567', { apiKey: async () => 'test-key', fetchImpl });
    assert.deepEqual(paths, ['/company/01234567', '/company/01234567/officers']);
    assert.equal(auth, `Basic ${Buffer.from('test-key:').toString('base64')}`);
    assert.equal(company.companyName, 'SHAH HEALTH LIMITED');
    assert.deepEqual(company.directors, []);
  });

  it('says plainly when the number is wrong, unknown, or Companies House is down', async () => {
    const fail = (status: number) => (async () => response(status, {})) as unknown as typeof fetch;
    const code = async (promise: Promise<unknown>) => {
      try { await promise; return 'none'; } catch (error) { return error instanceof HttpError ? `${error.statusCode} ${error.code}` : 'other'; }
    };
    assert.equal(await code(lookUpCompany('not a number', { apiKey: async () => 'k', fetchImpl: fail(200) })), '400 INVALID_COMPANY_NUMBER');
    assert.equal(await code(lookUpCompany('01234567', { apiKey: async () => 'k', fetchImpl: fail(404) })), '404 COMPANY_NOT_FOUND');
    assert.equal(await code(lookUpCompany('01234567', { apiKey: async () => 'k', fetchImpl: fail(429) })), '503 COMPANIES_HOUSE_UNAVAILABLE');
    assert.equal(await code(lookUpCompany('01234567', { apiKey: async () => null, fetchImpl: fail(200) })), '503 COMPANIES_HOUSE_UNAVAILABLE');
    const offline = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    assert.equal(await code(lookUpCompany('01234567', { apiKey: async () => 'k', fetchImpl: offline })), '503 COMPANIES_HOUSE_UNAVAILABLE');
  });
});
