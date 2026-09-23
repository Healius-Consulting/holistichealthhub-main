import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { KEY_CONTACTS, keyContact, telHref } from '../packages/domain/key-contacts.js';

const CONFIRMED = [
  ['healius', 'Healius Consulting', 'Partner success', 'spatel@healiusconsulting.com', '07840 407917'],
  ['clinic', 'Curaleaf Clinic', 'Clinic', 'patientsupport@curaleafclinic.com', '020 7459 4075'],
  ['curaleafLabs', 'Curaleaf Labs', 'Supplier', 'orders@curaleaflaboratories.co.uk', '0191 743 1007'],
  ['hhhPlatform', 'Holistic Health Hub', 'Platform support', 'IT@holistichealthhub.live', null],
];

test('key contacts match the 4 Sep 2026 brief, in phone-first order', () => {
  assert.deepEqual(KEY_CONTACTS.map(contact => contact.key), ['healius', 'clinic', 'curaleafLabs', 'hhhService', 'hhhPlatform']);
  for (const [key, org, role, address, phone] of CONFIRMED) {
    const contact = keyContact(key);
    assert.equal(contact.org, org);
    assert.equal(contact.role, role);
    assert.equal(contact.emails[0].address, address);
    assert.equal(contact.phone, phone);
  }
  const service = keyContact('hhhService');
  assert.equal(service.phone, null);
  assert.deepEqual(service.emails.map(email => email.address), [
    'referrals@holistichealthhub.live',
    'orders@holistichealthhub.live',
    'payments@holistichealthhub.live',
  ]);
  assert.deepEqual(service.emails.map(email => email.label), [
    'Referrals',
    'Orders, fulfilment and collection',
    'Payments and refunds',
  ]);
  assert.equal(keyContact('clinic').hours, 'Mon–Fri 08:00–17:00');
  assert.equal(keyContact('curaleafLabs').hours, 'Mon–Fri 08:00–17:00');
  assert.equal(telHref('020 7459 4075'), 'tel:+442074594075');
  assert.equal(telHref('07840 407917'), 'tel:+447840407917');
});

test('api-sql keeps the same key contact details', () => {
  const source = readFileSync(new URL('../services/api-sql/src/application/notifications/key-contacts.ts', import.meta.url), 'utf8');
  for (const contact of KEY_CONTACTS) {
    assert.match(source, new RegExp(contact.org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(source, new RegExp(contact.role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    for (const email of contact.emails) {
      assert.match(source, new RegExp(email.address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      if (email.label) assert.match(source, new RegExp(email.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    if (contact.phone) assert.match(source, new RegExp(contact.phone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    if (contact.hours) assert.match(source, new RegExp(contact.hours.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    if (contact.description) assert.match(source, new RegExp(contact.description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});
