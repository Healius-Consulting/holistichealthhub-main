import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isAssignedPendingEnquiry } from './pending-enquiry-visibility.js';

const eastwood = '6d0176bb-89a0-4e32-9bce-c934c9557c42';
const primary = '70913a30-71c3-4a41-952e-d532927af58c';

describe('assigned pending enquiry visibility', () => {
  it('lists only the current assigned pharmacy, not the QR or website source', () => {
    const reassigned = {
      pharmacyAccessStatus: 'WITHHELD',
      outcomeStatus: 'OPEN',
      assignedOrganisationId: eastwood,
      sourceOrganisationId: primary,
    };
    assert.equal(isAssignedPendingEnquiry(reassigned, eastwood), true);
    assert.equal(isAssignedPendingEnquiry(reassigned, primary), false);
  });

  it('treats a website-selected pharmacy as assigned immediately', () => {
    assert.equal(isAssignedPendingEnquiry({
      pharmacyAccessStatus: 'WITHHELD',
      outcomeStatus: 'OPEN',
      assignedOrganisationId: eastwood,
      sourceOrganisationId: eastwood,
    }, eastwood), true);
  });

  it('does not list HHH Allocation cases with no assigned pharmacy', () => {
    assert.equal(isAssignedPendingEnquiry({
      pharmacyAccessStatus: 'WITHHELD',
      outcomeStatus: 'OPEN',
      assignedOrganisationId: null,
      sourceOrganisationId: eastwood,
    }, eastwood), false);
  });
});
