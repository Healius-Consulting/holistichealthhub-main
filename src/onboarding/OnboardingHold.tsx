import '../styles/onboarding-hold.css';
import HhhBrandMark from '../components/HhhBrandMark';
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

/**
 * What a branch on hold sees after PharmSmart or a password sign-in: the message for
 * its hold reason and nothing else. No forms, demo account, eligibility link or way
 * into the account until HHH lifts the hold.
 */
export function OnboardingHoldPage({
  hold,
  person,
}: {
  /** The server's message, merged for the branch. Missing: the generic message. */
  hold: HoldMessageView | null | undefined;
  /** Who signed in from PharmSmart, when known. */
  person?: { name: string; gphcNumber?: string | null } | null;
}) {
  const message = holdMessageOrGeneric(hold);
  return (
    <div className="staff-login-page auth-page staff-login-page--guide">
      <div className="onb onboarding-hold">
        <header className="onb__top">
          <div className="staff-login-lockup" aria-label="Holistic Health Hub">
            <HhhBrandMark />
            <span>
              <strong>Holistic Health Hub</strong>
              <small>Pharmacy onboarding</small>
            </span>
          </div>
        </header>
        <section className="onb__panel onboarding-hold__panel" aria-labelledby="onboarding-hold-title" role="status">
          <h1 id="onboarding-hold-title">{message.heading}</h1>
          {person?.name ? <p className="onb__person">Signed in from PharmSmart as <strong>{person.name}</strong>{person.gphcNumber ? <> · GPhC {person.gphcNumber}</> : null}</p> : null}
          <OnboardingHoldBody hold={message} />
        </section>
      </div>
    </div>
  );
}
