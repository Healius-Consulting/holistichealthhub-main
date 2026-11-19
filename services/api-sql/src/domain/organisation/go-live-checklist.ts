import { nameBasedUuid, sameUuid, uuidKey } from '../common/uuid.js';

/**
 * The go-live checklist (brief 2.5, list fixed by Shay on 18 Nov 2026).
 *
 * Two sections, Required first, then Optional. Each item has an owner and a status.
 * Nothing on the platform is gated by it: Live is decided only by the Curaleaf
 * connection (2.1). Three items tick themselves from what the platform already
 * knows; everything else is a self-declaration the pharmacy ticks.
 *
 * The list is fixed here in code. To add an item, add it to GO_LIVE_CHECKLIST.
 */

export type ChecklistSection = 'required' | 'optional';
export type ChecklistOwner = 'Pharmacy' | 'HHH' | 'Curaleaf';
/** auto: ticks itself. self: the pharmacy ticks it. link: done by completing the linked form. */
export type ChecklistItemKind = 'auto' | 'self' | 'link';
/** Worldpay items swap over once the pharmacy has started with Worldpay. */
type ChecklistVisibility = 'always' | 'worldpay_started' | 'worldpay_not_started' | 'terms_required';

export interface ChecklistItemDefinition {
  key: string;
  section: ChecklistSection;
  /** Required has two groups: platform live, then service live (self-declared). */
  group: 'platform_live' | 'service_live' | null;
  label: string;
  detail: string | null;
  owners: ChecklistOwner[];
  kind: ChecklistItemKind;
  visibility: ChecklistVisibility;
  link: 'worldpay_form' | null;
}

export const GO_LIVE_CHECKLIST = [
  {
    key: 'platform_live',
    section: 'required',
    group: 'platform_live',
    label: 'Curaleaf PHAR code and API key entered, platform live',
    detail: 'Ticks itself when HHH enters the live Curaleaf credentials.',
    owners: ['HHH', 'Curaleaf'],
    kind: 'auto',
    visibility: 'always',
    link: null,
  },
  {
    key: 'partner_terms_accepted',
    section: 'required',
    group: 'platform_live',
    label: 'Partner Terms accepted',
    detail: 'Ticks itself once the current Partner Terms are signed.',
    owners: ['Pharmacy'],
    kind: 'auto',
    // Hidden, and out of the percentage, while HHH has the Partner Terms switched off.
    visibility: 'terms_required',
    link: null,
  },
  {
    key: 'worldpay_credentials_validated',
    section: 'required',
    group: 'platform_live',
    label: 'Worldpay credentials validated',
    detail: 'Ticks itself when your live Worldpay credentials pass the check in Settings.',
    owners: ['Pharmacy'],
    kind: 'auto',
    visibility: 'worldpay_started',
    link: null,
  },
  {
    key: 'sops_approved',
    section: 'required',
    group: 'service_live',
    label: 'SOPs approved by the superintendent',
    detail: null,
    owners: ['Pharmacy'],
    kind: 'self',
    visibility: 'always',
    link: null,
  },
  {
    key: 'formulary_uploaded',
    section: 'required',
    group: 'service_live',
    label: 'Formulary uploaded to PMR',
    detail: null,
    owners: ['Pharmacy'],
    kind: 'self',
    visibility: 'always',
    link: null,
  },
  {
    key: 'worldpay_setup',
    section: 'optional',
    group: null,
    label: 'Set up card payments with Worldpay',
    detail: 'Send the Worldpay form. Once it is sent, this moves to Required as "Worldpay credentials validated".',
    owners: ['Pharmacy'],
    kind: 'link',
    visibility: 'worldpay_not_started',
    link: 'worldpay_form',
  },
  {
    key: 'staff_training',
    section: 'optional',
    group: null,
    label: 'Staff training completed',
    detail: 'HHH session attended or materials read.',
    owners: ['Pharmacy'],
    kind: 'self',
    visibility: 'always',
    link: null,
  },
  {
    key: 'patientsmart_campaign',
    section: 'optional',
    group: null,
    label: 'PatientSmart campaign set up',
    detail: null,
    owners: ['Pharmacy'],
    kind: 'self',
    visibility: 'always',
    link: null,
  },
  {
    key: 'website_updated',
    section: 'optional',
    group: null,
    label: 'Website updated with the HHH kit',
    detail: null,
    owners: ['Pharmacy'],
    kind: 'self',
    visibility: 'always',
    link: null,
  },
  {
    key: 'posters_leaflets',
    section: 'optional',
    group: null,
    label: 'Posters/leaflets created and printed',
    detail: null,
    owners: ['Pharmacy'],
    kind: 'self',
    visibility: 'always',
    link: null,
  },
  {
    key: 'branding_details',
    section: 'optional',
    group: null,
    label: 'Details, colour scheme and logo added',
    detail: 'Website domain and contact details, used on the eligibility form.',
    owners: ['Pharmacy'],
    kind: 'self',
    visibility: 'always',
    link: null,
  },
  {
    key: 'delivery_enabled',
    section: 'optional',
    group: null,
    label: 'Delivery enabled, if offering it',
    detail: null,
    owners: ['Pharmacy'],
    kind: 'self',
    visibility: 'always',
    link: null,
  },
] as const satisfies readonly ChecklistItemDefinition[];

export type ChecklistItemKey = typeof GO_LIVE_CHECKLIST[number]['key'];

export function checklistDefinition(key: string): ChecklistItemDefinition | null {
  return (GO_LIVE_CHECKLIST as readonly ChecklistItemDefinition[]).find(item => item.key === key) ?? null;
}

/** A stored tick. Only self-declared items are stored; auto items are worked out each time. */
/**
 * The row id for a branch's checklist item, the same every time. Data Connect's upsert
 * matches on the table key (`id`), so a tick must name it: a random id would add a row
 * that the unique (branch, item) index then refuses. A name-based UUID from the branch
 * and item key gives that one row a fixed id.
 */
export function checklistItemId(organisationId: string, itemKey: string): string {
  return nameBasedUuid('go-live-checklist', uuidKey(organisationId), itemKey);
}

export interface ChecklistTickRecord {
  organisationId: string;
  itemKey: string;
  status: 'DONE' | 'OPEN';
  /** Who last ticked or unticked it, and when. */
  tickedByUid: string | null;
  tickedAt: string | null;
}

/** What the platform already knows about the branch, for the items that tick themselves. */
export interface ChecklistSignals {
  organisationStatus: string;
  worldpayEnabled: boolean;
  /** When the current Partner Terms version was signed for this branch, or null. */
  termsAcceptedAt: string | null;
  /** Whether the Partner Terms are switched on. Off (or omitted): the Terms item is not on the checklist. */
  termsRequired?: boolean;
  /** When the branch last sent the Worldpay form, or null. */
  worldpayFormSubmittedAt: string | null;
  /** When live Worldpay credentials last passed validation, or null. */
  worldpayValidatedAt: string | null;
}

export interface ChecklistItemView {
  key: string;
  section: ChecklistSection;
  group: ChecklistItemDefinition['group'];
  label: string;
  detail: string | null;
  owners: ChecklistOwner[];
  kind: ChecklistItemKind;
  link: ChecklistItemDefinition['link'];
  done: boolean;
  /** When it was ticked (or, for auto items, when the platform saw it happen, where known). */
  doneAt: string | null;
  /** Who ticked or last unticked a self-declared item. Null for auto items. */
  tickedByUid: string | null;
  tickedAt: string | null;
}

export interface ChecklistSectionSummary {
  section: ChecklistSection;
  done: number;
  total: number;
  percent: number;
}

export interface GoLiveChecklistView {
  organisationId: string;
  items: ChecklistItemView[];
  sections: ChecklistSectionSummary[];
  /** Over every item shown, both sections. Sent to ClickUp. */
  percent: number;
  /** Every Required item is done. The login prompt stops once this is true. */
  requiredComplete: boolean;
  /** Every item shown is done. */
  complete: boolean;
}

/**
 * When live Worldpay credentials last passed validation. Saving credentials in Settings
 * only succeeds after Worldpay accepts them on the live service (a Payment Queries call),
 * and stamps lastSuccessfulAt; later probes refresh it. There is no separate stored
 * test-transaction result, so a live, ACTIVE connection that Worldpay has answered is
 * the validation signal.
 */
export function worldpayValidatedAt(connection: {
  status: string;
  environment: string;
  secretResourceName: string | null;
  lastSuccessfulAt: string | null;
  validatedAt: string | null;
} | null | undefined): string | null {
  if (!connection || connection.status !== 'ACTIVE' || connection.environment !== 'PRODUCTION' || !connection.secretResourceName) return null;
  return connection.lastSuccessfulAt ?? connection.validatedAt ?? null;
}

/** Started with Worldpay: the form has been sent, Worldpay is switched on, or a live merchant is validated. */
export function worldpayStarted(signals: ChecklistSignals) {
  return Boolean(signals.worldpayFormSubmittedAt || signals.worldpayEnabled || signals.worldpayValidatedAt);
}

function visible(definition: ChecklistItemDefinition, signals: ChecklistSignals) {
  if (definition.visibility === 'worldpay_started') return worldpayStarted(signals);
  if (definition.visibility === 'worldpay_not_started') return !worldpayStarted(signals);
  if (definition.visibility === 'terms_required') return Boolean(signals.termsRequired);
  return true;
}

function autoState(key: string, signals: ChecklistSignals): { done: boolean; doneAt: string | null } {
  if (key === 'platform_live') return { done: signals.organisationStatus === 'LIVE', doneAt: null };
  if (key === 'partner_terms_accepted') return { done: Boolean(signals.termsAcceptedAt), doneAt: signals.termsAcceptedAt };
  if (key === 'worldpay_credentials_validated') return { done: Boolean(signals.worldpayValidatedAt), doneAt: signals.worldpayValidatedAt };
  return { done: false, doneAt: null };
}

export function percentOf(done: number, total: number) {
  return total === 0 ? 100 : Math.round((done / total) * 100);
}

export function buildGoLiveChecklist(organisationId: string, signals: ChecklistSignals, ticks: ChecklistTickRecord[]): GoLiveChecklistView {
  const byKey = new Map(ticks.filter(tick => sameUuid(tick.organisationId, organisationId)).map(tick => [tick.itemKey, tick]));
  const items: ChecklistItemView[] = (GO_LIVE_CHECKLIST as readonly ChecklistItemDefinition[])
    .filter(definition => visible(definition, signals))
    .map(definition => {
      const tick = definition.kind === 'self' ? byKey.get(definition.key) ?? null : null;
      const state = definition.kind === 'auto'
        ? autoState(definition.key, signals)
        : { done: tick?.status === 'DONE', doneAt: tick?.status === 'DONE' ? tick.tickedAt : null };
      return {
        key: definition.key,
        section: definition.section,
        group: definition.group,
        label: definition.label,
        detail: definition.detail,
        owners: [...definition.owners],
        kind: definition.kind,
        link: definition.link,
        done: state.done,
        doneAt: state.doneAt,
        tickedByUid: tick?.tickedByUid ?? null,
        tickedAt: tick?.tickedAt ?? null,
      };
    });
  const sections = (['required', 'optional'] as const).map(section => {
    const inSection = items.filter(item => item.section === section);
    const done = inSection.filter(item => item.done).length;
    return { section, done, total: inSection.length, percent: percentOf(done, inSection.length) };
  });
  const done = items.filter(item => item.done).length;
  return {
    organisationId,
    items,
    sections,
    percent: percentOf(done, items.length),
    requiredComplete: items.filter(item => item.section === 'required').every(item => item.done),
    complete: items.every(item => item.done),
  };
}
