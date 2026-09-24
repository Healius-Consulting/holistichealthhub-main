import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  EMAIL_EVENT_NAMES,
  EMAIL_TEMPLATE_CODES,
  EMAILS,
  closureVariantForReason,
  formatEmailRoster,
  isEmailEventName,
  replyToFor,
  templatesForEvent,
} from './email-catalog.js';

const rosterPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../artifacts/email-roster.md');

describe('email catalog', () => {
  it('keeps twenty-one templates with render, audience, events, and schedule', () => {
    assert.equal(EMAIL_TEMPLATE_CODES.length, 21);
    for (const code of EMAIL_TEMPLATE_CODES) {
      const entry = EMAILS[code];
      assert.equal(typeof entry.render, 'function');
      assert.ok(entry.events.length >= 1, `${code} has no events`);
      for (const event of entry.events) {
        assert.equal(isEmailEventName(event), true, `${code} lists unknown event ${event}`);
      }
      assert.ok(['patient', 'pharmacy_owner', 'staff', 'admin'].includes(entry.audience));
      assert.ok(['immediate', 'collection_hours', 'payment_reminder'].includes(entry.schedule));
      const rendered = entry.render({ firstName: 'Avery', pharmacyName: 'Eastwood Health' });
      assert.ok(rendered.subject);
      assert.ok(rendered.text);
      assert.ok(rendered.html);
    }
  });

  it('maps every event only to catalog codes', () => {
    for (const event of EMAIL_EVENT_NAMES) {
      const codes = templatesForEvent(event);
      assert.ok(codes.length >= 1, `${event} has no templates`);
      for (const code of codes) {
        assert.equal(EMAIL_TEMPLATE_CODES.includes(code), true);
        assert.equal((EMAILS[code].events as readonly string[]).includes(event), true);
      }
    }
  });

  it('keeps artifacts/email-roster.md generated from the catalog', () => {
    assert.equal(readFileSync(rosterPath, 'utf8'), formatEmailRoster());
  });

  it('gives a Reply-To only to the templates whose copy invites one', () => {
    for (const code of EMAIL_TEMPLATE_CODES) {
      const rendered = EMAILS[code].render({ firstName: 'Avery', pharmacyName: 'Eastwood Health' });
      const invitesReply = /reply to (?:this|it)|reply to this email/i.test(rendered.text);
      if (invitesReply) {
        assert.ok(replyToFor(code), `${code} invites a reply but sets no Reply-To`);
      }
    }
    assert.equal(replyToFor('patient_referred'), 'support@holistichealthhub.live');
    assert.equal(replyToFor('patient_payment_request'), null);
  });

  it('sorts decline reasons into the wording each one calls for', () => {
    assert.equal(closureVariantForReason('ELIGIBILITY_NOT_MET'), 'declined');
    assert.equal(closureVariantForReason('PSYCHIATRIC_EXCLUSION'), 'declined');
    assert.equal(closureVariantForReason('CLINICAL_UNSUITABILITY'), 'declined');
    assert.equal(closureVariantForReason('OTHER'), 'declined');
    assert.equal(closureVariantForReason('INCOMPLETE_INFORMATION'), 'incomplete');
    assert.equal(closureVariantForReason('NO_RESPONSE'), 'incomplete');
  });

  it('cites the confirmed clinic, supplier and platform contacts', () => {
    const refund = EMAILS.patient_refunded.render({ firstName: 'Avery', orderNumber: 'HHH-1' });
    assert.match(refund.text, /patientsupport@curaleafclinic.com/);
    assert.match(refund.text, /020 7459 4075/);
    assert.match(refund.text, /Mon–Fri 08:00–17:00/);

    const cancellation = EMAILS.pharmacy_order_cancelled.render({
      orderNumber: 'HHH-9',
      purchaseOrderId: 'PO-44',
    });
    assert.match(cancellation.text, /0191 743 1007/);
    assert.match(cancellation.text, /purchase order PO-44/);
    assert.match(cancellation.text, /before speaking to the patient/);
    assert.match(cancellation.text, /patientsupport@curaleafclinic.com/);
    assert.match(cancellation.html, /tel:\+441917431007/);
    assert.match(cancellation.html, /mailto:patientsupport@curaleafclinic.com/);

    for (const code of ['pharmacy_staff_invite', 'pharmacy_password_reset', 'pharmacy_2fa_enabled', 'pharmacy_2fa_disabled'] as const) {
      assert.equal(replyToFor(code), 'IT@holistichealthhub.live');
      assert.match(EMAILS[code].render({ pharmacyName: 'Eastwood Health' }).text, /IT@holistichealthhub.live/);
    }
  });
});
