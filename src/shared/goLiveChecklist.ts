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
