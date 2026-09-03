import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  EMAIL_EVENT_NAMES,
  EMAIL_TEMPLATE_CODES,
  EMAILS,
  formatEmailRoster,
  isEmailEventName,
  templatesForEvent,
} from './email-catalog.js';

const rosterPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../artifacts/email-roster.md');

describe('email catalog', () => {
  it('keeps twenty templates with render, audience, events, and schedule', () => {
    assert.equal(EMAIL_TEMPLATE_CODES.length, 20);
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
});
