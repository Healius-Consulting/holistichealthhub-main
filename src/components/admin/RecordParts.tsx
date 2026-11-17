import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, type LucideIcon } from 'lucide-react';

/**
 * Shared pieces of the HHH admin records (patient intake, patient register):
 * a pinned section bar that scrolls to each section, and always-open cards
 * whose detail rows can be copied in one click.
 */

export type RecordSection<Id extends string> = { id: Id; label: string };

/**
 * Track which section sits under the pinned bar while the admin page scrolls,
 * and scroll to a section when the bar is clicked. A jump lets the highlight run
 * through the sections it passes, then settles on the one that was picked.
 */
export function useRecordSections<Id extends string>(sections: RecordSection<Id>[], {
  prefix,
  navSelector,
  enabled,
  resetKey,
}: {
  /** Each section's element id is `${prefix}-${section.id}`. */
  prefix: string;
  navSelector: string;
  enabled: boolean;
  /** Changing this (for example, opening another record) watches the new record. */
  resetKey: unknown;
}) {
  const first = sections[0]!.id;
  const [activeSection, setActiveSection] = useState<Id>(first);
  const pendingSectionRef = useRef<Id | null>(null);
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;

  const scrollTo = useCallback((section: Id, smooth: boolean) => {
    const container = document.getElementById('admin-main-content');
    const target = document.getElementById(`${prefix}-${section}`);
    if (!container || !target) return;
    const barHeight = document.querySelector<HTMLElement>(navSelector)?.offsetHeight ?? 0;
    const offset = target.getBoundingClientRect().top - container.getBoundingClientRect().top - barHeight - 16;
    container.scrollTo({ top: container.scrollTop + offset, behavior: smooth ? 'smooth' : 'auto' });
  }, [navSelector, prefix]);

  const goToSection = useCallback((section: Id) => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const container = document.getElementById('admin-main-content');
    const before = container?.scrollTop ?? 0;
    if (reduce) { pendingSectionRef.current = null; setActiveSection(section); }
    else pendingSectionRef.current = section;
    scrollTo(section, !reduce);
    // Already in place means no scroll events to settle on, so mark it once the click lands.
    window.setTimeout(() => {
      if (pendingSectionRef.current === section && (container?.scrollTop ?? 0) === before) { setActiveSection(section); pendingSectionRef.current = null; }
    }, 150);
  }, [scrollTo]);

  const reset = useCallback(() => {
    pendingSectionRef.current = null;
    setActiveSection(first);
  }, [first]);

  useEffect(() => {
    const container = document.getElementById('admin-main-content');
    if (!container || !enabled) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const bar = document.querySelector<HTMLElement>(navSelector);
      if (!bar) return;
      const list = sectionsRef.current;
      const line = bar.getBoundingClientRect().bottom + 40;
      let current = list[0]!.id;
      for (const section of list) {
        const el = document.getElementById(`${prefix}-${section.id}`);
        if (el && el.getBoundingClientRect().top <= line) current = section.id;
      }
      // At the very bottom the last section is the one being read, even if short.
      if (container.scrollTop + container.clientHeight >= container.scrollHeight - 2) current = list[list.length - 1]!.id;
      setActiveSection(current);
    };
    let settle = 0;
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
      window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        if (pendingSectionRef.current) setActiveSection(pendingSectionRef.current);
        pendingSectionRef.current = null;
      }, 120);
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    update();
    return () => { container.removeEventListener('scroll', onScroll); window.clearTimeout(settle); if (frame) window.cancelAnimationFrame(frame); };
  }, [enabled, navSelector, prefix, resetKey]);

  return { activeSection, goToSection, reset };
}

/** The pinned bar of section links under a record's header. */
export function RecordSectionNav<Id extends string>({ sections, active, onSelect, className, label }: {
  sections: RecordSection<Id>[];
  active: Id;
  onSelect: (section: Id) => void;
  className: string;
  label: string;
}) {
  return (
    <nav className={`pharmacy-dashboard__nav admin-record-nav ${className}`} aria-label={label}>
      {sections.map(section => (
        <button
          key={section.id}
          type="button"
          className={active === section.id ? 'is-active' : undefined}
          aria-current={active === section.id ? 'location' : undefined}
          onClick={() => onSelect(section.id)}
        >
          {section.label}
        </button>
      ))}
    </nav>
  );
}

/** An always-open card: icon, title (with an optional line under it), and a tag or action on the right. */
export function RecordCard({ icon: Icon, title, subtitle, tag, children, wide = false }: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  tag?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <section className={`pharmacy-details__card admin-intake-card${wide ? ' is-wide' : ''}`}>
      <header>
        <span className="pharmacy-details__icon" aria-hidden="true"><Icon size={15} /></span>
        {subtitle ? <span className="admin-intake-card__title"><h4>{title}</h4><small>{subtitle}</small></span> : <h4>{title}</h4>}
        {tag ?? <span aria-hidden="true" />}
      </header>
      {children}
    </section>
  );
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="pharmacy-details__row"><dt>{label}</dt><dd>{children}</dd></div>;
}

/** A small button that copies a value and shows a tick for a moment. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard can be blocked by the browser; the value is still selectable.
    }
  };
  return (
    <button type="button" className={`admin-intake-copy__btn${copied ? ' is-copied' : ''}`} onClick={() => void copy()} title={copied ? 'Copied' : `Copy ${label.toLowerCase()}`} aria-label={copied ? `${label} copied` : `Copy ${label.toLowerCase()}`}>
      {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
    </button>
  );
}

/** A detail row whose value can be copied in one click; an empty value reads "Not recorded". */
export function CopyFact({ label, value, flagged = false }: { label: string; value: unknown; flagged?: boolean }) {
  const text = value == null ? '' : String(value).trim();
  return (
    <div className="pharmacy-details__row admin-intake-copy-row">
      <dt>{label}</dt>
      <dd>
        {text ? (
          <span className="admin-intake-copy">
            {flagged ? <mark>{text}</mark> : <span>{text}</span>}
            <CopyButton text={text} label={label} />
          </span>
        ) : <span className="pharmacy-details__empty">Not recorded</span>}
      </dd>
    </div>
  );
}
