import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { CheckCircle2, Circle, ExternalLink, Lock, X } from 'lucide-react';
import { useAuth } from '../auth/useAuth';
import { useApp } from '../context/AppContext';
import { describeApiError, getGoLiveChecklist, loadWorldpayApplication, setGoLiveChecklistItem } from '../shared/api';
import { settingsHref, contentPackGroupElementId, type SettingsLinkTarget } from '../routing/settingsLink';
import { appPathPrefix } from '../auth/surface-path';
import {
  checklistDetailSegments,
  ownerLabel,
  sectionSummary,
  type ChecklistSection,
  type GoLiveChecklist as Checklist,
  type GoLiveChecklistItem,
} from '../shared/goLiveChecklist';
import { goLiveChecklistSource } from '../training/demoChecklist';
import { isDemoActive } from '../training/demoMode';
import { isLocalPortalPreview } from '../dev/localPortalPreview';
import './GoLiveChecklist.css';

/**
 * The go-live checklist (brief 2.5) for the pharmacy's own branch. Self-contained, so it
 * can sit in the login prompt below and on the portal Onboarding page. Nothing is gated
 * by it. In Demo mode it reads and ticks the local demo store, never the server.
 */
export function useGoLiveChecklist() {
  const { state } = useApp();
  const organisationId = state.currentOrganisationId;
  const demo = state.demoMode;
  const source = useMemo(() => goLiveChecklistSource({
    organisationId,
    // Local preview has no API, so it ticks the local demo store too.
    demoActive: () => demo || isDemoActive() || isLocalPortalPreview,
    server: { load: getGoLiveChecklist, setItem: setGoLiveChecklistItem },
  }), [demo, organisationId]);
  const [checklist, setChecklist] = useState<Checklist | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    if (!organisationId) return;
    let cancelled = false;
    setChecklist(null);
    setError(null);
    source.load()
      .then(view => { if (!cancelled) setChecklist(view); })
      .catch(reason => { if (!cancelled) setError(describeApiError(reason, 'The go-live checklist could not be loaded.')); });
    return () => { cancelled = true; };
  }, [organisationId, source]);

  const toggle = useCallback(async (itemKey: string, done: boolean) => {
    setSaving(itemKey);
    setError(null);
    try {
      setChecklist(await source.setItem(itemKey, done));
    } catch (reason) {
      setError(describeApiError(reason, 'That item could not be saved.'));
    } finally {
      setSaving(null);
    }
  }, [source]);

  return { checklist, error, saving, toggle, demo };
}

const SECTION_TITLES: Record<ChecklistSection, string> = { required: 'Required', optional: 'Optional' };
const GROUP_TITLES = { platform_live: 'Platform live', service_live: 'Service live (self-declared)' } as const;

function formatDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * A helper line, with its links (FB-12 to FB-16). Settings links open Settings at that
 * card, in this tab; the training link opens in a new tab. A link with nowhere to go
 * (no training page set) is left out rather than shown dead.
 */
function ChecklistDetail({ detail, trainingUrl, onNavigate }: { detail: string; trainingUrl: string | null; onNavigate?: () => void }) {
  const { dispatch } = useApp();
  const openSettings = (target: SettingsLinkTarget) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    window.history.pushState(null, '', settingsHref(target, appPathPrefix));
    onNavigate?.();
    dispatch({ type: 'SET_SCREEN', screen: 'settings' });
    // Already on Settings (the prompt can sit over it): tell it to go to the new place.
    window.dispatchEvent(new CustomEvent('hhh:settings-link', { detail: target }));
  };
  return (
    <small>
      {checklistDetailSegments(detail).map((segment, index) => {
        const target = segment.target;
        if (!target) return <span key={index}>{segment.text}</span>;
        if (target.kind === 'training') {
          return trainingUrl
            ? <a key={index} href={trainingUrl} target="_blank" rel="noopener noreferrer">{segment.text} <ExternalLink size={11} aria-hidden="true" /></a>
            : null;
        }
        const place: SettingsLinkTarget = target.kind === 'pack'
          ? { section: 'assets', focus: contentPackGroupElementId(target.group) }
          : { section: target.section, focus: target.anchor };
        return <a key={index} href={settingsHref(place, appPathPrefix)} onClick={openSettings(place)}>{segment.text}</a>;
      })}
    </small>
  );
}

function ItemRow({ item, saving, demo, onToggle, onOpenWorldpayForm, worldpayDraft, trainingUrl, onNavigate }: {
  item: GoLiveChecklistItem;
  trainingUrl: string | null;
  onNavigate?: () => void;
  saving: boolean;
  demo: boolean;
  onToggle: (done: boolean) => void;
  onOpenWorldpayForm?: () => void;
  /** A Worldpay application is saved but not sent: the item reads "Continue your Worldpay application". */
  worldpayDraft?: boolean;
}) {
  const id = `go-live-item-${item.key}`;
  const doneOn = item.done ? formatDate(item.doneAt) : null;
  return (
    <li className={`go-live-checklist__item${item.done ? ' is-done' : ''}`}>
      {item.kind === 'self' ? (
        <input
          id={id}
          type="checkbox"
          checked={item.done}
          disabled={saving}
          onChange={event => onToggle(event.target.checked)}
        />
      ) : (
        <span className="go-live-checklist__mark" aria-hidden="true">
          {item.done ? <CheckCircle2 size={16} /> : item.kind === 'auto' ? <Lock size={14} /> : <Circle size={16} />}
        </span>
      )}
      <span className="go-live-checklist__text">
        {item.kind === 'self'
          ? <label htmlFor={id}>{item.label}</label>
          : <strong>{item.link === 'worldpay_form' && worldpayDraft ? 'Continue your Worldpay application' : item.label}</strong>}
        {item.detail ? <ChecklistDetail detail={item.detail} trainingUrl={trainingUrl} onNavigate={onNavigate} /> : null}
        <small className="go-live-checklist__meta">
          Owner: {ownerLabel(item.owners)}
          {item.kind === 'auto' ? ' · Ticks itself' : ''}
          {doneOn ? ` · Done ${doneOn}` : ''}
        </small>
      </span>
      {item.link === 'worldpay_form' ? (
        onOpenWorldpayForm && !demo ? (
          <button type="button" className="btn btn-sm" onClick={onOpenWorldpayForm}>
            {worldpayDraft ? 'Continue' : 'Open form'} <ExternalLink size={12} aria-hidden="true" />
          </button>
        ) : (
          <small className="go-live-checklist__hint">{demo ? 'Not sent from demo mode.' : 'Send it from the Onboarding page.'}</small>
        )
      ) : null}
    </li>
  );
}

export function GoLiveChecklistView({ checklist, saving, demo, onToggle, onOpenWorldpayForm, worldpayDraft, onNavigate }: {
  checklist: Checklist;
  /** A helper line's link moved to another screen (the login prompt closes). */
  onNavigate?: () => void;
  saving: string | null;
  demo: boolean;
  onToggle: (itemKey: string, done: boolean) => void;
  onOpenWorldpayForm?: () => void;
  worldpayDraft?: boolean;
}) {
  return (
    <div className="go-live-checklist">
      {(['required', 'optional'] as const).map(section => {
        const items = checklist.items.filter(item => item.section === section);
        const summary = sectionSummary(checklist, section);
        const groups = [...new Set(items.map(item => item.group))];
        return (
          <section key={section} className="go-live-checklist__section" aria-labelledby={`go-live-${section}`}>
            <header>
              <h4 id={`go-live-${section}`}>{SECTION_TITLES[section]}</h4>
              <span className="go-live-checklist__percent">{summary.done} of {summary.total} · {summary.percent}%</span>
            </header>
            <div className="go-live-checklist__bar" role="progressbar" aria-label={`${SECTION_TITLES[section]} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={summary.percent}>
              <span style={{ width: `${summary.percent}%` }} />
            </div>
            {groups.map(group => (
              <div key={group ?? 'all'} className="go-live-checklist__group">
                {group ? <h5>{GROUP_TITLES[group]}</h5> : null}
                <ul>
                  {items.filter(item => item.group === group).map(item => (
                    <ItemRow
                      key={item.key}
                      item={item}
                      saving={saving === item.key}
                      demo={demo}
                      onToggle={done => onToggle(item.key, done)}
                      onOpenWorldpayForm={onOpenWorldpayForm}
                      worldpayDraft={worldpayDraft}
                      trainingUrl={checklist.links?.trainingBookingUrl ?? null}
                      onNavigate={onNavigate}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

/** The checklist with its own loading and saving, for embedding (e.g. the portal Onboarding page). */
/** Whether the branch has a Worldpay application saved but not yet sent. */
function useWorldpayDraft(enabled: boolean) {
  const [draft, setDraft] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    loadWorldpayApplication({ kind: 'branch' })
      .then(view => { if (!cancelled) setDraft(view.status === 'DRAFT' && Boolean(view.id)); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [enabled]);
  return draft;
}

export default function GoLiveChecklist({ onOpenWorldpayForm }: { onOpenWorldpayForm?: () => void }) {
  const { checklist, error, saving, toggle, demo } = useGoLiveChecklist();
  const worldpayDraft = useWorldpayDraft(Boolean(onOpenWorldpayForm) && !demo);
  if (!checklist) {
    return error ? <p className="go-live-checklist__error" role="alert">{error}</p> : <p className="go-live-checklist__loading">Loading the go-live checklist…</p>;
  }
  return (
    <>
      {error ? <p className="go-live-checklist__error" role="alert">{error}</p> : null}
      <GoLiveChecklistView checklist={checklist} saving={saving} demo={demo} onToggle={(key, done) => void toggle(key, done)} onOpenWorldpayForm={onOpenWorldpayForm} worldpayDraft={worldpayDraft} />
    </>
  );
}

const PROMPT_DISMISSED_KEY = 'hhh_go_live_checklist_dismissed';

/** Dismissal lasts for this login only: the key is the staff uid plus the session's fixed expiry. */
function loginKey(staff: { uid: string; absoluteExpiresAt?: string | null }) {
  return `${staff.uid}:${staff.absoluteExpiresAt ?? ''}`;
}

function dismissedFor(key: string) {
  try {
    return globalThis.sessionStorage?.getItem(PROMPT_DISMISSED_KEY) === key;
  } catch {
    return false;
  }
}

function rememberDismissed(key: string) {
  try {
    globalThis.sessionStorage?.setItem(PROMPT_DISMISSED_KEY, key);
  } catch {
    // Storage blocked: the prompt comes back on refresh, which is harmless.
  }
}

/**
 * Shown to every user of the branch at login until the Required items are done.
 * "Remind me next time" hides it for this login; it comes back at the next sign-in.
 */
export function GoLiveChecklistPrompt({ onOpenWorldpayForm }: { onOpenWorldpayForm?: () => void }) {
  const { state: authState } = useAuth();
  const staff = authState.phase === 'authenticated' ? authState.staff : null;
  const key = staff ? loginKey(staff) : null;
  const [dismissed, setDismissed] = useState(() => (key ? dismissedFor(key) : true));
  const { checklist, error, saving, toggle, demo } = useGoLiveChecklist();
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const open = Boolean(staff?.role === 'pharmacy_staff' && key && !dismissed && checklist && !checklist.requiredComplete);

  useEffect(() => { setDismissed(key ? dismissedFor(key) : true); }, [key]);
  useEffect(() => { if (open) closeButton.current?.focus(); }, [open]);

  const dismiss = useCallback(() => {
    if (key) rememberDismissed(key);
    setDismissed(true);
  }, [key]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dismiss, open]);

  if (!open || !checklist) return null;
  return (
    <div className="go-live-prompt__scrim" onClick={event => { if (event.target === event.currentTarget) dismiss(); }}>
      <section className="go-live-prompt" role="dialog" aria-modal="true" aria-labelledby="go-live-prompt-title">
        <header>
          <div>
            <h3 id="go-live-prompt-title">Go-live checklist</h3>
            <p>{checklist.percent}% done. Tick what your pharmacy has done; nothing on the platform waits on this list.</p>
          </div>
          <button ref={closeButton} type="button" className="btn btn-sm" aria-label="Close the go-live checklist" onClick={dismiss}><X size={14} /></button>
        </header>
        {error ? <p className="go-live-checklist__error" role="alert">{error}</p> : null}
        <GoLiveChecklistView checklist={checklist} saving={saving} demo={demo} onToggle={(itemKey, done) => void toggle(itemKey, done)} onOpenWorldpayForm={onOpenWorldpayForm} onNavigate={dismiss} />
        <footer>
          <button type="button" className="btn btn-primary btn-sm" onClick={dismiss}>Remind me next time</button>
        </footer>
      </section>
    </div>
  );
}
