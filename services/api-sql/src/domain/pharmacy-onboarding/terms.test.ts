import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { issuePharmsmartNamesTicket, readPharmsmartNamesTicket, signerMatchesPharmsmart } from './terms.js';

describe('signerMatchesPharmsmart', () => {
  const people = [{ firstName: 'Asha', lastName: 'Shah' }, { firstName: 'Ravi', lastName: 'Patel-Jones' }];

  it('matches either person, ignoring case, spacing, accents and middle names', () => {
    assert.equal(signerMatchesPharmsmart('asha shah', people), true);
    assert.equal(signerMatchesPharmsmart('Ravi Kumar Patel Jones', people), true);
    assert.equal(signerMatchesPharmsmart('Áshá  SHAH', people), true);
  });

  it('does not match a different person or a first name alone', () => {
    assert.equal(signerMatchesPharmsmart('Asha Patel', people), false);
    assert.equal(signerMatchesPharmsmart('Ravi', people), false);
  });

  it('is null when PharmSmart gave no full names', () => {
    assert.equal(signerMatchesPharmsmart('Asha Shah', []), null);
    assert.equal(signerMatchesPharmsmart('Asha Shah', [{ firstName: 'Asha', lastName: null }]), null);
  });
});

describe('PharmSmart names ticket', () => {
  it('reads back only with the same secret and before it expires', () => {
    const now = Date.parse('2026-11-19T10:00:00Z');
    const ticket = issuePharmsmartNamesTicket({ gphcNumber: '1234567', people: [{ firstName: 'Asha', lastName: 'Shah' }] }, 'secret', now);
    assert.equal(readPharmsmartNamesTicket(ticket, 'secret', now)?.gphcNumber, '1234567');
    assert.equal(readPharmsmartNamesTicket(ticket, 'other', now), null);
    assert.equal(readPharmsmartNamesTicket(ticket, 'secret', now + 25 * 60 * 60 * 1000), null);
    assert.equal(readPharmsmartNamesTicket(`${ticket}x`, 'secret', now), null);
  });
});
