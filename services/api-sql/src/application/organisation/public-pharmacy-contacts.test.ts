import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attachPublicPharmacyContacts } from './public-pharmacy-contacts.js';
import type { PublicPharmacy } from '../../repositories/ports/organisation.port.js';

const pharmacy: PublicPharmacy = {
  id: 'a76cefdf-f323-4d0c-b2ba-6fd08d7ea9ee',
  name: 'Example Pharmacy',
  tradingName: 'Example Pharmacy Ltd',
  logoText: 'EP',
  gphcNumber: '1234567',
  superintendent: 'A Pharmacist',
  address: '1 High Street, Town, AB1 2CD',
  primaryColour: '#173f33',
};

function repo(profile: Record<string, unknown> | null) {
  return { findProfileByOrganisationId: async () => profile as never };
}

describe('attachPublicPharmacyContacts', () => {
  it("adds the pharmacy's public phone from its directory profile", async () => {
    const result = await attachPublicPharmacyContacts(repo({ publicPhone: ' 01283 000000 ' }), pharmacy);
    assert.equal(result.publicPhone, '01283 000000');
  });

  it('leaves the phone out when the profile has none', async () => {
    const result = await attachPublicPharmacyContacts(repo({ publicPhone: '  ' }), pharmacy);
    assert.equal(result.publicPhone, null);
  });

  it('still resolves the pharmacy when it has no profile or the lookup fails', async () => {
    assert.deepEqual(await attachPublicPharmacyContacts(repo(null), pharmacy), pharmacy);
    const failing = { findProfileByOrganisationId: async () => { throw new Error('down'); } };
    assert.deepEqual(await attachPublicPharmacyContacts(failing, pharmacy), pharmacy);
  });
});
