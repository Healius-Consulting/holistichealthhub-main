import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clickupCardFields, clickupStageFor, postcodeFromAddress, type ClickupEvent } from './clickup-events.js';

const fresh = { exists: false, stage: null, pharCodeEntered: false, apiKeyEntered: false };
const existing = { exists: true, stage: 'awaiting_curaleaf' as const, pharCodeEntered: false, apiKeyEntered: false };

describe('ClickUp event to card status', () => {
  it('maps each onboarding event to its column', () => {
    const expected: Array<[ClickupEvent, string | null]> = [
      ['interest', 'interest'],
      ['submitted', 'awaiting_activation'],
      ['held', 'on_hold'],
      ['unheld', 'awaiting_activation'],
      ['activated', 'awaiting_curaleaf'],
      ['live', 'live'],
      ['not_available', 'existing_curaleaf_hold'],
    ];
    for (const [event, stage] of expected) assert.equal(clickupStageFor(event, fresh), stage, event);
  });

  it('never moves an existing card back to Interest', () => {
    assert.equal(clickupStageFor('interest', { ...existing, stage: 'awaiting_activation' }), null);
  });

  it('moves to Setup only once both the PHAR code and API key are in, and never off Live', () => {
    assert.equal(clickupStageFor('phar_code_entered', { ...existing, pharCodeEntered: true }), null);
    assert.equal(clickupStageFor('api_key_entered', { ...existing, pharCodeEntered: true, apiKeyEntered: true }), 'setup');
    assert.equal(clickupStageFor('api_key_entered', { ...existing, stage: 'live', pharCodeEntered: true, apiKeyEntered: true }), null);
  });

  it('leaves the column alone for a checklist tick or Terms acceptance', () => {
    assert.equal(clickupStageFor('checklist_progress', existing), null);
    assert.equal(clickupStageFor('terms_accepted', existing), null);
  });
});

describe('ClickUp card fields', () => {
  it('keeps only references and business fields, never personal or patient data', () => {
    const fields = clickupCardFields({
      gphcNumber: '1234567',
      tradingName: 'Shah Pharmacy',
      legalEntity: 'Shah Health Ltd',
      postcode: 'LS1 1AA',
      pharmacyEmail: 'shop@shah.test',
      pharmacistName: 'Asha Shah',
      pharmacyPhone: '0113 000 0000',
      patientName: 'Jane Patient',
      dob: '1990-01-01',
      email: 'jane@example.test',
    } as Record<string, unknown> & { gphcNumber: string });
    assert.deepEqual(fields, {
      gphcNumber: '1234567',
      tradingName: 'Shah Pharmacy',
      legalEntity: 'Shah Health Ltd',
      postcode: 'LS1 1AA',
    });
  });

  it('clamps the checklist percentage', () => {
    assert.equal(clickupCardFields({ gphcNumber: '1', checklistPercent: 140 }).checklistPercent, 100);
    assert.equal(clickupCardFields({ gphcNumber: '1', checklistPercent: 33.4 }).checklistPercent, 33);
  });

  it('finds the postcode in a free-text address', () => {
    assert.equal(postcodeFromAddress('1 High Street, Leeds, ls11aa'), 'LS1 1AA');
    assert.equal(postcodeFromAddress('Unit 4, SW1A 2AA, London'), 'SW1A 2AA');
    assert.equal(postcodeFromAddress('No postcode here'), null);
  });
});
