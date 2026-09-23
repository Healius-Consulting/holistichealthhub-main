/**
 * Pharmacy key contacts, confirmed 4 Sep 2026.
 *
 * The portal card renders this list. Email copy in api-sql keeps a lockstep
 * copy because Cloud Functions cannot import this workspace package.
 * tests/keyContacts.test.ts fails if the two drift.
 */

export const KEY_CONTACTS = Object.freeze([
  {
    key: 'healius',
    org: 'Healius Consulting',
    role: 'Partner success',
    pill: 'info',
    description: 'Onboarding, training and helping you grow the service.',
    emails: Object.freeze([
      Object.freeze({ label: null, address: 'spatel@healiusconsulting.com' }),
    ]),
    phone: '07840 407917',
    hours: null,
  },
  {
    key: 'clinic',
    org: 'Curaleaf Clinic',
    role: 'Clinic',
    pill: 'neutral',
    description: 'Clinical queries, prescriptions and re-prescribing. Mon–Fri 08:00–17:00.',
    emails: Object.freeze([
      Object.freeze({ label: null, address: 'patientsupport@curaleafclinic.com' }),
    ]),
    phone: '020 7459 4075',
    hours: 'Mon–Fri 08:00–17:00',
  },
  {
    key: 'curaleafLabs',
    org: 'Curaleaf Labs',
    role: 'Supplier',
    pill: 'neutral',
    description: 'Stock orders, supply queries and order cancellations — quote the PO reference. Mon–Fri 08:00–17:00.',
    emails: Object.freeze([
      Object.freeze({ label: null, address: 'orders@curaleaflaboratories.co.uk' }),
    ]),
    phone: '0191 743 1007',
    hours: 'Mon–Fri 08:00–17:00',
  },
  {
    key: 'hhhService',
    org: 'Holistic Health Hub',
    role: 'Service support',
    pill: 'ok',
    description: null,
    emails: Object.freeze([
      Object.freeze({ label: 'Referrals', address: 'referrals@holistichealthhub.live' }),
      Object.freeze({ label: 'Orders, fulfilment and collection', address: 'orders@holistichealthhub.live' }),
      Object.freeze({ label: 'Payments and refunds', address: 'payments@holistichealthhub.live' }),
    ]),
    phone: null,
    hours: null,
  },
  {
    key: 'hhhPlatform',
    org: 'Holistic Health Hub',
    role: 'Platform support',
    pill: 'info',
    description: 'Logins, authenticator app and technical issues.',
    emails: Object.freeze([
      Object.freeze({ label: null, address: 'IT@holistichealthhub.live' }),
    ]),
    phone: null,
    hours: null,
  },
]);

export function keyContact(key) {
  const found = KEY_CONTACTS.find(contact => contact.key === key);
  if (!found) throw new Error(`Unknown key contact: ${key}`);
  return found;
}

/** UK national numbers become +44 tel links. The visible text stays as published. */
export function telHref(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return '';
  return `tel:+${digits.startsWith('0') ? `44${digits.slice(1)}` : digits}`;
}
