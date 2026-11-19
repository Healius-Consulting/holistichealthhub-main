import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ApiRequestError,
  getOnboardingContent,
  saveOnboardingContent,
  type OnboardingContent,
  type OnboardingContentKey,
  type OnboardingContentView,
  type OnboardingEmailKind,
} from '../../shared/api';
import {
  HOLD_REASON_LABEL,
  ONBOARDING_CONTENT_DEFAULTS,
  ONBOARDING_EMAIL_KINDS,
  ONBOARDING_EMAIL_MERGE_HELP,
  ONBOARDING_HOLD_REASONS,
  PARTNER_TERMS_PATH,
} from '../../../services/api-sql/src/domain/pharmacy-onboarding/content.ts';
import { FormBottom, FormIntro, FormTop, Section } from '../../components/OnboardingFormParts';
import { isLocalPortalPreview } from '../../dev/localPortalPreview';
import { ONBOARDING_EMAIL_LABEL } from './onboardingAdmin';
import '../../styles/onboarding-admin.css';

/**
 * HHH admin: partner onboarding content that changes without a release (Shay's
 * build pack, 19 Nov 2026): the five onboarding emails, the hold page, the sending
 * addresses, the training booking link and the Partner Terms.
 */

type Tab = 'emails' | 'holdPage' | 'addresses' | 'terms';

const message = (error: unknown, fallback: string) => (error instanceof ApiRequestError ? error.message : fallback);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const EMAIL_WHEN: Record<OnboardingEmailKind, string> = {
  sent: 'To the Partner Terms signer and the branch’s address, when the pharmacy accepts the Partner Terms. One email when both are the same address.',
  curaleafApplication: 'To Curaleaf, with the filled form attached, at the same time as Sent. Curaleaf’s replies go to the Curaleaf Reply-To address.',
  activation: 'When you activate a request: the account is ready to try in demonstration mode. Sent once per branch.',
  hold: 'Each time you put a branch on hold or change its reason. Keep each reason’s wording inside its [If …] block so the pharmacy gets that reason’s text and no other.',
  live: 'When the PHAR code and API key are both saved and the branch goes live. Sent once per branch.',
};

const PREVIEW_VIEW: OnboardingContentView = { content: ONBOARDING_CONTENT_DEFAULTS, mergeHelp: ONBOARDING_EMAIL_MERGE_HELP };

function MergeHelp({ fields, flags }: { fields: string[]; flags: string[] }) {
  return (
    <div className="onb-content__help">
      <span><strong>Merge fields.</strong> Type them exactly, in square brackets.</span>
      <span className="onb-content__tokens">{fields.map(field => <code key={field}>[{field}]</code>)}</span>
      {flags.length ? (
        <>
          <span><strong>Conditions.</strong> Text between <code>[If flag]</code> and <code>[/If]</code> is sent only when it applies.</span>
          <span className="onb-content__tokens">{flags.map(flag => <code key={flag} className="is-flag">[If {flag}]…[/If]</code>)}</span>
        </>
      ) : null}
      <span>A blank line starts a new paragraph.</span>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="wpa-field">
      <span className="wpa-field__label">{label}</span>
      {children}
      {hint ? <span className="wpa-field__hint">{hint}</span> : null}
    </label>
  );
}

export function OnboardingContentAdmin({ open, onClose }: { open: boolean; onClose: () => void }) {
  const titleId = useId();
  const [tab, setTab] = useState<Tab>('emails');
  const [view, setView] = useState<OnboardingContentView | null>(null);
  const [draft, setDraft] = useState<OnboardingContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<OnboardingContentKey | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  // Close asks first when there are unsaved edits; Escape uses the latest version.
  const closeRef = useRef(onClose);

  const load = useCallback(() => {
    setError(null);
    if (isLocalPortalPreview) {
      setView(PREVIEW_VIEW);
      setDraft(PREVIEW_VIEW.content);
      return;
    }
    getOnboardingContent()
      .then(result => { setView(result); setDraft(result.content); })
      .catch(cause => setError(message(cause, 'The onboarding content could not be loaded.')));
  }, []);
  useEffect(() => {
    if (!open) return;
    setNotice(null);
    setConfirmPublish(false);
    load();
  }, [open, load]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeRef.current(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const dirtyKeys = view && draft
    ? (Object.keys(draft) as OnboardingContentKey[]).filter(key => !same(draft[key], view.content[key]))
    : [];
  const close = () => {
    if (dirtyKeys.length && !window.confirm('Close without saving your changes?')) return;
    onClose();
  };
  closeRef.current = close;
  if (!open) return null;

  const isDirty = (key: OnboardingContentKey) => dirtyKeys.includes(key);

  const set = <K extends OnboardingContentKey>(key: K, value: OnboardingContent[K]) => {
    setDraft(current => (current ? { ...current, [key]: value } : current));
    setNotice(null);
    if (key === 'partnerTerms') setConfirmPublish(false);
  };

  const save = async <K extends OnboardingContentKey>(key: K, label: string, confirmed = false) => {
    if (!draft || !view) return;
    if (key === 'partnerTerms') {
      const terms = draft.partnerTerms;
      if (terms.published && (!terms.text.trim() || !terms.version.trim())) {
        setError('Add the Terms text and a version before publishing.');
        return;
      }
      if (terms.published && !view.content.partnerTerms.published && !confirmed) {
        setConfirmPublish(true);
        return;
      }
    }
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      const next = isLocalPortalPreview
        ? { ...view, content: { ...view.content, [key]: draft[key] } }
        : await saveOnboardingContent(key, draft[key]);
      setView(next);
      // Keep unsaved edits to other sections; take the server's version of this one.
      setDraft(current => (current ? { ...current, [key]: next.content[key] } : next.content));
      setNotice(`${label} saved. The next email or page uses it.`);
      setConfirmPublish(false);
    } catch (cause) {
      setError(message(cause, `${label} could not be saved.`));
    } finally {
      setBusy(null);
    }
  };
  const revert = (key: OnboardingContentKey) => {
    if (!view) return;
    setDraft(current => (current ? { ...current, [key]: view.content[key] } : current));
    if (key === 'partnerTerms') setConfirmPublish(false);
  };
  const saveRow = (key: OnboardingContentKey, label: string) => (
    <div className="onb-content__save">
      <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null || !isDirty(key)} onClick={() => void save(key, label)}>
        {busy === key ? 'Saving…' : 'Save changes'}
      </button>
      {isDirty(key) ? (
        <>
          <span className="onb-content__dirty">Not saved</span>
          <button type="button" className="wpa-link" disabled={busy !== null} onClick={() => revert(key)}>Undo changes</button>
        </>
      ) : null}
    </div>
  );

  const tabs: Array<{ key: Tab; label: string; keys: OnboardingContentKey[] }> = [
    { key: 'emails', label: 'Emails', keys: [...ONBOARDING_EMAIL_KINDS] },
    { key: 'holdPage', label: 'Hold page', keys: ['holdPage'] },
    { key: 'addresses', label: 'Addresses and links', keys: ['addresses', 'links'] },
    { key: 'terms', label: 'Partner Terms', keys: ['partnerTerms'] },
  ];

  const body = () => {
    if (!view || !draft) return null;
    if (tab === 'emails') {
      return ONBOARDING_EMAIL_KINDS.map(kind => (
        <Section key={kind} title={ONBOARDING_EMAIL_LABEL[kind]} description={EMAIL_WHEN[kind]}>
          <Field label="Subject">
            <input className="input" value={draft[kind].subject} onChange={event => set(kind, { ...draft[kind], subject: event.target.value })} />
          </Field>
          <Field label="Body">
            <textarea className="input" rows={14} value={draft[kind].body} onChange={event => set(kind, { ...draft[kind], body: event.target.value })} />
          </Field>
          <MergeHelp fields={view.mergeHelp[kind]?.fields ?? []} flags={view.mergeHelp[kind]?.flags ?? []} />
          {saveRow(kind, ONBOARDING_EMAIL_LABEL[kind])}
        </Section>
      ));
    }
    if (tab === 'holdPage') {
      const page = draft.holdPage;
      return (
        <Section title="Hold page" description="What anyone from a pharmacy on hold sees when they log in, in place of the form or the demo account. The text shown is the one for the reason you chose.">
          <Field label="Heading (all reasons)">
            <input className="input" value={page.heading} onChange={event => set('holdPage', { ...page, heading: event.target.value })} />
          </Field>
          {ONBOARDING_HOLD_REASONS.map(reason => (
            <Field key={reason} label={HOLD_REASON_LABEL[reason]}>
              <textarea className="input" rows={6} value={page[reason]} onChange={event => set('holdPage', { ...page, [reason]: event.target.value })} />
            </Field>
          ))}
          <Field label="Footer (all reasons)">
            <input className="input" value={page.footer} onChange={event => set('holdPage', { ...page, footer: event.target.value })} />
          </Field>
          <MergeHelp fields={['Branch name']} flags={[]} />
          {saveRow('holdPage', 'Hold page')}
        </Section>
      );
    }
    if (tab === 'addresses') {
      const addresses = draft.addresses;
      const links = draft.links;
      return (
        <>
          <Section title="Sending addresses" description="The mailboxes replies reach. Both must be monitored.">
            <Field label="Pharmacy Reply-To" hint="From and Reply-To on Sent, Ready to try, On hold and Live.">
              <input className="input" type="email" value={addresses.pharmacyReplyTo} onChange={event => set('addresses', { ...addresses, pharmacyReplyTo: event.target.value })} />
            </Field>
            <Field label="Curaleaf Reply-To" hint="Reply-To on the application to Curaleaf: their queries and refusals come back here.">
              <input className="input" type="email" value={addresses.curaleafReplyTo} onChange={event => set('addresses', { ...addresses, curaleafReplyTo: event.target.value })} />
            </Field>
            <Field label="Display name" hint="The sender name on every onboarding email.">
              <input className="input" value={addresses.displayName} onChange={event => set('addresses', { ...addresses, displayName: event.target.value })} />
            </Field>
            {saveRow('addresses', 'Addresses')}
          </Section>
          <Section title="Training booking link" description="Used as [Training booking link] in the Ready to try email.">
            <Field label="Link" hint="Leave blank to leave the booking sentence out of the email.">
              <input className="input" type="url" value={links.trainingBookingUrl} onChange={event => set('links', { ...links, trainingBookingUrl: event.target.value })} placeholder="https://" />
            </Field>
            {saveRow('links', 'Training link')}
          </Section>
        </>
      );
    }
    const terms = draft.partnerTerms;
    const wasPublished = view.content.partnerTerms.published;
    return (
      <Section title="Partner Terms" description={`The public page at holistichealthhub.live${PARTNER_TERMS_PATH}, and the link in the Sent email.`}>
        <p className={`wpa-banner ${wasPublished ? 'is-green' : 'is-amber'}`} role="status">
          {wasPublished
            ? <>Published. The public page shows the saved text and the Sent email links to it.</>
            : <>Not published. There is no public page, and the Sent email leaves the link out. Publish once the final text is in.</>}
        </p>
        <label className="onb-content__toggle">
          <input type="checkbox" checked={terms.published} onChange={event => set('partnerTerms', { ...terms, published: event.target.checked })} />
          <span>
            <strong>Published</strong>
            <small>When on and saved, the public page goes live and every Sent email from then on includes the link.</small>
          </span>
        </label>
        <Field label="Version" hint="Shown on the page, for example 1.0 or November 2026.">
          <input className="input" value={terms.version} onChange={event => set('partnerTerms', { ...terms, version: event.target.value })} />
        </Field>
        <Field label="Terms text" hint="A blank line starts a new paragraph. Changes to published Terms show on the public page as soon as they are saved.">
          <textarea className="input" rows={18} value={terms.text} onChange={event => set('partnerTerms', { ...terms, text: event.target.value })} />
        </Field>
        {confirmPublish ? (
          <div className="wpa-banner is-amber onb-content__publish-warning" role="alert">
            <strong>Publish the Partner Terms?</strong>
            <span>The page at holistichealthhub.live{PARTNER_TERMS_PATH} goes live for anyone with the link, and every Sent email from now on links to it.</span>
            <span className="wpa-inline">
              <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => setConfirmPublish(false)}>Cancel</button>
              <button type="button" className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => void save('partnerTerms', 'Partner Terms', true)}>
                {busy === 'partnerTerms' ? 'Publishing…' : 'Yes, publish'}
              </button>
            </span>
          </div>
        ) : saveRow('partnerTerms', 'Partner Terms')}
      </Section>
    );
  };

  const unsavedTabs = tabs.filter(item => item.keys.some(isDirty)).map(item => item.label);

  return createPortal(
    <div className="onboarding-dialog" role="presentation">
      <button className="onboarding-dialog__backdrop" type="button" aria-label="Close" onClick={close} />
      <div className="onboarding-dialog__panel wpa" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <FormTop eyebrow="Admin" title="Partner onboarding content" titleId={titleId} onClose={close} closeLabel="Close" />
        <div className="wpa-body">
          <div className="wpa-content onb-content">
            <FormIntro title="Emails and wording, without a release">Changes apply to the next email sent or page shown. Emails already sent are not changed.</FormIntro>
            <div className="wpa-chips" role="tablist" aria-label="Partner onboarding content">
              {tabs.map(item => (
                <button key={item.key} type="button" role="tab" aria-selected={tab === item.key} className={tab === item.key ? 'wpa-chip is-active' : 'wpa-chip'} onClick={() => setTab(item.key)}>
                  {item.label}{item.keys.some(isDirty) ? ' •' : ''}
                </button>
              ))}
            </div>
            {notice ? <p className="wpa-banner is-green" role="status">{notice}</p> : null}
            {error ? (
              <p className="wpa-banner is-red" role="alert">
                {error}
                {!view ? <button type="button" className="btn btn-sm" onClick={load}>Try again</button> : null}
              </p>
            ) : null}
            {!view ? (error ? null : <p className="wpa-muted">Loading…</p>) : body()}
          </div>
        </div>
        <FormBottom status={<span className="wpa-save">{unsavedTabs.length ? `Not saved: ${unsavedTabs.join(', ')}` : 'All changes saved'}</span>}>
          <button type="button" className="btn btn-primary wpa-next" onClick={close}>Done</button>
        </FormBottom>
      </div>
    </div>,
    document.body,
  );
}
