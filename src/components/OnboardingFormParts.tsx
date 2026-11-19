import { useState, type ReactNode, type Ref } from 'react';
import { X } from 'lucide-react';

/**
 * The shared look of the onboarding forms (Curaleaf account, Partner Terms, Worldpay
 * application): a slim top bar on the content column, titled section cards, labelled
 * fields, and a footer aligned to the same column. Styles are the `.wpa-*` rules.
 */

export function FormTop({ eyebrow, title, titleId, onClose, closeLabel, disabled, closeRef, children }: {
  eyebrow: string;
  title: string;
  titleId: string;
  onClose: () => void;
  closeLabel: string;
  disabled?: boolean;
  closeRef?: Ref<HTMLButtonElement>;
  /** Under the title, e.g. the step bar. */
  children?: ReactNode;
}) {
  return (
    <header className="wpa-top">
      <div className="wpa-top__inner">
        <div className={children ? 'wpa-top__row' : 'wpa-top__row is-alone'}>
          <span className="wpa-top__title">
            <small>{eyebrow}</small>
            <h2 id={titleId}>{title}</h2>
          </span>
          <button ref={closeRef} type="button" className="wpa-close" onClick={onClose} disabled={disabled} aria-label={closeLabel} title={closeLabel}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </header>
  );
}

export function FormBottom({ status, children }: { status?: ReactNode; children: ReactNode }) {
  return (
    <footer className="wpa-bottom">
      <div className="wpa-bottom__inner">
        <span className="wpa-bottom__status">{status}</span>
        <span className="wpa-bottom__actions">{children}</span>
      </div>
    </footer>
  );
}

export function FormIntro({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="wpa-intro">
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

/** A required question gets a red asterisk; an optional one says "Optional". */
export function NeedMark({ optional = false }: { optional?: boolean }) {
  return optional
    ? <span className="wpa-optional">Optional</span>
    : <><span className="wpa-required" aria-hidden="true">*</span><span className="sr-only"> (required)</span></>;
}

/** The key the forms show once, near the top: what the asterisk means. */
export function RequiredKey() {
  return <p className="wpa-required-key"><span className="wpa-required" aria-hidden="true">*</span> Required</p>;
}

export function Field({ label, hint, warn, children, fromCompaniesHouse, wide, problem, optional }: {
  label: string;
  hint?: ReactNode;
  warn?: string | null;
  children: ReactNode;
  fromCompaniesHouse?: boolean;
  wide?: boolean;
  problem?: string | null;
  /** Can be left blank. Without it the question is required (red asterisk). */
  optional?: boolean;
}) {
  return (
    <label className={['wpa-field', wide ? 'is-wide' : '', problem ? 'has-problem' : ''].filter(Boolean).join(' ')}>
      <span className="wpa-field__label">
        {label}
        <NeedMark optional={optional} />
        {fromCompaniesHouse ? <span className="wpa-tag">From Companies House</span> : null}
      </span>
      {children}
      {problem ? <span className="wpa-field__problem">{problem}</span> : null}
      {warn ? <span className="wpa-field__warn">{warn}</span> : null}
      {hint ? <span className="wpa-field__hint">{hint}</span> : null}
    </label>
  );
}

/** A titled card holding one group of questions. */
export function Section({ title, description, children, tone, need }: {
  title?: string;
  description?: ReactNode;
  children: ReactNode;
  tone?: 'quiet';
  /** For a section that is itself one question: marks its title required or optional. */
  need?: 'required' | 'optional';
}) {
  return (
    <section className={tone === 'quiet' ? 'wpa-section is-quiet' : 'wpa-section'}>
      {title ? (
        <header className="wpa-section__head">
          <h4>{title}{need ? <NeedMark optional={need === 'optional'} /> : null}</h4>
          {description ? <p>{description}</p> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/**
 * An answer we filled in for the pharmacy: read like Check and send, with Change to
 * edit it. It opens by itself when the answer needs fixing.
 */
export function Answered({ label, value, children, problem, note, optional }: { label: string; value: ReactNode; children: ReactNode; problem?: string | null; note?: ReactNode; optional?: boolean }) {
  const [editing, setEditing] = useState(false);
  const open = editing || Boolean(problem);
  return (
    <div className={open ? 'wpa-answered is-open' : 'wpa-answered'}>
      <div className="wpa-answered__row">
        <span className="wpa-answered__label">{label}<NeedMark optional={optional} /></span>
        <button type="button" className="wpa-link" aria-expanded={open} onClick={() => setEditing(current => !current)}>{open ? 'Done' : 'Change'}</button>
      </div>
      {open ? <div className="wpa-answered__edit">{children}</div> : <div className="wpa-answered__value">{value}</div>}
      {problem ? <span className="wpa-field__problem">{problem}</span> : null}
      {note}
    </div>
  );
}

export function OptionCards<T extends string>({ value, options, onChange, name, compact, grid }: {
  value: string;
  options: ReadonlyArray<{ value: T; label: string; detail?: string }>;
  onChange: (value: T) => void;
  name: string;
  compact?: boolean;
  /** Two columns on wider screens, for a longer list of short options. */
  grid?: boolean;
}) {
  return (
    <div className={['wpa-options', compact ? 'is-compact' : '', grid ? 'is-grid' : ''].filter(Boolean).join(' ')} role="radiogroup" aria-label={name}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={value === option.value ? 'wpa-option is-active' : 'wpa-option'}
          onClick={() => onChange(option.value)}
        >
          <span className="wpa-option__dot" aria-hidden="true" />
          <span className="wpa-option__text">
            <strong>{option.label}</strong>
            {option.detail ? <small>{option.detail}</small> : null}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Steps as a slim progress line; on a phone, "Step 2 of 5" and the step's name. `current` is 1-based; 0 is an intro before step 1. */
export function Stepper({ steps, current, onGo, locked, introLabel }: { steps: string[]; current: number; onGo: (index: number) => void; locked?: boolean; introLabel?: string }) {
  return (
    <nav className="wpa-stepper" aria-label="Progress">
      <p className="wpa-stepper__now">
        {current === 0 ? introLabel : <>Step {current} of {steps.length} <span>· {steps[current - 1]}</span></>}
      </p>
      <ol>
        {steps.map((name, offset) => {
          const index = offset + 1;
          const state = index < current ? 'done' : index === current ? 'current' : 'todo';
          return (
            <li key={name} className={`is-${state}`}>
              <button type="button" disabled={locked} onClick={() => onGo(index)} aria-current={state === 'current' ? 'step' : undefined}>
                <span className="wpa-stepper__dot" aria-hidden="true">{state === 'done' ? '✓' : index}</span>
                <span className="wpa-stepper__name">{name}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function Row({ label, value }: { label: string; value: ReactNode }) {
  return <tr><th scope="row">{label}</th><td>{value || <span className="wpa-tiny">not given</span>}</td></tr>;
}

export function SummaryCard({ title, step, onEdit, children }: { title: string; step: number; onEdit: (step: number) => void; children: ReactNode }) {
  return (
    <div className="wpa-card wpa-summary">
      <div className="wpa-summary__head"><strong>{title}</strong><button type="button" className="btn btn-sm" onClick={() => onEdit(step)}>Edit</button></div>
      <table><tbody>{children}</tbody></table>
    </div>
  );
}

/** One choice from a short list, as a row of pills (the chosen one filled, with a tick). */
export function PillChoice<T extends string>({ value, options, onChange, name }: {
  value: string;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  name: string;
}) {
  return (
    <div className="wpa-pills" role="radiogroup" aria-label={name}>
      {options.map(option => {
        const on = value === option.value;
        return (
          <button key={option.value} type="button" role="radio" aria-checked={on} className={on ? 'wpa-toggle is-on' : 'wpa-toggle'} onClick={() => onChange(option.value)}>
            {on ? '✓ ' : ''}{option.label}
          </button>
        );
      })}
    </div>
  );
}
