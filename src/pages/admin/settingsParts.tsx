import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { isLocalPortalPreview } from '../../dev/localPortalPreview';
import { ApiRequestError, type EmailPreviewView } from '../../shared/api';
import { flagLabel, unknownFields, type TemplateBlock } from './templateBlocks';

/** Shared by the Onboarding settings editors: merge-field buttons, paragraph blocks and email previews. */

// ---------------------------------------------------------------------------
// Inserting a merge field where the cursor last was.

type Insertable = HTMLInputElement | HTMLTextAreaElement;
type InsertTarget = { element: Insertable; apply: (value: string) => void };

export function useInsertTarget() {
  const target = useRef<InsertTarget | null>(null);
  const track = (apply: (value: string) => void) => ({
    onFocus: (event: React.FocusEvent<Insertable>) => { target.current = { element: event.currentTarget, apply }; },
  });
  const insert = (token: string) => {
    const current = target.current;
    if (!current || !current.element.isConnected) return;
    const { element, apply } = current;
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? start;
    const next = element.value.slice(0, start) + token + element.value.slice(end);
    apply(next);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return { track, insert };
}

export function FieldChips({ fields, onInsert, inline = false }: { fields: string[]; onInsert: (token: string) => void; inline?: boolean }) {
  if (!fields.length) return null;
  return (
    <div className={`onb-settings__chips${inline ? ' is-inline' : ''}`} role="group" aria-label="Insert a merge field">
      <span>Insert</span>
      {fields.map(field => (
        <button key={field} type="button" onMouseDown={event => event.preventDefault()} onClick={() => onInsert(`[${field}]`)}>
          {field}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Email pieces.

export function EmailPreview({ subject, paragraphs, fromName }: { subject: string; paragraphs: string[]; fromName: string }) {
  return (
    <div className="onb-mail" aria-label="Email preview">
      <div className="onb-mail__meta">
        <span><small>From</small>{fromName}</span>
        <span><small>Subject</small><strong>{subject || 'No subject'}</strong></span>
      </div>
      <div className="onb-mail__canvas">
        <div className="onb-mail__card">
          <div className="onb-mail__header"><img src="/email/hhh-logo.png" alt="Holistic Health Hub" /></div>
          <div className="onb-mail__body">
            <h1>{subject}</h1>
            {paragraphs.map((paragraph, index) => {
              // The same rule the sent email uses to set a short line as a heading.
              const heading = index > 0 && !paragraph.includes('\n') && paragraph.length <= 60 && !/[.,:;!?)]$/.test(paragraph) && !paragraph.startsWith('-');
              return heading ? <h2 key={index}>{paragraph}</h2> : <p key={index}>{paragraph}</p>;
            })}
          </div>
          <div className="onb-mail__footer">Powered by Holistic Health Hub × Curaleaf Clinic</div>
        </div>
      </div>
    </div>
  );
}

export function BlockEditor({
  block,
  fields,
  flags,
  track,
  onChange,
  onRemove,
}: {
  block: TemplateBlock;
  fields: string[];
  flags: string[];
  track: ReturnType<typeof useInsertTarget>['track'];
  onChange: (next: TemplateBlock) => void;
  onRemove: () => void;
}) {
  const unknown = unknownFields(block.text, fields);
  // A condition in the middle of a sentence stays as typed; say what it does.
  const inline = block.flag ? [] : [...new Set([...block.text.matchAll(/\[If ([^\]]+)\]/gi)].map(match => match[1]!.trim()))];
  const rows = Math.min(14, Math.max(2, block.text.split('\n').length + Math.ceil(block.text.length / 80)));
  return (
    <div className={`onb-block${block.flag ? ' is-conditional' : ''}`}>
      {block.flag ? (
        <div className="onb-block__when">
          <span>Only when</span>
          <select value={block.flag} onChange={event => onChange({ ...block, flag: event.target.value })} aria-label="Shown only when">
            {[...new Set([block.flag, ...flags])].map(flag => <option key={flag} value={flag}>{flagLabel(flag)}</option>)}
          </select>
        </div>
      ) : null}
      <div className="onb-block__row">
        <textarea
          className="input"
          rows={rows}
          value={block.text}
          aria-label={block.flag ? `Paragraph shown only when ${flagLabel(block.flag)}` : 'Paragraph'}
          onChange={event => onChange({ ...block, text: event.target.value })}
          {...track(value => onChange({ ...block, text: value }))}
        />
        <button type="button" className="onb-block__remove" onClick={onRemove} aria-label="Remove this paragraph" title="Remove this paragraph">
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
      {inline.length ? (
        <p className="onb-block__note">
          Text between <code>[If …]</code> and <code>[/If]</code> shows only when: {inline.map(flag => flagLabel(flag)).join('; ')}.
        </p>
      ) : null}
      {unknown.length ? (
        <p className="onb-block__warn">
          Not a merge field for this email, so it is sent as typed: {unknown.map(name => <code key={name}>[{name}]</code>)}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The preview drawn by the server's own email renderer.

/**
 * Asks the server to draw the email as it would be sent, a moment after typing stops.
 * Local preview has no API, so it returns null and the editor shows its own sketch.
 */
export function useServerPreview(load: (() => Promise<EmailPreviewView>) | null, key: string) {
  const [state, setState] = useState<{ view: EmailPreviewView | null; error: string | null; loading: boolean }>({ view: null, error: null, loading: false });
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (isLocalPortalPreview || !loadRef.current) return;
    let cancelled = false;
    setState(current => ({ ...current, loading: true }));
    const timer = window.setTimeout(() => {
      loadRef.current!()
        .then(view => { if (!cancelled) setState({ view, error: null, loading: false }); })
        .catch(error => {
          if (!cancelled) setState(current => ({ ...current, error: error instanceof ApiRequestError ? error.message : 'The preview could not be drawn.', loading: false }));
        });
    }, 450);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [key]);
  return isLocalPortalPreview ? null : state;
}

/** The server's HTML in a sandboxed frame, sized to its content. */
export function RenderedEmail({ view, fromName, loading, error }: { view: EmailPreviewView; fromName: string; loading: boolean; error: string | null }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(900);
  const fit = () => {
    const body = frame.current?.contentDocument?.body;
    if (body) setHeight(Math.max(400, body.scrollHeight + 8));
  };
  return (
    <div className={`onb-mail${loading ? ' is-loading' : ''}`} aria-label="Email preview">
      <div className="onb-mail__meta">
        <span><small>From</small>{fromName}</span>
        <span><small>Subject</small><strong>{view.subject}</strong></span>
        {error ? <span className="onb-block__warn">{error} Showing the last good preview.</span> : null}
      </div>
      <iframe
        ref={frame}
        title="Email preview"
        className="onb-mail__frame"
        sandbox="allow-same-origin"
        srcDoc={view.html}
        style={{ height }}
        onLoad={fit}
      />
    </div>
  );
}

/** Preview switches: each button picks one real situation. */
export type Scenario<T> = { label: string; options: Array<{ label: string; value: T }> };

export function ScenarioSwitches<T>({ scenarios, choices, onChoose }: { scenarios: Scenario<T>[]; choices: number[]; onChoose: (index: number, option: number) => void }) {
  if (!scenarios.length) return null;
  return (
    <div className="onb-settings__scenarios" aria-label="Preview as">
      {scenarios.map((scenario, index) => (
        <div key={scenario.label} className="onb-settings__scenario" role="radiogroup" aria-label={scenario.label}>
          <span>{scenario.label}</span>
          <div>
            {scenario.options.map((option, optionIndex) => (
              <button
                key={option.label}
                type="button"
                role="radio"
                aria-checked={(choices[index] ?? 0) === optionIndex}
                className={(choices[index] ?? 0) === optionIndex ? 'is-active' : undefined}
                onClick={() => onChoose(index, optionIndex)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
