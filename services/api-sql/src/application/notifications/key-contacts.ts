/**
 * Pharmacy key contacts, confirmed 4 Sep 2026.
 *
 * Keep in lockstep with `packages/domain/key-contacts.js`.
 * Firebase functions cannot import the workspace package at deploy time, so this
 * copy lives in api-sql. `tests/keyContacts.test.ts` fails if they drift.
 */

export type KeyContactKey = 'healius' | 'clinic' | 'curaleafLabs' | 'hhhService' | 'hhhPlatform';
export type KeyContactPill = 'info' | 'neutral' | 'ok';

export type KeyContactEmail = {
  label: string | null;
  address: string;
};

export type KeyContact = {
  key: KeyContactKey;
  org: string;
  role: string;
  pill: KeyContactPill;
  description: string | null;
  emails: readonly KeyContactEmail[];
  phone: string | null;
  hours: string | null;
};

export const KEY_CONTACTS: readonly KeyContact[] = Object.freeze([
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

export function keyContact(key: KeyContactKey): KeyContact {
  const found = KEY_CONTACTS.find(contact => contact.key === key);
  if (!found) throw new Error(`Unknown key contact: ${key}`);
  return found;
}

/** UK national numbers become +44 tel links. The visible text stays as published. */
export function telHref(phone: string) {
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return '';
  return `tel:+${digits.startsWith('0') ? `44${digits.slice(1)}` : digits}`;
}
