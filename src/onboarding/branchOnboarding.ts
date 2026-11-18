/**
 * The pharmacy portal's onboarding rules, kept free of React so they can be tested:
 * the account status card, the Awaiting Curaleaf banner, the screens that wait for
 * go-live, and the Onboarding queue.
 */

const UK_DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });

/** "19 November 2026", in UK time. Empty for a missing or unreadable date. */
export function formatOnboardingDate(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : UK_DATE.format(date);
}

// ---------------------------------------------------------------------------
// Account status: one card, three states.

export type PharmacyAccountState = 'being_set_up' | 'not_available' | 'suspended';

/** The card for a branch's status. Live has none. */
export function pharmacyAccountState(status: string | null | undefined): PharmacyAccountState | null {
  if (status === 'onboarding' || status === 'intake_live') return 'being_set_up';
  if (status === 'not_available') return 'not_available';
  if (status === 'paused') return 'suspended';
  return null;
}

/** Suspended and Not available pharmacies are refused at sign-in; the code says which. */
export function pharmacyAccountStateFromCode(code: string | null | undefined): Exclude<PharmacyAccountState, 'being_set_up'> | null {
  if (code === 'PHARMACY_NOT_AVAILABLE') return 'not_available';
  if (code === 'PHARMACY_SUSPENDED') return 'suspended';
  return null;
}

export const ONBOARDING_EMAIL = 'onboarding@holistichealthhub.live';

export const PHARMACY_ACCOUNT_STATE_COPY: Record<PharmacyAccountState, { title: string; body: string }> = {
  being_set_up: {
    title: 'Your account is being set up',
    body: 'Curaleaf Laboratories are opening your account. Your eligibility link is already open, so eligible patients are added to your list. Ordering and payments open when your account goes live.',
  },
  not_available: {
    title: 'Not available yet',
    body: `This service may be available to you in the near future. Contact ${ONBOARDING_EMAIL} for more details.`,
  },
  suspended: {
    title: 'Account suspended',
    body: 'This pharmacy\'s account is suspended. Contact Holistic Health Hub to restore access.',
  },
};

// ---------------------------------------------------------------------------
// Pre-live: Curaleaf-dependent screens wait for go-live.

/** Stock, prices and orders all come from Curaleaf. */
export const CURALEAF_DEPENDENT_SCREENS = ['formulary', 'create', 'orders'] as const;

/**
 * Before go-live these screens say "Available once your account is live" and point at
 * Demo mode, rather than mixing demo data into the real account. Demo mode and local
 * preview show the demo data set everywhere, so nothing is locked there.
 */
export function preLiveLockedScreen(
  screen: string,
  flags: { workspaceMode: string; demo: boolean; sandbox: boolean },
): boolean {
  if (flags.demo || flags.sandbox) return false;
  if (flags.workspaceMode !== 'training') return false;
  return (CURALEAF_DEPENDENT_SCREENS as readonly string[]).includes(screen);
}

// ---------------------------------------------------------------------------
// The Awaiting Curaleaf banner (one banner; Demo mode has its own instead).

export type AwaitingSetupBanner = { title: string; submitted: string | null; body: string };

export function awaitingSetupBanner(input: {
  status: string | null | undefined;
  workspaceMode: string;
  demo: boolean;
  submittedAt: string | null | undefined;
}): AwaitingSetupBanner | null {
  if (input.demo) return null;
  if (input.workspaceMode !== 'training') return null;
  if (pharmacyAccountState(input.status) !== 'being_set_up') return null;
  const date = formatOnboardingDate(input.submittedAt);
  return {
    title: 'Your forms have been submitted — your account is awaiting set-up',
    submitted: date ? `Submitted ${date}` : null,
    body: 'Your eligibility link is already open: eligible patients are added to your list. Ordering opens when your account goes live.',
  };
}

// ---------------------------------------------------------------------------
// The Onboarding queue. A fixed list in code: add an entry here to add an item.

export type OnboardingQueueAction = 'terms' | 'worldpay' | 'demo' | 'book';

export type OnboardingQueueInput = {
  live: boolean;
  termsAccepted: boolean;
  worldpaySubmittedAt: string | null;
  demoActive: boolean;
};

export type OnboardingQueueItem = {
  id: string;
  title: string;
  detail: string;
  /** done: ticked; waiting: someone else completes it; open: the pharmacy can act. */
  state: 'done' | 'waiting' | 'open';
  /** Shown in place of a button once done or while waiting. */
  status: string | null;
  action: { kind: OnboardingQueueAction; label: string } | null;
};

type QueueEntry = { id: string; build: (input: OnboardingQueueInput) => Omit<OnboardingQueueItem, 'id'> };

export const ONBOARDING_QUEUE: readonly QueueEntry[] = [
  {
    // Only HHH completes this: it ticks itself when the PHAR code and API key are in.
    id: 'awaiting_curaleaf',
    build: ({ live }) => ({
      title: 'Awaiting Curaleaf',
      detail: live
        ? 'Your Curaleaf account is open and your account is live.'
        : 'Curaleaf Laboratories are opening your account. We complete this step when they send your account details.',
      state: live ? 'done' : 'waiting',
      status: live ? 'Live' : 'Awaiting Curaleaf',
      action: null,
    }),
  },
  {
    // The server refuses Worldpay until the Partner Terms are in, so a branch without them accepts them first.
    id: 'worldpay',
    build: ({ termsAccepted, worldpaySubmittedAt }) => {
      const date = formatOnboardingDate(worldpaySubmittedAt);
      if (worldpaySubmittedAt) {
        return {
          title: 'Worldpay card payments',
          detail: 'Your Worldpay form is with our team, who pass it on to Worldpay.',
          state: 'done',
          status: date ? `Submitted ${date}` : 'Submitted',
          action: null,
        };
      }
      return {
        title: 'Worldpay card payments',
        detail: termsAccepted
          ? 'Lets patients pay by card through a secure link. You will need the bank account for payouts and each owner\'s date of birth and home address.'
          : 'Accept the Partner Terms first. The Worldpay form opens straight after.',
        state: 'open',
        status: null,
        action: termsAccepted ? { kind: 'worldpay', label: 'Submit form' } : { kind: 'terms', label: 'Accept Partner Terms' },
      };
    },
  },
  {
    id: 'demo_account',
    build: ({ demoActive }) => ({
      title: 'Check out demo account',
      detail: 'Try the platform on example patients and orders. Nothing you do in demo mode is real or sent anywhere.',
      state: 'open',
      status: demoActive ? 'Demo mode is on' : null,
      action: demoActive ? null : { kind: 'demo', label: 'Open demo account' },
    }),
  },
  {
    id: 'demo_call',
    build: () => ({
      title: 'Book a demo call',
      detail: 'A 30-minute call with our team to walk through the platform.',
      state: 'open',
      status: null,
      action: { kind: 'book', label: 'Book a call' },
    }),
  },
];

export function onboardingQueueItems(input: OnboardingQueueInput): OnboardingQueueItem[] {
  return ONBOARDING_QUEUE.map(entry => ({ id: entry.id, ...entry.build(input) }));
}
