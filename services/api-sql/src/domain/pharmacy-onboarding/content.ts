import { z } from 'zod';

/**
 * Partner onboarding content HHH admin can change without a release: the five
 * onboarding emails, the hold page, the Reply-To addresses and the links (Shay's
 * onboarding emails build pack, 19 Nov 2026; decisions in that session).
 *
 * Stored in PlatformContent under these keys. A key with no stored row uses the
 * default here. Templates use `[Merge field]` and `[If flag]…[/If]` (see
 * domain/common/content-template.ts); the fields and flags each email gets are
 * listed in ONBOARDING_EMAIL_MERGE_HELP so the admin screen can show them.
 */

export const ONBOARDING_CONTENT_KEYS = {
  sent: 'onboarding.email.sent',
  activation: 'onboarding.email.activation',
  hold: 'onboarding.email.hold',
  live: 'onboarding.email.live',
  curaleafApplication: 'onboarding.email.curaleafApplication',
  holdPage: 'onboarding.holdPage',
  awaitingPage: 'onboarding.awaitingPage',
  addresses: 'onboarding.addresses',
  links: 'onboarding.links',
} as const;
export type OnboardingContentKey = keyof typeof ONBOARDING_CONTENT_KEYS;

/** The emails in ONBOARDING_CONTENT_KEYS, in the order a pharmacy meets them. */
export const ONBOARDING_EMAIL_KINDS = ['sent', 'curaleafApplication', 'activation', 'hold', 'live'] as const;
export type OnboardingEmailKind = (typeof ONBOARDING_EMAIL_KINDS)[number];

export const ONBOARDING_HOLD_REASONS = ['EXISTING_CURALEAF_CUSTOMER', 'MORE_INFORMATION_NEEDED', 'CURALEAF_DECLINED'] as const;
export type OnboardingHoldReason = (typeof ONBOARDING_HOLD_REASONS)[number];

/** What admin sees in the reason list (A, B, C as in the build pack). */
export const HOLD_REASON_LABEL: Record<OnboardingHoldReason, string> = {
  EXISTING_CURALEAF_CUSTOMER: 'A. Existing Curaleaf customer',
  MORE_INFORMATION_NEEDED: 'B. More information needed',
  CURALEAF_DECLINED: 'C. Curaleaf declined',
};

/** The `[If …]` flag each reason turns on in the Hold email. */
export const HOLD_REASON_FLAG: Record<OnboardingHoldReason, string> = {
  EXISTING_CURALEAF_CUSTOMER: 'existing curaleaf customer',
  MORE_INFORMATION_NEEDED: 'more information needed',
  CURALEAF_DECLINED: 'curaleaf declined',
};

const email = z.string().trim().toLowerCase().email().max(254);
const emailTemplateSchema = z.object({
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(10_000),
});
const holdPageSchema = z.object({
  heading: z.string().trim().min(1).max(200),
  EXISTING_CURALEAF_CUSTOMER: z.string().trim().min(1).max(3000),
  MORE_INFORMATION_NEEDED: z.string().trim().min(1).max(3000),
  CURALEAF_DECLINED: z.string().trim().min(1).max(3000),
  footer: z.string().trim().max(500),
});
const awaitingPageSchema = z.object({
  heading: z.string().trim().min(1).max(200),
  /** Paragraphs, split on blank lines; [Branch name] merges. */
  body: z.string().trim().min(1).max(3000),
  /** The contact line; an email address in it becomes the contact button. */
  footer: z.string().trim().max(500),
});
const addressesSchema = z.object({
  /** Reply-To on the Sent, Activation, Hold and Live emails (From stays the verified onboarding@ alias). */
  pharmacyReplyTo: email,
  /** Reply-To on the application to Curaleaf: Curaleaf's queries and refusals come back here. */
  curaleafReplyTo: email,
  /** The sender name on every onboarding email. */
  displayName: z.string().trim().min(1).max(100),
});
const url = z.union([z.literal(''), z.string().trim().url().max(500)]);
const linksSchema = z.object({
  /** Blank leaves the booking sentence out of the Activation email. */
  trainingBookingUrl: url,
});

export const ONBOARDING_CONTENT_SCHEMAS = {
  sent: emailTemplateSchema,
  activation: emailTemplateSchema,
  hold: emailTemplateSchema,
  live: emailTemplateSchema,
  curaleafApplication: emailTemplateSchema,
  holdPage: holdPageSchema,
  awaitingPage: awaitingPageSchema,
  addresses: addressesSchema,
  links: linksSchema,
} as const;

export type OnboardingContent = { [K in OnboardingContentKey]: z.infer<(typeof ONBOARDING_CONTENT_SCHEMAS)[K]> };


const paragraphs = (...parts: string[]) => parts.join('\n\n');
const SIGN_OFF = 'Kind regards,\nPartner Onboarding, Holistic Health Hub';

export const ONBOARDING_CONTENT_DEFAULTS: OnboardingContent = {
  sent: {
    subject: 'We have your Holistic Health Hub application for [Branch name]',
    body: paragraphs(
      'Hello [Signer first name],',
      'Thank you for applying to join Holistic Health Hub. We sent your new account application for [Branch name] to Curaleaf Laboratories on [Submission date].',
      'What happens next',
      'Curaleaf Laboratories open your account, which usually takes three to five days. We will email you when your account is ready to try in demonstration mode, and again when it is live. You do not need to do anything further on the application. If Curaleaf need more information, we will contact you.',
      '[If no worldpay]Card payments are optional. You can take payment in the pharmacy from day one, and you can apply for online card payments from the checklist at any time.[/If][If worldpay submitted]Worldpay will email you separately about your application.[/If]',
      '[If terms accepted]Your Partner Terms[/If]',
      '[If terms accepted][Signer full name] accepted the Holistic Health Hub Partner Terms (version [Terms version]) for [Registered company name] on [Acceptance date]. A signed copy is in your account.[/If]',
      'If you have a question, reply to this email.',
      SIGN_OFF,
    ),
  },
  activation: {
    subject: 'Your Holistic Health Hub account for [Branch name] is ready to try',
    body: paragraphs(
      'Hello [Signer first name],',
      'We have set up the Holistic Health Hub account for [Branch name]. While Curaleaf Laboratories open your account, it is in demonstration mode. It holds example data so that you and your team can try every screen. Patient enquiries and your eligibility link are switched on when you go live.',
      'To get ready, log in to Pharmsmart, open the Holistic Health Hub tab and work through the checklist shown when you log in:\n1. Have your superintendent pharmacist approve the service SOPs.\n2. Add the formulary to your PMR.\n3. Train your team[If training link]. Book a place on a live session at [Training booking link], or use the training materials in your account.[/If][If no training link], using the training materials in your account.[/If]',
      'The checklist also covers the optional steps, such as posters, your website and your pharmacy’s details and logo.',
      '[If no worldpay]Card payments are optional. You can take payment in the pharmacy from day one, and you can apply for online card payments from the checklist at any time.[/If][If worldpay submitted]Worldpay will email you separately about your application.[/If]',
      'If a colleague does not use Pharmsmart, reply to this email and we will send them an invite.',
      SIGN_OFF,
    ),
  },
  hold: {
    subject: 'Your Holistic Health Hub application for [Branch name] is on hold',
    body: paragraphs(
      'Hello [Signer first name],',
      'Thank you for applying to join Holistic Health Hub. Your application for [Branch name] is on hold.',
      '[If existing curaleaf customer]Curaleaf Laboratories have told us that [Branch name] already has an account with them. For now, our agreement with Curaleaf Laboratories covers only pharmacies that are new to them, so we are not able to set up your Holistic Health Hub account yet.\n\nHolistic Health Hub may be available to existing Curaleaf pharmacies in the near future. We will keep your application and contact you as soon as we can go ahead. You do not need to apply again.\n\nYour existing Curaleaf Laboratories account is not affected, and you can carry on ordering from them as you do today.[/If]',
      '[If more information needed]We need some more information before your account can be opened.\n\nHealius Consulting will be in touch with you about this.\n\nYou do not need to apply again.[/If]',
      '[If curaleaf declined]Curaleaf Laboratories were not able to open an account for [Branch name], so we cannot set up your Holistic Health Hub account at the moment.\n\nHealius Consulting will be in touch about what happens next. You do not need to do anything for now.[/If]',
      '[If worldpay submitted]Your Worldpay application is not affected and continues as normal.[/If]',
      'If you think this is a mistake, or you have a question, reply to this email.',
      SIGN_OFF,
    ),
  },
  live: {
    subject: '[Branch name] is live on Holistic Health Hub',
    body: paragraphs(
      'Hello [Signer first name],',
      'Your Curaleaf Laboratories account is open and [Branch name] is now live on Holistic Health Hub.',
      'What has changed',
      '- The example data has been removed. Your account now holds your own patients and orders only.\n- Your eligibility link and QR code are active. You will find them in Settings > Assets.\n- You can place orders with Curaleaf Laboratories through the platform.\n- Your Curaleaf account number is [PHAR code]. Quote it if you contact Curaleaf Laboratories.',
      '[If worldpay not validated]Payment is taken in the pharmacy. When the patient has paid, click Record payment on the order and the platform places it.[/If][If worldpay validated]Online card payments are set up. The platform sends each patient a payment link and places the order when they pay.[/If]',
      '[If required outstanding]Before you dispense your first prescription\n\nThese items on your checklist are still open:\n[Outstanding required items]\n\nPlease complete them and tick them off in your account.[/If]',
      '[If optional outstanding]Also worth doing\n\n[Outstanding optional items][/If]',
      'Help',
      'The Key contacts card in your account lists who to contact for clinical, supply and platform questions. For anything about getting started, reply to this email.',
      SIGN_OFF,
    ),
  },
  curaleafApplication: {
    subject: 'New account application: [Branch name], GPhC [GPhC premises no.]',
    body: paragraphs(
      'Hello,',
      'Please find attached a new account application from [Branch name], submitted through the Holistic Health Hub partner platform on [Submission date] at [Submission time].',
      '[Branch name] has applied under our interim arrangement, which covers pharmacies that are new to Curaleaf. If the pharmacy already holds a Curaleaf account, please tell us by replying to this email rather than opening a second account. We will then let the pharmacy know.',
      'Once the account is open',
      'Please provide us with the PHAR code, API key and referral-portal login.',
      'Send any questions about this application to us by replying to this email.',
      SIGN_OFF,
    ),
  },
  holdPage: {
    heading: 'Your application is on hold',
    EXISTING_CURALEAF_CUSTOMER: paragraphs(
      'Curaleaf Laboratories have told us that [Branch name] already has an account with them. For now, our agreement with Curaleaf Laboratories covers only pharmacies that are new to them, so we are not able to set up your Holistic Health Hub account yet.',
      'Holistic Health Hub may be available to existing Curaleaf pharmacies in the near future. We have kept your application and will contact you as soon as we can go ahead. You do not need to apply again.',
      'Your existing Curaleaf Laboratories account is not affected, and you can carry on ordering from them as you do today.',
    ),
    MORE_INFORMATION_NEEDED: paragraphs(
      'We need some more information before your account can be opened. Healius Consulting will be in touch with you about this.',
      'You do not need to apply again.',
    ),
    CURALEAF_DECLINED: paragraphs(
      'Curaleaf Laboratories were not able to open an account for [Branch name], so we cannot set up your Holistic Health Hub account at the moment.',
      'Healius Consulting will be in touch about what happens next. You do not need to do anything for now.',
    ),
    footer: 'Questions? Email onboarding@holistichealthhub.live',
  },
  awaitingPage: {
    heading: 'We’re setting up your account',
    body: paragraphs(
      'Thank you for applying. Your application for [Branch name] is with Curaleaf Laboratories, who usually open new accounts in three to five days.',
      'We will email you when your account is ready to try, and again when it goes live. You do not need to do anything else for now.',
    ),
    footer: 'Questions about your application? Email onboarding@holistichealthhub.live',
  },
  addresses: {
    pharmacyReplyTo: 'onboarding@holistichealthhub.live',
    curaleafReplyTo: 'spatel@healiusconsulting.com',
    displayName: 'Holistic Health Hub — Partner Onboarding',
  },
  links: {
    trainingBookingUrl: 'https://calendly.com/spatel-72k/30min',
  },
};

/** The merge fields and flags each email is given, for the admin screen's help text. */
export const ONBOARDING_EMAIL_MERGE_HELP: Record<OnboardingEmailKind, { fields: string[]; flags: string[] }> = {
  sent: {
    fields: ['Branch name', 'Signer first name', 'Signer full name', 'Registered company name', 'Submission date', 'Terms version', 'Acceptance date'],
    flags: ['no worldpay', 'worldpay submitted', 'terms accepted'],
  },
  curaleafApplication: {
    fields: ['Branch name', 'GPhC premises no.', 'Submission date', 'Submission time'],
    flags: [],
  },
  activation: {
    fields: ['Branch name', 'Signer first name', 'Training booking link'],
    flags: ['training link', 'no training link', 'no worldpay', 'worldpay submitted'],
  },
  hold: {
    fields: ['Branch name', 'Signer first name'],
    flags: ['existing curaleaf customer', 'more information needed', 'curaleaf declined', 'worldpay submitted'],
  },
  live: {
    fields: ['Branch name', 'Signer first name', 'PHAR code', 'Outstanding required items', 'Outstanding optional items'],
    flags: ['worldpay validated', 'worldpay not validated', 'required outstanding', 'optional outstanding'],
  },
};

/** Reads stored content, falling back to the default for any key that is missing or no longer valid. */
export function onboardingContentFrom(stored: Record<string, unknown>): OnboardingContent {
  const out = { ...ONBOARDING_CONTENT_DEFAULTS } as Record<OnboardingContentKey, unknown>;
  for (const name of Object.keys(ONBOARDING_CONTENT_KEYS) as OnboardingContentKey[]) {
    const raw = stored[ONBOARDING_CONTENT_KEYS[name]];
    if (raw === undefined) continue;
    const parsed = ONBOARDING_CONTENT_SCHEMAS[name].safeParse(raw);
    if (parsed.success) out[name] = parsed.data;
  }
  return out as OnboardingContent;
}
