/**
 * Brief 2.10: the pharmacy-facing Help page.
 *
 * DRAFT, 18 Nov 2026: written from what the platform does, for HHH to confirm or reword.
 * Operational answers only: nothing clinical and nothing patient-facing. Swap the
 * wording here; the page reads nothing else. Add an entry to add a question.
 */

export const ONBOARDING_INBOX = 'onboarding@holistichealthhub.live';

export type HelpTopic = 'getting-started' | 'patients' | 'payments' | 'support';

export const HELP_TOPICS: readonly { id: HelpTopic; title: string }[] = [
  { id: 'getting-started', title: 'Getting started' },
  { id: 'patients', title: 'Patients and orders' },
  { id: 'payments', title: 'Payments' },
  { id: 'support', title: 'Materials and support' },
];

export type HelpQuestion = { id: string; topic: HelpTopic; question: string; answer: string };

export const PHARMACY_FAQ: readonly HelpQuestion[] = [
  {
    id: 'awaiting-curaleaf',
    topic: 'getting-started',
    question: 'What does "Awaiting Curaleaf" mean?',
    answer: 'Your forms are in and Curaleaf Laboratories are opening your account. We finish this step when they send your account details, and your account goes live straight after. You don\'t need to do anything for it.',
  },
  {
    id: 'what-works-before-live',
    topic: 'getting-started',
    question: 'What can I use before my account is live?',
    answer: 'Your eligibility link and QR code already work, and eligible patients are added to your Patients list. The catalogue, ordering and payments open when your account goes live.',
  },
  {
    id: 'demo-mode',
    topic: 'getting-started',
    question: 'What is Demo mode?',
    answer: 'Demo mode fills the platform with example patients and orders so you can try every screen. Nothing you do there is real or sent anywhere. Turn it on from the menu, and use "Return to live" to go back to your own account.',
  },
  {
    id: 'go-live-checklist',
    topic: 'getting-started',
    question: 'What is the go-live checklist?',
    answer: 'A list of the things to have in place before you start, such as your SOPs and staff training. Tick items as you do them. Some tick themselves. Nothing on the platform waits on the list. You\'ll find it on the Onboarding page.',
  },
  {
    id: 'who-prescribes',
    topic: 'patients',
    question: 'Who assesses and prescribes?',
    answer: 'Curaleaf Clinic. Our team checks each patient\'s eligibility and refers them to the clinic. A specialist consults remotely and sends the prescription to your pharmacy, which dispenses it.',
  },
  {
    id: 'new-patients',
    topic: 'patients',
    question: 'Where do new patients appear?',
    answer: 'On the Patients page. A patient who completes your eligibility form is attributed to your pharmacy automatically, so always use your own link or QR code.',
  },
  {
    id: 'orders',
    topic: 'patients',
    question: 'How do I order a prescription?',
    answer: 'Once your account is live, use Create order to build the order from the prescription and send the patient a payment link. You order from Curaleaf Laboratories on the platform, and the patient collects from you.',
  },
  {
    id: 'worldpay',
    topic: 'payments',
    question: 'Do I need Worldpay?',
    answer: 'Card payments through Worldpay are optional. Send the Worldpay form from the Onboarding page and our team passes it to Worldpay. You\'ll need the bank account for payouts and each owner\'s details.',
  },
  {
    id: 'payment-links',
    topic: 'payments',
    question: 'How do patients pay?',
    answer: 'You send the patient a secure payment link from the order. Where card payments aren\'t set up yet, talk to our team about the other options.',
  },
  {
    id: 'posters',
    topic: 'support',
    question: 'Where are my QR code and posters?',
    answer: 'In Settings & Support, under Assets. You can download your eligibility link, a high-resolution QR code and a pack for your web developer, and an A3 poster and A5 leaflet with your logo and QR code to send to your printer.',
  },
  {
    id: 'contact',
    topic: 'support',
    question: 'Who do I contact?',
    answer: `Email ${ONBOARDING_INBOX} about setting up your account. The other contacts, for the clinic and supply, are in Settings & Support.`,
  },
];

/** Guides the page links to. Paths are under the site's public folder. */
export const PHARMACY_GUIDES = [
  {
    id: 'brochure',
    title: 'Holistic Health Hub brochure',
    detail: 'How the service works, from intake to collection.',
    href: '/onboarding/holistic-health-hub-brochure.pdf',
  },
] as const;

/** Questions matching a search, in their list order. An empty search returns them all. */
export function searchFaq(query: string, questions: readonly HelpQuestion[] = PHARMACY_FAQ): HelpQuestion[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...questions];
  return questions.filter(item => {
    const text = `${item.question} ${item.answer}`.toLowerCase();
    return words.every(word => text.includes(word));
  });
}
