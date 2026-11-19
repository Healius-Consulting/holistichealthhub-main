import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../../domain/common/errors.js';
import { companiesHouseSecretResource, formatAddress, lookUpCompany, mapCompany, normaliseCompanyNumber, ownershipBand, splitOfficerName } from './companies-house.js';

const profile = {
  company_number: '01234567',
  company_name: 'SHAH HEALTH LIMITED',
  company_status: 'active',
  type: 'ltd',
  date_of_creation: '2015-03-02',
  registered_office_address: { premises: '12', address_line_1: 'High Street', locality: 'Leicester', postal_code: 'LE1 1AA', country: 'England' },
};

const officers = [
  { name: 'SHAH, Priya Anjali', officer_role: 'director', nationality: 'British', country_of_residence: 'England', date_of_birth: { month: 4, year: 1980 } },
  { name: "O'BRIEN-SMITH, Sean", officer_role: 'nominee-director', nationality: 'Irish', country_of_residence: 'United Kingdom', date_of_birth: { month: 1, year: 1975 } },
  { name: 'FORMER, Director', officer_role: 'director', resigned_on: '2020-01-01' },
  { name: 'JONES, Sam', officer_role: 'secretary' },
  { name: 'ACME NOMINEES LIMITED', officer_role: 'corporate-director' },
];

const pscs = [
  // Priya again, as an owner: merges into her director card.
  { kind: 'individual-person-with-significant-control', name: 'Mrs Priya Anjali Shah', name_elements: { title: 'Mrs', forename: 'Priya', middle_name: 'Anjali', surname: 'Shah' }, date_of_birth: { month: 4, year: 1980 }, nationality: 'British', country_of_residence: 'England', natures_of_control: ['ownership-of-shares-50-to-75-percent', 'voting-rights-50-to-75-percent'] },
  // An owner who is not a director.
  { kind: 'individual-person-with-significant-control', name: 'Rev Amit Patel', name_elements: { title: 'Rev', forename: 'Amit', surname: 'PATEL' }, date_of_birth: { month: 9, year: 1979 }, nationality: 'British', country_of_residence: 'England', natures_of_control: ['ownership-of-shares-25-to-50-percent-as-trust'] },
  { kind: 'individual-person-with-significant-control', name: 'Mr Old Owner', name_elements: { forename: 'Old', surname: 'Owner' }, ceased_on: '2021-01-01', natures_of_control: ['ownership-of-shares-75-to-100-percent'] },
  { kind: 'corporate-entity-person-with-significant-control', name: 'Shah Holdings Ltd', natures_of_control: ['ownership-of-shares-25-to-50-percent'] },
  { kind: 'super-secure-person-with-significant-control', description: 'super-secure-persons-with-significant-control' },
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
    assert.equal(formatAddress({ care_of: 'Smith & Co', po_box: '12', locality: 'Leicester', postal_code: 'LE1 9ZZ' }), 'c/o Smith & Co, PO Box 12, Leicester, LE1 9ZZ');
    assert.deepEqual(splitOfficerName('Acme Nominees Limited'), { firstNames: '', surname: 'Acme Nominees Limited' });
    assert.equal(formatAddress(undefined), '');
  });

  it('maps the company and only its current directors', () => {
    const company = mapCompany(profile, officers, []);
    assert.equal(company.companyName, 'SHAH HEALTH LIMITED');
    assert.equal(company.active, true);
    assert.equal(company.companyType, 'ltd');
    assert.equal(company.businessType, 'Ltd Co');
    assert.equal(company.incorporatedOn, '2015-03-02');
    assert.deepEqual(company.directors.map(d => `${d.firstNames} ${d.surname}`), ['Priya Anjali Shah', "Sean O'Brien-Smith"]);
    assert.deepEqual(company.notListed, ['ACME NOMINEES LIMITED (a company acting as an officer)']);
    assert.equal(company.noSignificantOwners, true);
    assert.equal(mapCompany({ ...profile, type: 'llp' }, [], []).businessType, 'LLP');
    assert.equal(mapCompany({ ...profile, type: 'plc' }, [], []).businessType, 'PLC');
    assert.equal(mapCompany({ ...profile, type: 'private-unlimited' }, [], []).businessType, 'Ltd Co');
    assert.equal(mapCompany({ ...profile, type: 'private-limited-guarant-nsc' }, [], []).businessType, null);
    assert.equal(mapCompany({ ...profile, company_status: 'liquidation' }, [], []).active, false);
    // An owners list that could not be read is unknown, not empty.
    assert.equal(mapCompany(profile, officers, null).noSignificantOwners, false);
  });

  it('reads ownership bands, including the trust and firm forms', () => {
    assert.equal(ownershipBand(['voting-rights-25-to-50-percent', 'ownership-of-shares-25-to-50-percent']), '25-50');
    assert.equal(ownershipBand(['ownership-of-shares-50-to-75-percent-as-firm']), '50-75');
    assert.equal(ownershipBand(['ownership-of-shares-75-to-100-percent-as-trust']), '75-100');
    assert.equal(ownershipBand(['significant-influence-or-control']), null);
    assert.equal(ownershipBand(undefined), null);
  });

  it('lists each person once, with birth month and year, roles, title and band', () => {
    const company = mapCompany(profile, officers, pscs);
    assert.deepEqual(company.people.map(p => ({ name: `${p.firstNames} ${p.surname}`, roles: p.roles, title: p.title, titleOther: p.titleOther, born: `${p.birthMonth}/${p.birthYear}`, band: p.ownershipBand })), [
      { name: 'Priya Anjali Shah', roles: ['director', 'shareholder'], title: 'Mrs', titleOther: '', born: '4/1980', band: '50-75' },
      { name: "Sean O'Brien-Smith", roles: ['director'], title: null, titleOther: '', born: '1/1975', band: null },
      { name: 'Amit Patel', roles: ['shareholder'], title: 'Other', titleOther: 'Rev', born: '9/1979', band: '25-50' },
    ]);
    assert.deepEqual(company.notListed, ['ACME NOMINEES LIMITED (a company acting as an officer)', 'Shah Holdings Ltd (a company or other body)', 'A person with significant control (details protected)']);
    assert.equal(company.noSignificantOwners, false);
  });

  it('looks the company up with the key, and still fills the company in when directors fail', async () => {
    const paths: string[] = [];
    let auth = '';
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      paths.push(new URL(url).pathname);
      auth = new Headers(init?.headers).get('Authorization') ?? '';
      if (url.includes('/officers')) return response(500, {});
      if (url.includes('/persons-with-significant-control')) return response(404, {});
      return response(200, profile);
    }) as typeof fetch;
    const company = await lookUpCompany('1234567', { apiKey: async () => 'test-key', fetchImpl });
    assert.deepEqual(paths, ['/company/01234567', '/company/01234567/officers', '/company/01234567/persons-with-significant-control']);
    // 404 on the owners list means none registered; a failed officers list means none known.
    assert.equal(company.noSignificantOwners, true);
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
