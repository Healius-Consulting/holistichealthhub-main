import { z } from 'zod';

/**
 * Worldpay application content that HHH admin can change without a release (spec §2,
 * decided 18 Nov 2026: emails, recipients, pricing panel, card scheme answers and
 * the S-04 note; labels and help text stay in code).
 *
 * Stored in PlatformContent under these keys. A key with no stored row uses the
 * default here, which is Shay's wording from the spec.
 */

export const WORLDPAY_CONTENT_KEYS = {
  recipients: 'worldpay.recipients',
  wp01: 'worldpay.wp01',
  wp02: 'worldpay.wp02',
  pricingPanel: 'worldpay.pricingPanel',
  schemeAnswers: 'worldpay.schemeAnswers',
  s04Note: 'worldpay.s04Note',
} as const;
export type WorldpayContentKey = keyof typeof WORLDPAY_CONTENT_KEYS;

const email = z.string().trim().toLowerCase().email().max(254);
const recipientsSchema = z.object({
  to: z.array(email).min(1, 'Add at least one To address.').max(10),
  cc: z.array(email).max(10).default([]),
});
const emailTemplateSchema = z.object({
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(10_000),
});
const pricingPanelSchema = z.object({
  label: z.string().trim().max(80),
  price: z.string().trim().max(120),
  priceNote: z.string().trim().max(300),
  ticks: z.array(z.string().trim().min(1).max(120)).max(6),
  pciLine: z.string().trim().max(200),
  pciNote: z.string().trim().max(500),
  footnote: z.string().trim().max(500),
});
const schemeAnswersSchema = z.object({
  s01: z.string().trim().min(1).max(2000),
  s02: z.string().trim().min(1).max(2000),
  s03: z.string().trim().min(1).max(2000),
  s04: z.string().trim().min(1).max(2000),
  s05: z.string().trim().min(1).max(4000),
});
export const WORLDPAY_CONTENT_SCHEMAS = {
  recipients: recipientsSchema,
  wp01: emailTemplateSchema,
  wp02: emailTemplateSchema,
  pricingPanel: pricingPanelSchema,
  schemeAnswers: schemeAnswersSchema,
  s04Note: z.string().trim().min(1).max(1000),
} as const;

export type WorldpayContent = {
  recipients: z.infer<typeof recipientsSchema>;
  wp01: z.infer<typeof emailTemplateSchema>;
  wp02: z.infer<typeof emailTemplateSchema>;
  pricingPanel: z.infer<typeof pricingPanelSchema>;
  schemeAnswers: z.infer<typeof schemeAnswersSchema>;
  s04Note: string;
};

export const WORLDPAY_CONTENT_DEFAULTS: WorldpayContent = {
  recipients: { to: ['worldpay@holistichealthhub.live'], cc: [] },
  wp01: {
    subject: 'Worldpay application — [legal name] t/a [trading name] — [HHH reference]',
    body: [
      'Hello,',
      'Please find attached a card processing application for [legal name], trading as [trading name], a GPhC-registered pharmacy and Holistic Health Hub partner.',
      '- Product: ecommerce with payment links (API credentials required for the Holistic Health Hub platform)\n- GPhC premises number: [GPhC number]\n- Contact at the pharmacy: [contact name], [position], [phone], [contact email]',
      '[If own website]Website: [URL][/If]',
      '[If no website]This pharmacy does not have a website of its own. It takes card payments only by Worldpay payment link issued from the Holistic Health Hub platform, so the website given is https://www.holistichealthhub.live/.[/If]',
      'Please send any questions on the application to the contact above, copying this address.',
      'Holistic Health Hub\nworldpay@holistichealthhub.live',
    ].join('\n\n'),
  },
  wp02: {
    subject: 'Your Worldpay application has been sent — [HHH reference]',
    body: [
      'Hello [submitter first name],',
      'We have received your Worldpay application for [legal name] and passed it to Worldpay.',
      'What happens next:',
      '1. Worldpay may contact [contact name] with questions and will ask for photo ID and proof of address for each director and owner.\n2. Worldpay send you their agreement to sign. The contract is between your pharmacy and Worldpay.\n3. When the account is open, Worldpay send you login details for your Worldpay dashboard. Log in, find your API keys there, and paste them into Settings → Payments on Holistic Health Hub to complete the set-up.',
      'Until then you can keep taking payment in the pharmacy and recording it on the platform as you do now.',
      'If Worldpay ask you something you are unsure about, reply to this email.',
      'Holistic Health Hub',
    ].join('\n\n'),
  },
  pricingPanel: {
    label: 'Pay as you go',
    price: '1.3% + 20p per transaction*',
    priceNote: 'On consumer cards, including Apple Pay and Google Pay.',
    ticks: ['No minimum charge', 'No setup fee'],
    pciLine: '£5 per month for PCI DSS compliance',
    pciNote: "PCI DSS is the card industry's data security standard, which every business taking card payments must meet. This is Worldpay's monthly charge for it.",
    footnote: '*All quotes are subject to contract. Fees are set and charged by Worldpay, not by Holistic Health Hub.',
  },
  schemeAnswers: {
    s01: 'Yes. Sales are limited to the UK. Medicines are supplied only to patients living in the UK.',
    s02: 'Confirmed.',
    s03: '(a) Confirmed. The pharmacy is registered with the GPhC (premises number [B-09]) and operates only in Great Britain. (b) Confirmed. Medicines are supplied only against a valid prescription, to patients in the UK, by collection or tracked delivery. (c) Confirmed. No medicines are exported.',
    s04: 'Confirmed. The pharmacy requests the Visa fee waiver on the basis of its GPhC registration (premises number [B-09]). Mastercard will not be used on this account. Please switch Mastercard acceptance off, so that no Mastercard registration fee applies.',
    s05: "No online consultations are provided by the pharmacy. Consultations and prescribing are provided by Curaleaf Clinic (curaleafclinic.com), an independent CQC-registered clinic, which charges patients its own fees directly. Prescribing decisions are made solely by the clinic's specialists. The pharmacy has no ownership, shared management or shared branding with Curaleaf Clinic. Its contractual links are: (1) the pharmacy buys the prescribed medicines wholesale from Curaleaf Laboratories, a licensed supplier in the same group as the clinic; (2) the pharmacy uses the Holistic Health Hub platform, through which patients who ask to be referred are passed to the clinic. The pharmacy receives no payment from the clinic for referrals or prescriptions.",
  },
  s04Note: "Visa's $950 annual fee is waived because your pharmacy is GPhC registered. Mastercard's $1,000 annual fee is not waived, so this application asks Worldpay to switch Mastercard off and not charge it. Patients will pay by Visa. These fees are set by the card schemes, not by Holistic Health Hub.",
};

/** Reads stored content, falling back to the default for any key that is missing or no longer valid. */
export function worldpayContentFrom(stored: Record<string, unknown>): WorldpayContent {
  const out = { ...WORLDPAY_CONTENT_DEFAULTS } as Record<WorldpayContentKey, unknown>;
  for (const name of Object.keys(WORLDPAY_CONTENT_KEYS) as WorldpayContentKey[]) {
    const raw = stored[WORLDPAY_CONTENT_KEYS[name]];
    if (raw === undefined) continue;
    const parsed = WORLDPAY_CONTENT_SCHEMAS[name].safeParse(raw);
    if (parsed.success) out[name] = parsed.data;
  }
  return out as WorldpayContent;
}

/**
 * Fills an admin-written template. `[field name]` is replaced from `fields` (unknown
 * names stay as typed, so a typo shows rather than vanishing); `[If flag]…[/If]` keeps
 * its text only when the flag is true. Returns paragraphs split on blank lines.
 */
export function mergeTemplate(template: string, fields: Record<string, string>, flags: Record<string, boolean>): string[] {
  const conditioned = template.replace(/\[If ([^\]]+)\]([\s\S]*?)\[\/If\]/gi, (_, flag: string, inner: string) => (flags[flag.trim().toLowerCase()] ? inner : ''));
  const lookup = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key.toLowerCase(), value]));
  const merged = conditioned.replace(/\[([^\]\n]{1,60})\]/g, (whole, name: string) => {
    const value = lookup[name.trim().toLowerCase()];
    return value === undefined ? whole : value;
  });
  return merged
    .replace(/\*\*/g, '')
    .split(/\n\s*\n/)
    .map(paragraph => paragraph.split('\n').map(lineText => lineText.trimEnd()).join('\n').trim())
    .filter(Boolean);
}

export function mergeSubject(template: string, fields: Record<string, string>) {
  return mergeTemplate(template, fields, {}).join(' ').replace(/\s+/g, ' ').trim();
}
