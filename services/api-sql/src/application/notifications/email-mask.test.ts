import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { enquiryDisplayFields } from './email-mask.js';

describe('enquiry email fields', () => {
  it('shows the full name, phone and email', () => {
    const display = enquiryDisplayFields({
      firstName: 'Avery',
      surname: 'Patel',
      mobile: '07700900000',
      email: 'avery@example.com',
    });
    assert.equal(display.name, 'Avery Patel');
    assert.equal(display.phone, '07700900000');
    assert.equal(display.email, 'avery@example.com');
  });

  it('still reads older outbox rows that only stored masked fields', () => {
    const display = enquiryDisplayFields({
      maskedName: 'A**** P****',
      maskedPhone: '07*********',
      maskedEmail: 'a****@e******.com',
    });
    assert.equal(display.name, 'A**** P****');
    assert.equal(display.phone, '07*********');
    assert.equal(display.email, 'a****@e******.com');
  });
});
