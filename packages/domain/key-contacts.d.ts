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

export const KEY_CONTACTS: readonly KeyContact[];
export function keyContact(key: KeyContactKey): KeyContact;
export function telHref(phone: string): string;
