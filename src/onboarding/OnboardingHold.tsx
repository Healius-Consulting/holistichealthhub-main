import '../styles/onboarding-hold.css';
import { applicationSteps, OnboardingStatusPage } from './OnboardingStatusPage';
import { holdMessageOrGeneric, textWithEmailLinks, type HoldMessageView } from './branchOnboarding';

/** A line of hold wording, with any email address in it as a mailto link. */
export function HoldLine({ line }: { line: string }) {
  return (
    <>
      {textWithEmailLinks(line).map((part, index) => (part.kind === 'email'
        ? <a key={index} className="onboarding-hold__address" href={`mailto:${part.address}`}>{part.address}</a>
        : <span key={index}>{part.text}</span>))}
    </>
  );
}

/** The hold message's paragraphs and footer, under a heading the caller places. */
export function OnboardingHoldBody({ hold }: { hold: HoldMessageView }) {
  return (
    <>
      {hold.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
      {hold.footer ? <p className="onboarding-hold__footer"><HoldLine line={hold.footer} /></p> : null}
    </>
  );
}

/** The footer's address for the contact button, and its words without it ("Questions?"). */
export function splitHoldFooter(footer: string): { address: string | null; line: string } {
  const email = textWithEmailLinks(footer).find(part => part.kind === 'email');
  if (!email || email.kind !== 'email') return { address: null, line: footer };
  const line = footer.replace(email.address, '').replace(/\s*(?:email|e-mail|write to|contact)?\s*(?:us)?\s*(?:at|on)?\s*[:.]?\s*$/i, '').trim();
  return { address: email.address, line };
}

/**
 * What a branch on hold sees after PharmSmart or a password sign-in: the message for
 * its hold reason and nothing else. No forms, demo account, eligibility link or way
 * into the account until HHH lifts the hold.
 */
export function OnboardingHoldPage({
  hold,
  person,
  preview,
}: {
  /** The server's message, merged for the branch. Missing: the generic message. */
  hold: HoldMessageView | null | undefined;
  /** Who signed in from PharmSmart, when known. */
  person?: { name: string; gphcNumber?: string | null } | null;
  /** Inside the admin editor. */
  preview?: boolean;
}) {
  const message = holdMessageOrGeneric(hold);
  const footer = splitHoldFooter(message.footer);
  return (
    <OnboardingStatusPage
      tone="hold"
      badge="On hold"
      heading={message.heading}
      person={person}
      steps={applicationSteps('on_hold')}
      contact={footer.address ?? undefined}
      contactLine={footer.address ? footer.line : <HoldLine line={footer.line} />}
      preview={preview}
    >
      {message.paragraphs.map((paragraph, index) => <p key={index}><HoldLine line={paragraph} /></p>)}
    </OnboardingStatusPage>
  );
}
