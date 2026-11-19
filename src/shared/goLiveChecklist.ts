/**
 * The go-live checklist (brief 2.5) as the portal sees it. The server owns the list
 * (services/api-sql/src/domain/organisation/go-live-checklist.ts); this file mirrors its
 * view shape, and the item list only for Demo mode, which never asks the server.
 */

export type ChecklistSection = 'required' | 'optional';
export type ChecklistOwner = 'Pharmacy' | 'HHH' | 'Curaleaf';
export type ChecklistItemKind = 'auto' | 'self' | 'link';

export interface GoLiveChecklistItem {
  key: string;
  section: ChecklistSection;
  group: 'platform_live' | 'service_live' | null;
  label: string;
  detail: string | null;
  owners: ChecklistOwner[];
  kind: ChecklistItemKind;
  link: 'worldpay_form' | null;
  done: boolean;
  doneAt: string | null;
  tickedByUid: string | null;
  tickedAt: string | null;
  /** Admin view only. */
  tickedByName?: string | null;
}

export interface GoLiveChecklistSectionSummary {
  section: ChecklistSection;
  done: number;
  total: number;
  percent: number;
}

export interface GoLiveChecklist {
  organisationId: string;
  items: GoLiveChecklistItem[];
  sections: GoLiveChecklistSectionSummary[];
  percent: number;
  requiredComplete: boolean;
  complete: boolean;
  /** Pages the helper lines link to that admin can change (FB-15). */
  links?: { trainingBookingUrl: string | null };
}

/** Where the checklist comes from and where ticks go: the server, or the demo store. */
export interface GoLiveChecklistSource {
  load(): Promise<GoLiveChecklist>;
  setItem(itemKey: string, done: boolean): Promise<GoLiveChecklist>;
}

export function sectionSummary(checklist: GoLiveChecklist, section: ChecklistSection) {
  return checklist.sections.find(entry => entry.section === section) ?? { section, done: 0, total: 0, percent: 100 };
}

export function ownerLabel(owners: ChecklistOwner[]) {
  return owners.join(' / ');
}

/**
 * Helper lines can carry links, written `[words](target)` (FB-12 to FB-16). Targets:
 * `settings:<section>` or `settings:<section>#<element id>`, `pack:<group id>` (a content
 * pack download group, FB-20), and `training` (the training booking page set in admin).
 */
export type ChecklistLinkTarget =
  | { kind: 'settings'; section: 'organisation' | 'payments' | 'assets' | 'support'; anchor: string | null }
  | { kind: 'pack'; group: string }
  | { kind: 'training' };

export type ChecklistDetailSegment = { text: string; target?: ChecklistLinkTarget };

const SETTINGS_SECTIONS = new Set(['organisation', 'payments', 'assets', 'support']);

export function parseChecklistTarget(raw: string): ChecklistLinkTarget | null {
  if (raw === 'training') return { kind: 'training' };
  const pack = /^pack:([0-9A-Z]\.[0-9]{1,2})$/.exec(raw);
  if (pack) return { kind: 'pack', group: pack[1]! };
  const settings = /^settings:([a-z]+)(?:#([A-Za-z0-9_.-]+))?$/.exec(raw);
  if (settings && SETTINGS_SECTIONS.has(settings[1]!)) {
    return { kind: 'settings', section: settings[1] as 'organisation', anchor: settings[2] ?? null };
  }
  return null;
}

export function checklistDetailSegments(detail: string): ChecklistDetailSegment[] {
  const segments: ChecklistDetailSegment[] = [];
  const pattern = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (let match = pattern.exec(detail); match; match = pattern.exec(detail)) {
    if (match.index > last) segments.push({ text: detail.slice(last, match.index) });
    const target = parseChecklistTarget(match[2]!);
    segments.push(target ? { text: match[1]!, target } : { text: match[1]! });
    last = match.index + match[0].length;
  }
  if (last < detail.length) segments.push({ text: detail.slice(last) });
  return segments;
}

/** The helper line as plain words, for places that cannot show links (emails, admin). */
export function checklistDetailText(detail: string) {
  return checklistDetailSegments(detail).map(segment => segment.text).join('');
}
