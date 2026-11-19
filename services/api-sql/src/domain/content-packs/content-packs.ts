import { z } from 'zod';

/**
 * Content packs (FB-20, HHH-Content-Packs-Index v0.4, decisions D12 to D14).
 *
 * One card per pack; inside a card, one download button per group. The pack is the unit
 * of display, the group the unit a pharmacy downloads. Titles, descriptions, group labels
 * and each group's file are kept in PlatformContent (`onboarding.contentPacks`), so HHH
 * admin can edit them and re-issue a group without a release. Files live in Storage.
 *
 * A group is one download: the file admin issued (a zip for a multi-file group, or the
 * single file), or a bundle the portal builds per pharmacy:
 *  - `website_kit` (C.1): HHH's kit zip, if issued, plus the pharmacy's own link, QR code
 *    and palette (what the old "Developer pack" held), plus the block library link.
 *  - `counter_print` (C.2): the A3 poster and A5 leaflet carrying the pharmacy's logo and
 *    QR code (the old "Poster pack", unchanged).
 *
 * A group shows only once it has something to download; a card only once it has a group.
 * Group ids are fixed (helper lines link to them, and A.1 will later carry per-staff
 * acknowledgement), so admin can rename a group but not renumber it.
 */

export const CONTENT_PACKS_KEY = 'onboarding.contentPacks';
/**
 * Files go straight between the browser and Storage through short-lived signed links, never
 * through the API (which can't carry more than about 32 MB), so a group can be large: the
 * B.2 reference library is about 57 MB.
 */
export const MAX_CONTENT_PACK_FILE_BYTES = 250 * 1024 * 1024;

export const PACK_IDS = ['0', 'A', 'B', 'C'] as const;
export type PackId = typeof PACK_IDS[number];
export const GROUP_IDS = ['0.1', '0.2', 'A.1', 'A.2', 'B.1', 'B.2', 'C.1', 'C.2'] as const;
export type GroupId = typeof GROUP_IDS[number];
export type GroupSource = 'upload' | 'website_kit' | 'counter_print';

export interface ContentPackFile {
  storagePath: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export interface ContentPackGroup {
  id: GroupId;
  pack: PackId;
  label: string;
  source: GroupSource;
  /** The issued version, e.g. "v1.2", and when it was issued. */
  version: string | null;
  issuedAt: string | null;
  /** The issued file. Optional for generated groups (C.1 merges it in when present). */
  file: ContentPackFile | null;
  /** C.1: the live block library. */
  libraryUrl: string | null;
}

export interface ContentPackCard {
  id: PackId;
  title: string;
  /** Who it is for, shown small under the title. */
  audience: string;
  description: string;
}

export interface ContentPacksConfig {
  cards: ContentPackCard[];
  groups: ContentPackGroup[];
}

const PACK_OF: Record<GroupId, PackId> = { '0.1': '0', '0.2': '0', 'A.1': 'A', 'A.2': 'A', 'B.1': 'B', 'B.2': 'B', 'C.1': 'C', 'C.2': 'C' };
const SOURCE_OF: Record<GroupId, GroupSource> = { '0.1': 'upload', '0.2': 'upload', 'A.1': 'upload', 'A.2': 'upload', 'B.1': 'upload', 'B.2': 'upload', 'C.1': 'website_kit', 'C.2': 'counter_print' };

/** Shay's release set and wording (release 1, 19 Nov 2026). A group shows once its file is issued. */
export const CONTENT_PACK_DEFAULTS: ContentPacksConfig = {
  cards: [
    { id: '0', title: 'Pack 0: Onboarding', audience: 'Owner, superintendent', description: 'What you need to set up payments and your PMR.' },
    { id: 'A', title: 'Pack A: Compliance', audience: 'Superintendent, responsible pharmacist', description: 'The standard operating procedures your pharmacy adopts and signs before go-live, and the supplier’s licence documents.' },
    { id: 'B', title: 'Pack B: Training', audience: 'Pharmacists and staff', description: 'Training and reference material for the pharmacy team.' },
    { id: 'C', title: 'Pack C: Marketing', audience: 'Owner, web developer, counter', description: 'Your website kit and counter print for telling patients about the service.' },
  ],
  groups: [
    { id: '0.1', pack: '0', label: '0.1 Payments set-up', source: 'upload', version: null, issuedAt: null, file: null, libraryUrl: null },
    { id: '0.2', pack: '0', label: '0.2 PMR formulary', source: 'upload', version: null, issuedAt: null, file: null, libraryUrl: null },
    { id: 'A.1', pack: 'A', label: 'A.1 SOPs', source: 'upload', version: null, issuedAt: null, file: null, libraryUrl: null },
    { id: 'A.2', pack: 'A', label: 'A.2 Supplier licences', source: 'upload', version: null, issuedAt: null, file: null, libraryUrl: null },
    { id: 'B.1', pack: 'B', label: 'B.1 Training session', source: 'upload', version: null, issuedAt: null, file: null, libraryUrl: null },
    { id: 'B.2', pack: 'B', label: 'B.2 Reference library', source: 'upload', version: null, issuedAt: null, file: null, libraryUrl: null },
    { id: 'C.1', pack: 'C', label: 'C.1 Website kit', source: 'website_kit', version: null, issuedAt: null, file: null, libraryUrl: null },
    { id: 'C.2', pack: 'C', label: 'C.2 Counter print', source: 'counter_print', version: null, issuedAt: null, file: null, libraryUrl: null },
  ],
};

const text = (max: number) => z.string().trim().min(1).max(max);
const fileSchema = z.object({
  storagePath: z.string().min(1).max(300),
  filename: z.string().min(1).max(160),
  contentType: z.string().min(1).max(120),
  sizeBytes: z.number().int().min(0),
});
const storedSchema = z.object({
  cards: z.array(z.object({ id: z.enum(PACK_IDS), title: text(80), audience: z.string().trim().max(120), description: z.string().trim().max(400) }).partial({ audience: true })).optional(),
  groups: z.array(z.object({
    id: z.enum(GROUP_IDS),
    label: text(80).optional(),
    version: z.string().trim().max(40).nullable().optional(),
    issuedAt: z.string().max(40).nullable().optional(),
    file: fileSchema.nullable().optional(),
    libraryUrl: z.string().trim().max(300).nullable().optional(),
  })).optional(),
}).passthrough();

/** The stored config over the defaults: a bad or partial value never hides the packs. */
export function resolveContentPacks(stored: unknown): ContentPacksConfig {
  const parsed = storedSchema.safeParse(stored ?? {});
  const value = parsed.success ? parsed.data : {};
  const cards = CONTENT_PACK_DEFAULTS.cards.map(card => {
    const saved = value.cards?.find(entry => entry.id === card.id);
    return saved ? { ...card, title: saved.title, audience: saved.audience ?? card.audience, description: saved.description } : card;
  });
  const groups = CONTENT_PACK_DEFAULTS.groups.map(group => {
    const saved = value.groups?.find(entry => entry.id === group.id);
    if (!saved) return group;
    return {
      ...group,
      label: saved.label ?? group.label,
      version: saved.version ?? null,
      issuedAt: saved.issuedAt ?? null,
      file: saved.file ?? null,
      libraryUrl: saved.libraryUrl ?? null,
      pack: PACK_OF[group.id],
      source: SOURCE_OF[group.id],
    };
  });
  return { cards, groups };
}

/** Whether a pharmacy sees the group: an issued file, or a bundle the portal builds. */
export function groupVisible(group: ContentPackGroup): boolean {
  return group.source === 'upload' ? Boolean(group.file) : true;
}

/** What a pharmacy is sent: visible groups, cards with at least one, and never a storage path. */
export function pharmacyContentPacks(config: ContentPacksConfig) {
  const groups = config.groups.filter(groupVisible).map(group => ({
    id: group.id,
    pack: group.pack,
    label: group.label,
    source: group.source,
    version: group.version,
    issuedAt: group.issuedAt,
    hasFile: Boolean(group.file),
    filename: group.file?.filename ?? null,
    sizeBytes: group.file?.sizeBytes ?? null,
    libraryUrl: group.libraryUrl,
  }));
  const cards = config.cards
    .filter(card => groups.some(group => group.pack === card.id))
    .map(card => ({ ...card, groups: groups.filter(group => group.pack === card.id) }));
  return { cards };
}

export type PharmacyContentPacksView = ReturnType<typeof pharmacyContentPacks>;

/** Admin edits to words (no files): card titles, descriptions, group labels, C.1's library link. */
export const contentPacksTextSchema = z.object({
  cards: z.array(z.object({ id: z.enum(PACK_IDS), title: text(80), audience: z.string().trim().max(120), description: z.string().trim().max(400) })).max(PACK_IDS.length),
  groups: z.array(z.object({
    id: z.enum(GROUP_IDS),
    label: text(80),
    libraryUrl: z.string().trim().max(300).refine(value => value === '' || /^https:\/\/[^\s]+$/.test(value), 'Enter a link starting https://').optional(),
  })).max(GROUP_IDS.length),
}).strict();

export function applyContentPacksText(config: ContentPacksConfig, input: z.infer<typeof contentPacksTextSchema>): ContentPacksConfig {
  return {
    cards: config.cards.map(card => {
      const edit = input.cards.find(entry => entry.id === card.id);
      return edit ? { ...card, title: edit.title, audience: edit.audience, description: edit.description } : card;
    }),
    groups: config.groups.map(group => {
      const edit = input.groups.find(entry => entry.id === group.id);
      if (!edit) return group;
      return {
        ...group,
        label: edit.label,
        libraryUrl: group.id === 'C.1' && edit.libraryUrl !== undefined ? (edit.libraryUrl || null) : group.libraryUrl,
      };
    }),
  };
}

/** A re-issue replaces the group's download; the previous file is returned so it can be deleted. */
export function issueGroup(
  config: ContentPacksConfig,
  groupId: GroupId,
  issue: { version: string | null; issuedAt: string; file: ContentPackFile },
): { config: ContentPacksConfig; replaced: ContentPackFile | null } {
  let replaced: ContentPackFile | null = null;
  const groups = config.groups.map(group => {
    if (group.id !== groupId) return group;
    if (group.source === 'counter_print') throw new Error('Counter print is built per pharmacy and takes no upload.');
    replaced = group.file;
    return { ...group, version: issue.version?.trim() || null, issuedAt: issue.issuedAt, file: issue.file };
  });
  return { config: { ...config, groups }, replaced };
}

/** Withdraw a group's file: an upload group then disappears from pharmacies. */
export function withdrawGroup(config: ContentPacksConfig, groupId: GroupId): { config: ContentPacksConfig; removed: ContentPackFile | null } {
  let removed: ContentPackFile | null = null;
  const groups = config.groups.map(group => {
    if (group.id !== groupId) return group;
    removed = group.file;
    return { ...group, version: null, issuedAt: null, file: null };
  });
  return { config: { ...config, groups }, removed };
}

/** Storage-safe filename, keeping the extension. */
export function safeFilename(raw: string) {
  const cleaned = raw.replace(/[^A-Za-z0-9 ._&()-]/g, '').replace(/\s+/g, ' ').replace(/^[.\s]+/, '').trim().slice(-120);
  return cleaned && /\.[A-Za-z0-9]{2,5}$/.test(cleaned) ? cleaned : `${cleaned || 'download'}.bin`;
}

const CONTENT_TYPES: Record<string, string> = {
  zip: 'application/zip',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
};

/** Only the kinds of file a pack carries. */
export function contentTypeFor(filename: string): string | null {
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[extension] ?? null;
}

/** The date shown beside a group's button: the given day (noon UTC, so it reads the same in London), or now. */
export function issueDate(issuedOn: string | null | undefined, now: Date): string {
  if (!issuedOn) return now.toISOString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedOn)) throw new Error('Use a date like 2026-11-19.');
  const date = new Date(`${issuedOn}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new Error('Use a date like 2026-11-19.');
  return date.toISOString();
}

/** Where a group's uploaded file lives: under that group, so an issue can only name its own file. */
export function contentPackStoragePath(groupId: GroupId, filename: string, stamp: string, id: string) {
  return `content-packs/${groupId}/${stamp}-${id}-${filename.replace(/\s+/g, '-')}`;
}

export function belongsToGroup(storagePath: string, groupId: GroupId) {
  return storagePath.startsWith(`content-packs/${groupId}/`) && !storagePath.includes('..');
}
