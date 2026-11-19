import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderEmailTemplate } from './email-catalog.js';
import {
  EDITABLE_EMAIL_CODES,
  EMAIL_COPY_SPECS,
  editableSlots,
  emailCopyFrom,
  parseEmailCopy,
  type EmailCopySpec,
} from '../../domain/notifications/email-copy.js';

/** The words a reader sees, without markup or spacing differences. */
function visible(html: string) {
  return html
    .replace(/<div style="display:none[\s\S]*?<\/div>/, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, '’')
    .replace(/&quot;/g, '"')
    .replace(/[,\s]+/g, ' ')
    .replace(/ ([.:;)])/g, '$1')
    .replace(/\( /g, '(')
    .trim();
}

describe('admin-edited email wording', () => {
  it('leaves every email exactly as it was while nothing is saved', () => {
    for (const code of EDITABLE_EMAIL_CODES) {
      if (code === 'admin_curaleaf_prescriber_stuck') continue;
      const sample = (EMAIL_COPY_SPECS[code] as EmailCopySpec).sample;
      assert.deepEqual(renderEmailTemplate(code, sample, {}), renderEmailTemplate(code, sample), code);
    }
  });

  it('starts the editor from today’s wording: saving the defaults unchanged sends the same email', () => {
    const differ: string[] = [];
    for (const code of EDITABLE_EMAIL_CODES) {
      if (code === 'admin_curaleaf_prescriber_stuck') continue;
      const spec = EMAIL_COPY_SPECS[code] as EmailCopySpec;
      const before = renderEmailTemplate(code, spec.sample);
      const after = renderEmailTemplate(code, spec.sample, { [code]: spec.defaults });
      if (after.subject !== before.subject) differ.push(`${code} subject: ${after.subject} | ${before.subject}`);
      if (visible(after.html) !== visible(before.html)) differ.push(`${code} body:\n  ${visible(after.html)}\n  ${visible(before.html)}`);
    }
    assert.deepEqual(differ, []);
  });

  it('swaps in only the pieces that were saved, merged for the recipient', () => {
    const payload = { ...EMAIL_COPY_SPECS.patient_payment_request.sample, firstName: 'Ana' };
    const email = renderEmailTemplate('patient_payment_request', payload, {
      patient_payment_request: { subject: 'Your order [Order number] needs paying', body: 'Hello [First name],\n\n**Pay today** <please>' },
    });
    assert.equal(email.subject, 'Your order ORD-MWDPQ7RK-6EDC74 needs paying');
    assert.match(email.html, /Hello Ana,/);
    assert.match(email.html, /<strong>Pay today<\/strong> &lt;please&gt;/, 'bold kept, HTML escaped');
    assert.match(email.html, /Payment needed/, 'the heading was not edited, so it is the code’s');
    assert.match(email.html, /Order breakdown/, 'order details stay automatic');
    assert.match(email.text, /Hello Ana,/);
  });

  it('keeps the pharmacy name before a patient subject and its signature after the edited message', () => {
    const sample = EMAIL_COPY_SPECS.patient_enquiry_declined.sample;
    const email = renderEmailTemplate('patient_enquiry_declined', sample, {
      patient_enquiry_declined: { subject: 'About your enquiry', body: 'Dear [First name],\n\n[If declined]Sorry.[/If][If withdrawn]Closed as asked.[/If]' },
    });
    assert.equal(email.subject, 'Kirkgate Pharmacy: About your enquiry');
    assert.match(email.html, /Sorry\./);
    assert.doesNotMatch(email.html, /Closed as asked/);
    assert.match(email.html, /Best wishes,<br>Kirkgate Pharmacy/);
  });

  it('reads titled steps as a title line, then text', () => {
    const email = renderEmailTemplate('patient_referred', EMAIL_COPY_SPECS.patient_referred.sample, {
      patient_referred: { steps: 'Watch your inbox\nThe clinic emails you.\n\nBook\nPick a time.' },
    });
    assert.match(email.html, />Watch your inbox<\/p><p[^>]*>The clinic emails you\.<\/p>/);
    assert.match(email.html, />Book<\/p>/);
  });

  it('refuses pieces an email does not have, and drops blank ones so the email goes back to its own wording', () => {
    assert.throws(() => parseEmailCopy('pharmacy_order_accepted', { button: 'Go' }));
    assert.deepEqual(parseEmailCopy('pharmacy_order_accepted', { subject: '  ', title: 'Accepted' }), { title: 'Accepted' });
    assert.deepEqual(editableSlots('pharmacy_order_accepted'), ['subject', 'preheader', 'title', 'body']);
  });

  it('ignores stored wording for unknown emails or bad entries rather than failing a send', () => {
    assert.deepEqual(emailCopyFrom({ nope: { subject: 'x' }, pharmacy_order_accepted: { button: 'x' }, pharmacy_order_dispatched: { title: 'Sent' } }), {
      pharmacy_order_dispatched: { title: 'Sent' },
    });
    assert.deepEqual(emailCopyFrom(null), {});
  });
});
