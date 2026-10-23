import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pendingEnquiryDisplayStatus, portalSourceType } from './intake-source.js';

describe('intake-source helpers', () => {
  it('maps SQL source types to portal slugs', () => {
    assert.equal(portalSourceType('PHARMACY_QR'), 'future_pharmacy_qr');
    assert.equal(portalSourceType('GENERAL_HHH_WEBSITE'), 'general_hhh_website');
    assert.equal(portalSourceType('UNKNOWN'), null);
  });

  it('derives pending enquiry labels from follow-up status', () => {
    assert.equal(pendingEnquiryDisplayStatus('NOT_STARTED'), 'New enquiry');
    assert.equal(pendingEnquiryDisplayStatus('IN_PROGRESS'), 'In progress');
    assert.equal(pendingEnquiryDisplayStatus('COMPLETED'), 'In progress');
    assert.equal(pendingEnquiryDisplayStatus(null), 'New enquiry');
  });
});
