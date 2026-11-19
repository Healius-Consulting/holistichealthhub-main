#!/usr/bin/env -S npx tsx
/**
 * Loads a content packs release (FB-20) straight into production: zips each group folder,
 * puts the zip in Storage under content-packs/<group>/, and records it in PlatformContent
 * (onboarding.contentPacks) with the version and date Shay gave, exactly as an admin issue
 * would. Anything a group had before is replaced and its old file deleted.
 *
 *   npx tsx scripts/load-content-packs.ts "<release folder>"           # dry run: zips and lists, touches nothing
 *   npx tsx scripts/load-content-packs.ts "<release folder>" --apply   # uploads and records
 *
 * Uses the local Google credentials (gcloud application-default) for project hhh26-4ebd2.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import JSZip from 'jszip';
import {
  CONTENT_PACKS_KEY,
  contentPackStoragePath,
  issueDate,
  issueGroup,
  resolveContentPacks,
  type ContentPackFile,
  type GroupId,
} from '../services/api-sql/src/domain/content-packs/content-packs.js';
import { StorageProvider } from '../services/api-sql/src/providers/storage/storage.provider.js';
import { SqlPlatformContentRepository } from '../services/api-sql/src/repositories/sql/worldpay-application.sql.js';

/** Release 1, 19 Nov 2026 (README - Content packs release 1 - for Mihir). */
const RELEASE_1: Array<{ folder: string; group: GroupId; version: string | null; issuedOn: string }> = [
  { folder: '0.1 Payments set-up', group: '0.1', version: 'v2.0', issuedOn: '2026-10-03' },
  { folder: '0.2 PMR formulary', group: '0.2', version: 'v1.0', issuedOn: '2026-11-19' },
  { folder: 'A.1 SOPs', group: 'A.1', version: 'v1.0', issuedOn: '2026-11-19' },
  { folder: 'A.2 Supplier licences', group: 'A.2', version: null, issuedOn: '2026-11-19' },
  { folder: 'B.1 Training session', group: 'B.1', version: 'v1.1', issuedOn: '2026-11-19' },
  { folder: 'B.2 Reference library', group: 'B.2', version: null, issuedOn: '2026-11-19' },
];

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const root = args.find(arg => !arg.startsWith('--'));
if (!root || !existsSync(root)) {
  console.error('Give the release folder, e.g. "HHH-Content-Packs-Release-1-2026-11-19".');
  process.exit(1);
}

async function zipFolder(folder: string) {
  const zip = new JSZip();
  const inner = zip.folder(basename(folder))!;
  const files = readdirSync(folder).filter(name => !name.startsWith('.') && statSync(join(folder, name)).isFile()).sort();
  // A fixed date in the zip, so the same folder always makes the same bytes.
  for (const name of files) inner.file(name, readFileSync(join(folder, name)), { date: new Date('2026-11-19T12:00:00Z') });
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { bytes, files };
}

const storage = new StorageProvider();
const content = new SqlPlatformContentRepository();
let config = resolveContentPacks((await content.read([CONTENT_PACKS_KEY]))[CONTENT_PACKS_KEY]);
const replaced: ContentPackFile[] = [];
const uploaded: string[] = [];

for (const entry of RELEASE_1) {
  const folder = join(root, entry.folder);
  if (!existsSync(folder)) throw new Error(`Missing folder: ${entry.folder}`);
  const { bytes, files } = await zipFolder(folder);
  const filename = `HHH ${entry.folder}${entry.version ? ` ${entry.version}` : ''} ${entry.issuedOn}.zip`;
  const storagePath = contentPackStoragePath(entry.group, filename, new Date().toISOString().replace(/[^0-9]/g, ''), randomUUID());
  const mb = (bytes.length / 1024 / 1024).toFixed(1);
  console.log(`${apply ? '' : '[dry run] '}${entry.group}: ${files.length} files → ${filename} (${mb} MB) · ${entry.version ?? 'no version'} · ${entry.issuedOn}`);
  if (!apply) continue;
  await storage.saveObject(storagePath, bytes, 'application/zip');
  uploaded.push(storagePath);
  const issued = issueGroup(config, entry.group, {
    version: entry.version,
    issuedAt: issueDate(entry.issuedOn, new Date()),
    file: { storagePath, filename, contentType: 'application/zip', sizeBytes: bytes.length },
  });
  config = issued.config;
  if (issued.replaced) replaced.push(issued.replaced);
}

if (apply) {
  try {
    await content.write(CONTENT_PACKS_KEY, config, 'content-packs-release-script');
  } catch (error) {
    // Nothing recorded: remove what this run uploaded.
    for (const path of uploaded) await storage.deleteFile(path).catch(() => undefined);
    throw error;
  }
  for (const old of replaced) await storage.deleteFile(old.storagePath).catch(() => undefined);
  console.log(`Recorded ${RELEASE_1.length} groups${replaced.length ? `, replaced ${replaced.length}` : ''}.`);
  const shown = config.groups.filter(group => group.file).map(group => `${group.id} ${group.version ?? ''} ${group.issuedAt?.slice(0, 10)}`);
  console.log(`Groups with files now: ${shown.join(' | ')}`);
}
