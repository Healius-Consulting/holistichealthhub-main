import '../styles/onboarding-status.css';
import type { ReactNode } from 'react';
import { Check, Mail, Pause } from 'lucide-react';
import HhhBrandMark from '../components/HhhBrandMark';

/**
 * The page a pharmacy sees in place of the forms or its account while its application
 * waits: Awaiting activation, or On hold. A status badge and the message on the left,
 * where the application has got to on the right, and one way to reach us.
 */

export type StatusStep = {
  label: string;
  detail: string;
  /** done: ticked; current: where it is now; paused: stopped here (on hold); todo: still to come. */
  state: 'done' | 'current' | 'paused' | 'todo';
};

export const ONBOARDING_CONTACT = 'onboarding@holistichealthhub.live';

/** The four stages every application goes through, marked for where this one is. */
export function applicationSteps(at: 'awaiting' | 'on_hold'): StatusStep[] {
  const held = at === 'on_hold';
  return [
    { label: 'Application sent', detail: 'Your Curaleaf form and Partner Terms reached us.', state: 'done' },
    {
      label: 'Account set-up',
      detail: held ? 'Paused while your application is on hold.' : 'Curaleaf Laboratories usually open new accounts in three to five days.',
      state: held ? 'paused' : 'current',
    },
    { label: 'Ready to try', detail: 'We email you, and your team can explore the platform on example data.', state: 'todo' },
    { label: 'Live', detail: 'Ordering, card payments and your eligibility link switch on.', state: 'todo' },
  ];
}

function StepMark({ state, index }: { state: StatusStep['state']; index: number }) {
  if (state === 'done') return <Check size={14} strokeWidth={3} aria-hidden="true" />;
  if (state === 'paused') return <Pause size={13} strokeWidth={3} aria-hidden="true" />;
  if (state === 'current') return <span className="onb-status__pulse" aria-hidden="true" />;
  return <span aria-hidden="true">{index + 1}</span>;
}

const STEP_STATE_LABEL: Record<StatusStep['state'], string> = {
  done: 'Done',
  current: 'In progress',
  paused: 'On hold',
  todo: 'To come',
};

export function OnboardingStatusPage({
  tone,
  badge,
  heading,
  person,
  children,
  steps,
  contact = ONBOARDING_CONTACT,
  contactLine,
  actions,
  extra,
  account,
  preview = false,
}: {
  tone: 'progress' | 'hold';
  badge: string;
  heading: string;
  /** Who signed in from PharmSmart, when known. */
  person?: { name: string; gphcNumber?: string | null } | null;
  /** The message. */
  children: ReactNode;
  steps: StatusStep[];
  /** The address the contact button writes to. */
  contact?: string;
  /** The words beside the contact button; the address itself is the button. */
  contactLine?: ReactNode;
  /** Extra ways forward, beside the contact button. */
  actions?: ReactNode;
  /** A box between the message and the contact line (the awaiting page's Worldpay offer). */
  extra?: ReactNode;
  /** "Already on Holistic Health Hub? Sign in", where it applies. */
  account?: ReactNode;
  /** Shown inside the admin editor: no full-height page, no live region. */
  preview?: boolean;
}) {
  return (
    <div className={`staff-login-page auth-page staff-login-page--guide onb-status-page${preview ? ' is-preview' : ''}`}>
      <div className="onb onb-status">
        <header className="onb__top">
          <div className="staff-login-lockup" aria-label="Holistic Health Hub">
            <HhhBrandMark />
            <span>
              <strong>Holistic Health Hub</strong>
              <small>Pharmacy onboarding</small>
            </span>
          </div>
          {account ? <p className="onb__account">{account}</p> : null}
        </header>

        <section className={`onb-status__card is-${tone}`} aria-labelledby="onb-status-title" role={preview ? undefined : 'status'}>
          <div className="onb-status__main">
            <span className={`onb-status__badge is-${tone}`}>
              <span className="onb-status__badge-dot" aria-hidden="true" />
              {badge}
            </span>
            <h1 id="onb-status-title">{heading}</h1>
            {person?.name ? (
              <p className="onb-status__person">
                Signed in from PharmSmart as <strong>{person.name}</strong>
                {person.gphcNumber ? <> · GPhC {person.gphcNumber}</> : null}
              </p>
            ) : null}
            <div className="onb-status__body">{children}</div>
            {extra}
            <div className="onb-status__contact">
              {contactLine ? <p>{contactLine}</p> : null}
              <div className="onb-status__actions">
                <a className="onb-status__button is-primary" href={`mailto:${contact}`}>
                  <Mail size={16} aria-hidden="true" /> {contact}
                </a>
                {actions}
              </div>
            </div>
          </div>

          <aside className="onb-status__aside" aria-label="Where your application is">
            <h2>Your application</h2>
            <ol className="onb-status__steps">
              {steps.map((step, index) => (
                <li key={step.label} className={`is-${step.state}`}>
                  <span className="onb-status__mark"><StepMark state={step.state} index={index} /></span>
                  <span className="onb-status__step">
                    <strong>{step.label}<span className="sr-only">: {STEP_STATE_LABEL[step.state]}</span></strong>
                    <small>{step.detail}</small>
                  </span>
                </li>
              ))}
            </ol>
          </aside>
        </section>
      </div>
    </div>
  );
}
