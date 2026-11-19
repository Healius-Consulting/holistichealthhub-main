import { CalendarDays } from 'lucide-react';
import type { ReactNode } from 'react';
import { ONBOARDING_CONTENT_DEFAULTS } from '../../services/api-sql/src/domain/pharmacy-onboarding/content.ts';
import { mergeTemplate } from '../../services/api-sql/src/domain/common/content-template.ts';
import type { HoldMessageView } from './branchOnboarding';
import { HoldLine, splitHoldFooter } from './OnboardingHold';
import { applicationSteps, OnboardingStatusPage } from './OnboardingStatusPage';

/** The default wording, merged for a branch: used when the server sent none. */
export function defaultAwaitingMessage(branchName: string): HoldMessageView {
  const page = ONBOARDING_CONTENT_DEFAULTS.awaitingPage;
  return { heading: page.heading, paragraphs: mergeTemplate(page.body, { 'Branch name': branchName }, {}), footer: page.footer };
}

/**
 * What a pharmacy sees from PharmSmart once its forms are in and it is waiting for HHH
 * to activate it. The wording is admin content (Onboarding settings → Awaiting
 * activation page); the stage tracker and the buttons are fixed.
 */
export function OnboardingAwaitingPage({
  message,
  branchName = 'your pharmacy',
  person,
  account,
  bookingUrl,
  preview,
}: {
  message: HoldMessageView | null | undefined;
  branchName?: string;
  person?: { name: string; gphcNumber?: string | null } | null;
  account?: ReactNode;
  bookingUrl?: string | null;
  preview?: boolean;
}) {
  const shown = message ?? defaultAwaitingMessage(branchName);
  const footer = splitHoldFooter(shown.footer);
  return (
    <OnboardingStatusPage
      tone="progress"
      badge="Awaiting activation"
      heading={shown.heading}
      person={person}
      steps={applicationSteps('awaiting')}
      account={account}
      contact={footer.address ?? undefined}
      contactLine={footer.address ? footer.line : <HoldLine line={footer.line} />}
      actions={bookingUrl ? (
        <a className="onb-status__button" href={bookingUrl} target="_blank" rel="noopener noreferrer">
          <CalendarDays size={16} aria-hidden="true" /> Book a demo call
        </a>
      ) : null}
      preview={preview}
    >
      {shown.paragraphs.map((paragraph, index) => <p key={index}><HoldLine line={paragraph} /></p>)}
    </OnboardingStatusPage>
  );
}
