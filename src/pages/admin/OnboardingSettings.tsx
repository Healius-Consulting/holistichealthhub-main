import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Plus, RotateCcw, Search, X } from 'lucide-react';
import {
  ApiRequestError,
  getEmailCopy,
  getOnboardingContent,
  previewEmailCopy,
  previewOnboardingEmail,
  saveEmailCopy,
  saveOnboardingContent,
  type EditableEmailCode,
  type EmailCopyOverrides,
  type EmailCopySlot,
  type OnboardingContent,
  type OnboardingContentKey,
  type OnboardingContentView,
  type OnboardingEmailKind,
  type OnboardingHoldReason,
} from '../../shared/api';
import {
  HOLD_REASON_LABEL,
  ONBOARDING_CONTENT_DEFAULTS,
  ONBOARDING_EMAIL_MERGE_HELP,
  ONBOARDING_HOLD_REASONS,
} from '../../../services/api-sql/src/domain/pharmacy-onboarding/content.ts';
import { mergeSubject, mergeTemplate } from '../../../services/api-sql/src/domain/common/content-template.ts';
import { isLocalPortalPreview } from '../../dev/localPortalPreview';
import { OnboardingHoldPage } from '../../onboarding/OnboardingHold';
import { OnboardingAwaitingPage } from '../../onboarding/OnboardingAwaiting';
import {
  EMAIL_COPY_SLOT_HINT,
  EMAIL_COPY_SLOT_LABEL,
  EMAIL_COPY_SPECS,
  MULTILINE_SLOTS,
  editableSlots,
  mergeCopy,
  mergeCopyLine,
  type EmailCopySpec,
} from '../../../services/api-sql/src/domain/notifications/email-copy.ts';
import { DemoPharmaciesPanel } from './DemoPharmaciesPanel';
import { PartnerTermsPanel } from './PartnerTermsPanel';
import { WorldpayApplicationsPanel, WorldpayWordingPanel } from './WorldpayAdminPanels';
import { flagLabel, newBlock, normalizeTemplate, parseTemplate, serializeTemplate, unknownFields, type TemplateBlock } from './templateBlocks';
import { BlockEditor, EmailPreview, FieldChips, RenderedEmail, ScenarioSwitches, useInsertTarget, useServerPreview, type Scenario } from './settingsParts';
import '../../styles/onboarding-admin.css';
import '../../styles/onboarding-settings.css';

/**
 * HHH admin: everything about partner onboarding that changes without a release, in
 * one place. Emails are edited beside a preview of what the pharmacy receives, with
 * merge fields as buttons and each conditional paragraph as its own block; the hold
 * page beside the page itself. Worldpay applications and demo pharmacies live here too.
 */

export type SettingsSection =
  | `email:${OnboardingEmailKind}`
  | `copy:${EditableEmailCode}`
  | 'holdPage'
  | 'awaitingPage'
  | 'worldpay'
  | 'worldpayWording'
  | 'demo'
  | 'addresses'
  | 'terms';

type NavItem = { id: SettingsSection; label: string; keys: OnboardingContentKey[]; copy?: EditableEmailCode };

const copyItem = (code: EditableEmailCode): NavItem => ({ id: `copy:${code}`, label: (EMAIL_COPY_SPECS[code] as EmailCopySpec).name, keys: [], copy: code });
const copyItems = (group: EmailCopySpec['group']) => (Object.keys(EMAIL_COPY_SPECS) as EditableEmailCode[])
  .filter(code => (EMAIL_COPY_SPECS[code] as EmailCopySpec).group === group)
  .map(copyItem);

/** Every email the platform sends, and the pages a pharmacy sees while it waits. */
const NAV: Array<{ group: string; items: NavItem[] }> = [
  {
    group: 'Pharmacy pages',
    items: [
      { id: 'awaitingPage', label: 'Awaiting activation page', keys: ['awaitingPage'] },
      { id: 'holdPage', label: 'Hold page', keys: ['holdPage'] },
    ],
  },
  {
    group: 'Partner onboarding emails',
    items: [
      { id: 'email:sent', label: 'Application sent', keys: ['sent'] },
      { id: 'email:activation', label: 'Ready to try', keys: ['activation'] },
      { id: 'email:hold', label: 'On hold', keys: ['hold'] },
      { id: 'email:live', label: 'Live', keys: ['live'] },
      { id: 'email:curaleafApplication', label: 'Application to Curaleaf', keys: ['curaleafApplication'] },
    ],
  },
  { group: 'Patient emails', items: copyItems('patient') },
  { group: 'Pharmacy emails', items: copyItems('pharmacy') },
  { group: 'Staff sign-in emails', items: copyItems('staff') },
  {
    group: 'Admin emails',
    items: [...copyItems('admin'), { id: 'worldpayWording', label: 'Worldpay application (WP-01)', keys: [] }],
  },
  {
    group: 'Worldpay',
    items: [
      { id: 'worldpay', label: 'Applications', keys: [] },
      { id: 'worldpayWording', label: 'Emails and wording', keys: [] },
    ],
  },
  {
    group: 'Setup',
    items: [
      { id: 'demo', label: 'Demo pharmacies', keys: [] },
      { id: 'addresses', label: 'Addresses and links', keys: ['addresses', 'links'] },
      { id: 'terms', label: 'Partner Terms', keys: [] },
    ],
  },
];

const EMAIL_WHEN: Record<OnboardingEmailKind, string> = {
  sent: 'Sent to the branch’s address and the person who signed when the Curaleaf application goes: at the Curaleaf form while the Partner Terms are switched off, or when the pharmacy accepts them while they are on.',
  curaleafApplication: 'Sent to Curaleaf with the filled form attached, at the same time as Application sent (the Curaleaf form while the Terms are off, the Terms acceptance while they are on). Their replies go to the Curaleaf Reply-To.',
  activation: 'Sent once per branch when you click Activate: the account is ready to try in demonstration mode.',
  hold: 'Sent each time you put a branch on hold or change its reason. Each reason has its own paragraphs below.',
  live: 'Sent once per branch when its PHAR code and API key are saved and it goes live.',
};

/** What the preview fills merge fields with. */
const SAMPLE_FIELDS: Record<string, string> = {
  'Branch name': 'Kirkgate Pharmacy',
  'Signer first name': 'Asha',
  'Signer full name': 'Asha Shah',
  'Registered company name': 'Kirkgate Health Ltd',
  'Submission date': '19 November 2026',
  'Submission time': '10:42',
  'Acceptance date': '19 November 2026',
  'GPhC premises no.': '1123456',
  'PHAR code': 'PHAR01234',
  'Outstanding required items': '- Approve the service SOPs\n- Add the formulary to your PMR',
  'Outstanding optional items': '- Put up the posters\n- Add your logo',
};

/** The preview's switches: each picks the flags one real situation would send. */
type OnboardingScenario = { label: string; options: Array<{ label: string; flags: string[] }> };
const WORLDPAY: OnboardingScenario = { label: 'Worldpay', options: [{ label: 'Not applied', flags: ['no worldpay'] }, { label: 'Applied', flags: ['worldpay submitted'] }] };
const SCENARIOS: Record<OnboardingEmailKind, OnboardingScenario[]> = {
  sent: [WORLDPAY, { label: 'Partner Terms', options: [{ label: 'Accepted', flags: ['terms accepted'] }, { label: 'Not asked (switched off)', flags: [] }] }],
  curaleafApplication: [],
  activation: [{ label: 'Training link', options: [{ label: 'Set', flags: ['training link'] }, { label: 'Not set', flags: ['no training link'] }] }, WORLDPAY],
  hold: [
    {
      label: 'Reason',
      options: [
        { label: 'A · Existing customer', flags: ['existing curaleaf customer'] },
        { label: 'B · More information', flags: ['more information needed'] },
        { label: 'C · Curaleaf declined', flags: ['curaleaf declined'] },
      ],
    },
    { label: 'Worldpay', options: [{ label: 'Not applied', flags: [] }, { label: 'Applied', flags: ['worldpay submitted'] }] },
  ],
  live: [
    { label: 'Card payments', options: [{ label: 'Not set up', flags: ['worldpay not validated'] }, { label: 'Set up', flags: ['worldpay validated'] }] },
    { label: 'Required items', options: [{ label: 'Open', flags: ['required outstanding'] }, { label: 'All done', flags: [] }] },
    { label: 'Optional items', options: [{ label: 'Open', flags: ['optional outstanding'] }, { label: 'All done', flags: [] }] },
  ],
};

const PREVIEW_VIEW: OnboardingContentView = { content: ONBOARDING_CONTENT_DEFAULTS, mergeHelp: ONBOARDING_EMAIL_MERGE_HELP };
const message = (error: unknown, fallback: string) => (error instanceof ApiRequestError ? error.message : fallback);
const isEmailKey = (key: OnboardingContentKey): key is OnboardingEmailKind => key in ONBOARDING_EMAIL_MERGE_HELP;

/** Compares content the way it is sent, so reflowing an email in the editor is not a change. */
function sameContent(key: OnboardingContentKey, a: unknown, b: unknown) {
  if (isEmailKey(key)) {
    const left = a as { subject: string; body: string };
    const right = b as { subject: string; body: string };
    return left.subject.trim() === right.subject.trim() && normalizeTemplate(left.body) === normalizeTemplate(right.body);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// The onboarding email editor.

function EmailEditor({
  kind,
  value,
  content,
  version,
  onChange,
}: {
  kind: OnboardingEmailKind;
  value: { subject: string; body: string };
  content: OnboardingContent;
  /** Bumped when the saved text replaces the editor's (load, save, undo). */
  version: number;
  onChange: (next: { subject: string; body: string }) => void;
}) {
  const { fields, flags } = ONBOARDING_EMAIL_MERGE_HELP[kind];
  const [blocks, setBlocks] = useState<TemplateBlock[]>(() => parseTemplate(value.body));
  const [choices, setChoices] = useState<number[]>(() => SCENARIOS[kind].map(() => 0));
  const [adding, setAdding] = useState('');
  const { track, insert } = useInsertTarget();
  // Re-read the body when another source replaces it; typing here never does.
  useEffect(() => { setBlocks(parseTemplate(value.body)); }, [kind, version]);

  const update = (next: TemplateBlock[]) => {
    setBlocks(next);
    onChange({ ...value, body: serializeTemplate(next) });
  };
  const setBlock = (id: string, next: TemplateBlock) => update(blocks.map(block => (block.id === id ? next : block)));

  const previewFields = {
    ...SAMPLE_FIELDS,
    'Terms version': 'v1.0',
    'Training booking link': content.links.trainingBookingUrl || 'https://calendly.com/…',
  };
  const activeFlags = Object.fromEntries(SCENARIOS[kind].flatMap((scenario, index) => scenario.options[choices[index] ?? 0]!.flags.map(flag => [flag, true])));
  const subject = mergeSubject(value.subject, previewFields);
  const paragraphs = mergeTemplate(serializeTemplate(blocks), previewFields, activeFlags);
  const subjectUnknown = unknownFields(value.subject, fields);
  const fromName = kind === 'curaleafApplication' ? `${content.addresses.displayName}, to Curaleaf` : content.addresses.displayName;
  // The server draws the real email from the same merged wording; until it answers (or locally) the sketch shows.
  const server = useServerPreview(
    () => previewOnboardingEmail(kind, { subject, paragraphs, fromName: content.addresses.displayName }),
    JSON.stringify([kind, subject, paragraphs, content.addresses.displayName]),
  );

  return (
    <div className="onb-settings__split">
      <div className="onb-settings__editor">
        <p className="onb-settings__when">{EMAIL_WHEN[kind]}</p>
        <label className="wpa-field">
          <span className="wpa-field__label">Subject</span>
          <input
            className="input"
            value={value.subject}
            onChange={event => onChange({ ...value, subject: event.target.value })}
            {...track(next => onChange({ ...value, subject: next }))}
          />
          {subjectUnknown.length ? <span className="onb-block__warn">Not a merge field for this email: {subjectUnknown.map(name => <code key={name}>[{name}]</code>)}</span> : null}
        </label>
        <div className="onb-settings__blocks">
          <span className="wpa-field__label">Message</span>
          {blocks.map((block, index) => (
            <BlockEditor
              key={block.id}
              block={block}
              fields={fields}
              flags={flags}
              track={track}
              onChange={next => setBlock(block.id, next)}
              onRemove={() => update(blocks.filter((_, at) => at !== index))}
            />
          ))}
          <div className="onb-settings__add">
            <button type="button" className="btn btn-sm" onClick={() => update([...blocks, newBlock()])}><Plus size={13} aria-hidden="true" /> Paragraph</button>
            {flags.length ? (
              <select
                className="input"
                value={adding}
                aria-label="Add a paragraph shown only when"
                onChange={event => {
                  const flag = event.target.value;
                  setAdding('');
                  if (flag) update([...blocks, newBlock(flag)]);
                }}
              >
                <option value="">+ Paragraph shown only when…</option>
                {flags.map(flag => <option key={flag} value={flag}>{flagLabel(flag)}</option>)}
              </select>
            ) : null}
          </div>
        </div>
        <FieldChips fields={fields} onInsert={insert} />
      </div>

      <div className="onb-settings__preview">
        <ScenarioSwitches
          scenarios={SCENARIOS[kind].map(scenario => ({ label: scenario.label, options: scenario.options.map(option => ({ label: option.label, value: option.flags })) }))}
          choices={choices}
          onChoose={(index, option) => setChoices(current => current.map((choice, at) => (at === index ? option : choice)))}
        />
        {server?.view
          ? <RenderedEmail view={server.view} fromName={fromName} loading={server.loading} error={server.error} />
          : <EmailPreview subject={subject} paragraphs={paragraphs} fromName={fromName} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The hold page editor.

function HoldPageEditor({ value, onChange }: { value: OnboardingContent['holdPage']; onChange: (next: OnboardingContent['holdPage']) => void }) {
  const [reason, setReason] = useState<OnboardingHoldReason>('EXISTING_CURALEAF_CUSTOMER');
  const { track, insert } = useInsertTarget();
  const paragraphs = mergeTemplate(value[reason], { 'Branch name': SAMPLE_FIELDS['Branch name']! }, {});
  const unknown = unknownFields(value[reason], ['Branch name']);
  return (
    <div className="onb-settings__split is-page">
      <div className="onb-settings__editor">
        <p className="onb-settings__when">What anyone from a pharmacy on hold sees at sign-in and from PharmSmart, in place of the forms or their account. Each reason has its own message; the heading and contact line are shared.</p>
        <div className="onb-settings__reasons" role="tablist" aria-label="Hold reason">
          {ONBOARDING_HOLD_REASONS.map(item => (
            <button key={item} type="button" role="tab" aria-selected={reason === item} className={reason === item ? 'is-active' : undefined} onClick={() => setReason(item)}>
              {HOLD_REASON_LABEL[item]}
            </button>
          ))}
        </div>
        <label className="wpa-field">
          <span className="wpa-field__label">Heading (every reason)</span>
          <input className="input" value={value.heading} onChange={event => onChange({ ...value, heading: event.target.value })} />
        </label>
        <label className="wpa-field">
          <span className="wpa-field__label">Message for {HOLD_REASON_LABEL[reason]}</span>
          <textarea
            className="input"
            rows={9}
            value={value[reason]}
            onChange={event => onChange({ ...value, [reason]: event.target.value })}
            {...track(next => onChange({ ...value, [reason]: next }))}
          />
          <span className="wpa-field__hint">A blank line starts a new paragraph.</span>
          {unknown.length ? <span className="onb-block__warn">Not a merge field here, so it shows as typed: {unknown.map(name => <code key={name}>[{name}]</code>)}</span> : null}
        </label>
        <FieldChips inline fields={['Branch name']} onInsert={insert} />
        <label className="wpa-field">
          <span className="wpa-field__label">Contact line (every reason)</span>
          <input className="input" value={value.footer} onChange={event => onChange({ ...value, footer: event.target.value })} />
          <span className="wpa-field__hint">The email address in it becomes the contact button.</span>
        </label>
      </div>
      <div className="onb-settings__preview">
        <div className="onb-settings__page" aria-label="Hold page preview">
          <OnboardingHoldPage preview hold={{ heading: value.heading, paragraphs, footer: value.footer }} person={{ name: 'Asha Shah', gphcNumber: '1123456' }} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The awaiting activation page editor.

function AwaitingPageEditor({ value, onChange }: { value: OnboardingContent['awaitingPage']; onChange: (next: OnboardingContent['awaitingPage']) => void }) {
  const { track, insert } = useInsertTarget();
  const paragraphs = mergeTemplate(value.body, { 'Branch name': SAMPLE_FIELDS['Branch name']! }, {});
  const unknown = unknownFields(value.body, ['Branch name']);
  return (
    <div className="onb-settings__split is-page">
      <div className="onb-settings__editor">
        <p className="onb-settings__when">What a pharmacy sees from PharmSmart once its forms are in, until you click Activate. The stage tracker and the Book a demo call button are added automatically.</p>
        <label className="wpa-field">
          <span className="wpa-field__label">Heading</span>
          <input className="input" value={value.heading} onChange={event => onChange({ ...value, heading: event.target.value })} />
        </label>
        <label className="wpa-field">
          <span className="wpa-field__label">Message</span>
          <textarea
            className="input"
            rows={7}
            value={value.body}
            onChange={event => onChange({ ...value, body: event.target.value })}
            {...track(next => onChange({ ...value, body: next }))}
          />
          <span className="wpa-field__hint">A blank line starts a new paragraph. The first paragraph is shown larger.</span>
          {unknown.length ? <span className="onb-block__warn">Not a merge field here, so it shows as typed: {unknown.map(name => <code key={name}>[{name}]</code>)}</span> : null}
        </label>
        <FieldChips inline fields={['Branch name']} onInsert={insert} />
        <label className="wpa-field">
          <span className="wpa-field__label">Contact line</span>
          <input className="input" value={value.footer} onChange={event => onChange({ ...value, footer: event.target.value })} />
          <span className="wpa-field__hint">The email address in it becomes the contact button.</span>
        </label>
      </div>
      <div className="onb-settings__preview">
        <div className="onb-settings__page" aria-label="Awaiting activation page preview">
          <OnboardingAwaitingPage
            preview
            message={{ heading: value.heading, paragraphs, footer: value.footer }}
            person={{ name: 'Asha Shah', gphcNumber: '1123456' }}
            account={<>Already on Holistic Health Hub? <a className="onb__signin" href="#preview">Sign in</a></>}
            bookingUrl="#preview"
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Every other email: its named pieces, each starting from today's wording.

type CopySlots = Partial<Record<EmailCopySlot, string>>;

/** The preview's switches for emails with more than one version. */
const COPY_SCENARIOS: Partial<Record<EditableEmailCode, Scenario<Record<string, string | number>>[]>> = {
  patient_enquiry_declined: [{ label: 'Version', options: [{ label: 'Not eligible', value: { variant: 'declined' } }, { label: 'Missing information', value: { variant: 'incomplete' } }, { label: 'Withdrawn', value: { variant: 'withdrawn' } }] }],
  patient_ready_for_collection: [{ label: 'Packs', options: [{ label: 'All ready', value: {} }, { label: 'Part ready', value: { partialReady: 'true', readyPacks: 2, totalPacks: 3 } }] }],
  pharmacy_order_cancelled: [{ label: 'Purchase order', options: [{ label: 'Known', value: {} }, { label: 'Not known', value: { purchaseOrderId: '' } }] }],
  pharmacy_order_dispatched: [{ label: 'Summary', options: [{ label: 'From Curaleaf', value: {} }, { label: 'None', value: { summary: '' } }] }],
  pharmacy_collection_completed: [{ label: 'Summary', options: [{ label: 'Given', value: {} }, { label: 'None', value: { summary: '' } }] }],
  pharmacy_staff_invite: [{ label: 'Invite for', options: [{ label: 'A pharmacy', value: {} }, { label: 'An HHH admin', value: { pharmacyName: '' } }] }],
};

/** Local preview only (no API): what merge fields show in the sketch. */
const COPY_SAMPLE_FIELDS: Record<string, string> = {
  'First name': 'Sam', 'Pharmacy name': 'Kirkgate Pharmacy', 'Pharmacy address': '12 Kirkgate, Leeds, LS1 6BY', 'Pharmacy GPhC': '1123456',
  'Order number': 'ORD-MWDPQ7RK-6EDC74', Amount: '£142.50', 'Case reference': 'HHH-24817', Summary: 'One line is out of stock.',
  'Ready packs': '2', 'Total packs': '3', 'Purchase order': 'cd46befd-8fea-46ec', 'Patient name': 'Sam Taylor',
  Clinic: 'Curaleaf Clinic', 'Clinic email': 'enquiries@curaleafclinic.com', 'Clinic phone': '020 7459 4075', 'Clinic hours': 'Monday to Friday, 8am to 5pm',
  'Clinic sign-in link': 'https://app.curaleafclinic.com/sign-in/', Labs: 'Curaleaf Labs', 'Labs phone': '0191 743 1007', 'Labs hours': 'Mon–Fri 08:00–17:00',
  'Help email': 'IT@holistichealthhub.live', Pharmacy: 'Kirkgate Pharmacy', Prescriber: 'Dr. Prescriber', 'Order count': '2', 'Orders word': 'orders', Days: '6',
};
const COPY_SAMPLE_FLAGS: Record<string, boolean> = {
  amount: true, 'order number': true, 'case reference': true, summary: true, 'all ready': true, 'purchase order': true, 'patient name': true, 'pharmacy named': true, declined: true,
};

/** The full wording of an email: its saved pieces over today's. */
export function fullCopy(code: EditableEmailCode, saved: EmailCopyOverrides | null): CopySlots {
  const spec = EMAIL_COPY_SPECS[code] as EmailCopySpec;
  return { ...spec.defaults, ...(saved?.[code] ?? {}) };
}

/** Only the pieces that differ from today's wording are saved; the rest stay the code's. */
export function editedPieces(code: EditableEmailCode, value: CopySlots): CopySlots {
  const defaults = (EMAIL_COPY_SPECS[code] as EmailCopySpec).defaults;
  const out: CopySlots = {};
  for (const slot of editableSlots(code)) {
    const text = value[slot] ?? '';
    if (text.trim() && normalizeTemplate(text) !== normalizeTemplate(defaults[slot] ?? '')) out[slot] = text;
  }
  return out;
}

function sameCopy(code: EditableEmailCode, a: CopySlots, b: CopySlots) {
  return editableSlots(code).every(slot => normalizeTemplate(a[slot] ?? '') === normalizeTemplate(b[slot] ?? ''));
}

/** A multi-paragraph piece as blocks: plain paragraphs, and "shown only when" ones. */
function BlocksField({
  label,
  hint,
  value,
  fields,
  flags,
  version,
  addLabel,
  track,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  fields: string[];
  flags: string[];
  version: number;
  addLabel: string;
  track: ReturnType<typeof useInsertTarget>['track'];
  onChange: (next: string) => void;
}) {
  const [blocks, setBlocks] = useState<TemplateBlock[]>(() => parseTemplate(value));
  const [adding, setAdding] = useState('');
  useEffect(() => { setBlocks(parseTemplate(value)); }, [version]);
  const update = (next: TemplateBlock[]) => {
    setBlocks(next);
    onChange(serializeTemplate(next));
  };
  return (
    <div className="onb-settings__blocks">
      <span className="wpa-field__label">{label}</span>
      {hint ? <span className="wpa-field__hint">{hint}</span> : null}
      {blocks.map((block, index) => (
        <BlockEditor
          key={block.id}
          block={block}
          fields={fields}
          flags={flags}
          track={track}
          onChange={next => update(blocks.map(item => (item.id === block.id ? next : item)))}
          onRemove={() => update(blocks.filter((_, at) => at !== index))}
        />
      ))}
      <div className="onb-settings__add">
        <button type="button" className="btn btn-sm" onClick={() => update([...blocks, newBlock()])}><Plus size={13} aria-hidden="true" /> {addLabel}</button>
        {flags.length ? (
          <select
            className="input"
            value={adding}
            aria-label={`Add a ${addLabel.toLowerCase()} shown only when`}
            onChange={event => {
              const flag = event.target.value;
              setAdding('');
              if (flag) update([...blocks, newBlock(flag)]);
            }}
          >
            <option value="">+ {addLabel} shown only when…</option>
            {flags.map(flag => <option key={flag} value={flag}>{flagLabel(flag)}</option>)}
          </select>
        ) : null}
      </div>
    </div>
  );
}

function CopyEmailEditor({
  code,
  value,
  version,
  fromName,
  onChange,
  onReset,
}: {
  code: EditableEmailCode;
  value: CopySlots;
  version: number;
  fromName: string;
  onChange: (next: CopySlots) => void;
  onReset: (slot: EmailCopySlot) => void;
}) {
  const spec = EMAIL_COPY_SPECS[code] as EmailCopySpec;
  const flags = Object.keys(spec.flags ?? {});
  const scenarios = COPY_SCENARIOS[code] ?? [];
  const [choices, setChoices] = useState<number[]>(() => scenarios.map(() => 0));
  const { track, insert } = useInsertTarget();
  const edited = editedPieces(code, value);
  const sample = Object.assign({}, ...scenarios.map((scenario, index) => scenario.options[choices[index] ?? 0]!.value)) as Record<string, string | number>;
  const server = useServerPreview(() => previewEmailCopy(code, edited, sample), JSON.stringify([code, edited, sample]));
  const set = (slot: EmailCopySlot, text: string) => onChange({ ...value, [slot]: text });

  const resetButton = (slot: EmailCopySlot) => (edited[slot] !== undefined ? (
    <button type="button" className="onb-settings__reset" onClick={() => onReset(slot)} title="Go back to the original wording">
      <RotateCcw size={12} aria-hidden="true" /> Original
    </button>
  ) : null);

  const sketch = () => {
    const line = (slot: EmailCopySlot) => mergeCopyLine(value[slot] ?? '', COPY_SAMPLE_FIELDS, COPY_SAMPLE_FLAGS);
    const paragraphs = mergeCopy([value.body, value.steps, value.footer].filter(Boolean).join('\n\n'), COPY_SAMPLE_FIELDS, COPY_SAMPLE_FLAGS).map(text => text.replace(/\*\*/g, ''));
    return <EmailPreview subject={spec.subjectPrefix ? `Kirkgate Pharmacy: ${line('subject')}` : line('subject')} paragraphs={[line('title'), ...paragraphs].filter(Boolean)} fromName={fromName} />;
  };

  return (
    <div className="onb-settings__split">
      <div className="onb-settings__editor">
        <p className="onb-settings__when">{spec.when}</p>
        {Object.keys(edited).length ? <p className="onb-settings__edited">Edited: {Object.keys(edited).map(slot => EMAIL_COPY_SLOT_LABEL[slot as EmailCopySlot]).join(', ')}. Everything else is the original wording.</p> : null}
        {editableSlots(code).map(slot => (MULTILINE_SLOTS.has(slot) ? (
          <div key={slot} className="onb-settings__slot">
            {resetButton(slot)}
            <BlocksField
              label={EMAIL_COPY_SLOT_LABEL[slot]}
              hint={slot === 'steps' && spec.stepTitles ? 'A blank line starts a new step. The first line of each step is its title.' : EMAIL_COPY_SLOT_HINT[slot]}
              value={value[slot] ?? ''}
              fields={spec.fields}
              flags={flags}
              version={version}
              addLabel={slot === 'steps' ? 'Step' : 'Paragraph'}
              track={track}
              onChange={text => set(slot, text)}
            />
          </div>
        ) : (
          <label key={slot} className="wpa-field onb-settings__slot">
            <span className="wpa-field__label">{EMAIL_COPY_SLOT_LABEL[slot]}{slot === 'subject' && spec.subjectPrefix ? <small> (after the pharmacy’s name)</small> : null}</span>
            {resetButton(slot)}
            <input className="input" value={value[slot] ?? ''} onChange={event => set(slot, event.target.value)} {...track(next => set(slot, next))} />
            {EMAIL_COPY_SLOT_HINT[slot] ? <span className="wpa-field__hint">{EMAIL_COPY_SLOT_HINT[slot]}</span> : null}
            {unknownFields(value[slot] ?? '', spec.fields).length ? <span className="onb-block__warn">Not a merge field for this email: {unknownFields(value[slot] ?? '', spec.fields).map(name => <code key={name}>[{name}]</code>)}</span> : null}
          </label>
        )))}
        <p className="wpa-field__hint">{spec.signature ? 'The pharmacy’s signature and its legal footer are added automatically. ' : ''}Buttons’ links, amounts and order or patient details are filled in automatically.</p>
        <FieldChips fields={spec.fields} onInsert={insert} />
      </div>
      <div className="onb-settings__preview">
        <ScenarioSwitches scenarios={scenarios} choices={choices} onChoose={(index, option) => setChoices(current => current.map((choice, at) => (at === index ? option : choice)))} />
        {server?.view ? <RenderedEmail view={server.view} fromName={fromName} loading={server.loading} error={server.error} /> : server?.error ? <p className="wpa-banner is-red">{server.error}</p> : server ? <p className="wpa-muted">Drawing the preview…</p> : sketch()}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The window.

export function OnboardingSettings({ open, section: requested, onClose }: { open: boolean; section?: SettingsSection | null; onClose: () => void }) {
  const titleId = useId();
  const [section, setSection] = useState<SettingsSection>(requested ?? 'email:sent');
  const [view, setView] = useState<OnboardingContentView | null>(null);
  const [draft, setDraft] = useState<OnboardingContent | null>(null);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<OnboardingContentKey | null>(null);
  const [copySaved, setCopySaved] = useState<EmailCopyOverrides | null>(null);
  const [copyDraft, setCopyDraft] = useState<Partial<Record<EditableEmailCode, CopySlots>>>({});
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copyBusy, setCopyBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const closeRef = useRef(onClose);

  const load = useCallback(() => {
    setError(null);
    setCopyError(null);
    setCopyDraft({});
    if (isLocalPortalPreview) {
      setView(PREVIEW_VIEW);
      setDraft(PREVIEW_VIEW.content);
      setCopySaved({});
      setVersion(current => current + 1);
      return;
    }
    getEmailCopy()
      .then(result => { setCopySaved(result.copy); setVersion(current => current + 1); })
      .catch(cause => setCopyError(message(cause, 'The email wording could not be loaded.')));
    getOnboardingContent()
      .then(result => { setView(result); setDraft(result.content); setVersion(current => current + 1); })
      .catch(cause => setError(message(cause, 'The onboarding content could not be loaded.')));
  }, []);
  useEffect(() => {
    if (!open) return;
    setNotice(null);
    if (requested) setSection(requested);
    load();
  }, [open, requested, load]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const dirtyKeys = useMemo(() => (view && draft
    ? (Object.keys(draft) as OnboardingContentKey[]).filter(key => !sameContent(key, draft[key], view.content[key]))
    : []), [view, draft]);
  const copyDirty = (code: EditableEmailCode) => Boolean(copyDraft[code]) && !sameCopy(code, copyDraft[code]!, fullCopy(code, copySaved));
  const anyCopyDirty = (Object.keys(copyDraft) as EditableEmailCode[]).some(copyDirty);
  const close = () => {
    if ((dirtyKeys.length || anyCopyDirty) && !window.confirm('Close without saving your changes?')) return;
    onClose();
  };
  closeRef.current = close;
  if (!open) return null;

  const isDirty = (key: OnboardingContentKey) => dirtyKeys.includes(key);
  const set = <K extends OnboardingContentKey>(key: K, value: OnboardingContent[K]) => {
    setDraft(current => (current ? { ...current, [key]: value } : current));
    setNotice(null);
  };
  const save = async (key: OnboardingContentKey, label: string) => {
    if (!draft || !view) return;
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const next = isLocalPortalPreview
        ? { ...view, content: { ...view.content, [key]: draft[key] } }
        : await saveOnboardingContent(key, draft[key]);
      setView(next);
      // Keep unsaved edits elsewhere; take the server's version of this one.
      setDraft(current => (current ? { ...current, [key]: next.content[key] } : next.content));
      setVersion(current => current + 1);
      setNotice(`${label} saved. The next email or page uses it.`);
    } catch (cause) {
      setError(message(cause, `${label} could not be saved.`));
    } finally {
      setBusy(null);
    }
  };
  const revert = (keys: OnboardingContentKey[]) => {
    if (!view) return;
    setDraft(current => (current ? keys.reduce((next, key) => ({ ...next, [key]: view.content[key] }), current) : current));
    setVersion(current => current + 1);
  };

  const saveCopy = async (code: EditableEmailCode) => {
    const value = copyDraft[code];
    if (!value) return;
    const pieces = editedPieces(code, value);
    setCopyBusy(true);
    setCopyError(null);
    setNotice(null);
    try {
      const next = isLocalPortalPreview
        ? { copy: { ...(copySaved ?? {}), [code]: pieces } }
        : await saveEmailCopy(code, pieces);
      setCopySaved(next.copy);
      setCopyDraft(current => {
        const rest = { ...current };
        delete rest[code];
        return rest;
      });
      setVersion(current => current + 1);
      setNotice(Object.keys(pieces).length ? 'Saved. The next email sent uses it.' : 'Saved: this email is back to its original wording.');
    } catch (cause) {
      setCopyError(message(cause, 'The wording could not be saved.'));
    } finally {
      setCopyBusy(false);
    }
  };
  const undoCopy = (code: EditableEmailCode) => {
    setCopyDraft(current => {
      const rest = { ...current };
      delete rest[code];
      return rest;
    });
    setVersion(current => current + 1);
  };

  const item = NAV.flatMap(group => group.items).find(entry => entry.id === section) ?? NAV[0]!.items[0]!;
  const saveBar = (keys: OnboardingContentKey[], label: string) => {
    const dirty = keys.some(isDirty);
    return (
      <div className={`onb-settings__savebar${dirty ? ' is-dirty' : ''}`}>
        <span>{dirty ? 'Unsaved changes' : notice ?? 'Saved. Changes apply to the next email sent or page shown.'}</span>
        {dirty ? <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => revert(keys)}>Undo</button> : null}
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={busy !== null || !dirty}
          onClick={() => void Promise.all(keys.filter(isDirty).map(key => save(key, label)))}
        >
          {busy && keys.includes(busy) ? 'Saving…' : 'Save'}
        </button>
      </div>
    );
  };

  const body = (): ReactNode => {
    if (section === 'worldpay') return <WorldpayApplicationsPanel />;
    if (section === 'worldpayWording') return <WorldpayWordingPanel />;
    if (section === 'demo') return <DemoPharmaciesPanel />;
    if (section === 'terms') return <PartnerTermsPanel />;
    if (section.startsWith('copy:')) {
      const code = section.slice('copy:'.length) as EditableEmailCode;
      if (!copySaved) {
        return copyError ? <button type="button" className="btn btn-sm" onClick={load}>Try again</button> : <p className="wpa-muted">Loading…</p>;
      }
      const value = copyDraft[code] ?? fullCopy(code, copySaved);
      const dirty = copyDirty(code);
      const editedCount = Object.keys(copySaved[code] ?? {}).length;
      return (
        <>
          <CopyEmailEditor
            key={code}
            code={code}
            value={value}
            version={version}
            fromName="Holistic Health Hub"
            onChange={next => { setCopyDraft(current => ({ ...current, [code]: next })); setNotice(null); }}
            onReset={slot => {
              setCopyDraft(current => ({ ...current, [code]: { ...value, [slot]: (EMAIL_COPY_SPECS[code] as EmailCopySpec).defaults[slot] } }));
              setVersion(current => current + 1);
            }}
          />
          <div className={`onb-settings__savebar${dirty ? ' is-dirty' : ''}`}>
            <span>{dirty ? 'Unsaved changes' : notice ?? (editedCount ? 'Saved. The next email sent uses this wording.' : 'This email uses its original wording.')}</span>
            {dirty ? <button type="button" className="btn btn-sm" disabled={copyBusy} onClick={() => undoCopy(code)}>Undo</button> : null}
            <button type="button" className="btn btn-primary btn-sm" disabled={copyBusy || !dirty} onClick={() => void saveCopy(code)}>{copyBusy ? 'Saving…' : 'Save'}</button>
          </div>
        </>
      );
    }
    if (!view || !draft) {
      return error ? <button type="button" className="btn btn-sm" onClick={load}>Try again</button> : <p className="wpa-muted">Loading…</p>;
    }
    if (section.startsWith('email:')) {
      const kind = section.slice('email:'.length) as OnboardingEmailKind;
      return (
        <>
          <EmailEditor key={kind} kind={kind} value={draft[kind]} content={draft} version={version} onChange={next => set(kind, next)} />
          {saveBar([kind], item.label)}
        </>
      );
    }
    if (section === 'awaitingPage') {
      return (
        <>
          <AwaitingPageEditor value={draft.awaitingPage} onChange={next => set('awaitingPage', next)} />
          {saveBar(['awaitingPage'], 'Awaiting activation page')}
        </>
      );
    }
    if (section === 'holdPage') {
      return (
        <>
          <HoldPageEditor value={draft.holdPage} onChange={next => set('holdPage', next)} />
          {saveBar(['holdPage'], 'Hold page')}
        </>
      );
    }
    if (section === 'addresses') {
      const { addresses, links } = draft;
      return (
        <>
          <div className="onb-settings__form">
            <h3>Sending addresses</h3>
            <p className="onb-settings__when">The mailboxes replies reach. Both must be monitored.</p>
            <label className="wpa-field"><span className="wpa-field__label">Pharmacy Reply-To</span><input className="input" type="email" value={addresses.pharmacyReplyTo} onChange={event => set('addresses', { ...addresses, pharmacyReplyTo: event.target.value })} /><span className="wpa-field__hint">From and Reply-To on every email to the pharmacy.</span></label>
            <label className="wpa-field"><span className="wpa-field__label">Curaleaf Reply-To</span><input className="input" type="email" value={addresses.curaleafReplyTo} onChange={event => set('addresses', { ...addresses, curaleafReplyTo: event.target.value })} /><span className="wpa-field__hint">Reply-To on the application to Curaleaf: their queries come back here.</span></label>
            <label className="wpa-field"><span className="wpa-field__label">Sender name</span><input className="input" value={addresses.displayName} onChange={event => set('addresses', { ...addresses, displayName: event.target.value })} /></label>
            <h3>Training booking link</h3>
            <label className="wpa-field"><span className="wpa-field__label">Link</span><input className="input" type="url" value={links.trainingBookingUrl} placeholder="https://" onChange={event => set('links', { ...links, trainingBookingUrl: event.target.value })} /><span className="wpa-field__hint">Used in the Ready to try email. Leave blank to leave the booking sentence out.</span></label>
          </div>
          {saveBar(['addresses', 'links'], 'Addresses and links')}
        </>
      );
    }
    return null;
  };

  const go = (next: SettingsSection) => {
    setSection(next);
    setNotice(null);
    setError(null);
  };

  return createPortal(
    <div className="onboarding-dialog onb-settings" role="presentation">
      <button className="onboarding-dialog__backdrop" type="button" aria-label="Close" onClick={close} />
      <div className="onboarding-dialog__panel onb-settings__window" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <nav className="onb-settings__nav" aria-label="Onboarding settings">
          <h2 id={titleId}>Onboarding settings</h2>
          <label className="onb-settings__search">
            <Search size={14} aria-hidden="true" />
            <input type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Find an email or page" aria-label="Find an email or page" />
          </label>
          {NAV.map(group => {
            const needle = filter.trim().toLowerCase();
            const items = needle ? group.items.filter(entry => `${group.group} ${entry.label}`.toLowerCase().includes(needle)) : group.items;
            return items.length ? (
            <div key={group.group} className="onb-settings__group">
              <span>{group.group}</span>
              {items.map(entry => (
                <button
                  key={entry.id}
                  type="button"
                  aria-current={section === entry.id ? 'page' : undefined}
                  className={section === entry.id ? 'is-active' : undefined}
                  onClick={() => go(entry.id)}
                >
                  {entry.label}
                  {entry.keys.some(isDirty) || (entry.copy && copyDirty(entry.copy)) ? <i className="onb-settings__dot" aria-label="Unsaved changes" /> : null}
                  {!entry.keys.some(isDirty) && entry.copy && !copyDirty(entry.copy) && copySaved?.[entry.copy] ? <i className="onb-settings__edited-mark" title="Edited wording in use">Edited</i> : null}
                </button>
              ))}
            </div>
            ) : null;
          })}
        </nav>
        <section className="onb-settings__main" aria-label={item.label}>
          <header className="onb-settings__head">
            <h3>{item.label}</h3>
            <button type="button" className="wpa-close" onClick={close} aria-label="Close" title="Close"><X size={18} aria-hidden="true" /></button>
          </header>
          {error && view ? <p className="wpa-banner is-red" role="alert">{error}</p> : null}
          {copyError && section.startsWith('copy:') ? <p className="wpa-banner is-red" role="alert">{copyError}</p> : null}
          {error && !view && !['worldpay', 'worldpayWording', 'demo', 'terms'].includes(section) ? <p className="wpa-banner is-red" role="alert">{error}</p> : null}
          <div className="onb-settings__content">{body()}</div>
        </section>
      </div>
    </div>,
    document.body,
  );
}
