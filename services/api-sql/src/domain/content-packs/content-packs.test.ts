import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { looksRight } from '../../transport/portal/content-packs.router.js';
import {
  applyContentPacksText,
  belongsToGroup,
  contentPackStoragePath,
  issueDate,
  contentPacksTextSchema,
  contentTypeFor,
  issueGroup,
  pharmacyContentPacks,
  resolveContentPacks,
  safeFilename,
  withdrawGroup,
} from './content-packs.js';

const file = (name: string) => ({ storagePath: `content-packs/x/${name}`, filename: name, contentType: 'application/zip', sizeBytes: 10 });

describe('content packs (FB-20)', () => {
  it('release 1: Pack B shows once B.1 or B.2 is issued, and a group can show a date with no version', () => {
    const { config } = issueGroup(resolveContentPacks(null), 'B.2', { version: null, issuedAt: issueDate('2026-11-19', new Date()), file: file('B.2.zip') });
    const card = pharmacyContentPacks(config).cards.find(entry => entry.id === 'B')!;
    assert.equal(card.title, 'Pack B: Training');
    assert.deepEqual(card.groups.map(group => [group.label, group.version, group.issuedAt]), [['B.2 Reference library', null, '2026-11-19T12:00:00.000Z']]);
  });

  it('dates and storage paths: an issue can only name a file under its own group', () => {
    assert.equal(issueDate(null, new Date('2026-11-20T08:00:00Z')), '2026-11-20T08:00:00.000Z');
    assert.equal(issueDate('2026-10-03', new Date()), '2026-10-03T12:00:00.000Z');
    assert.throws(() => issueDate('3 Oct', new Date()));
    const path = contentPackStoragePath('A.1', 'HHH A.1 SOPs.zip', '20261120', 'abc');
    assert.equal(path, 'content-packs/A.1/20261120-abc-HHH-A.1-SOPs.zip');
    assert.equal(belongsToGroup(path, 'A.1'), true);
    assert.equal(belongsToGroup(path, 'A.2'), false);
    assert.equal(belongsToGroup('content-packs/A.1/../../partner-terms/x.pdf', 'A.1'), false);
    assert.equal(looksRight(Buffer.from('PK\u0003\u0004rest'), 'application/zip'), true);
    assert.equal(looksRight(Buffer.from('%PDF-1.7'), 'application/zip'), false);
  });

  it('starts with Shay’s four cards; only Marketing shows until files are issued, and Training never without a group', () => {
    const view = pharmacyContentPacks(resolveContentPacks(null));
    assert.deepEqual(view.cards.map(card => card.title), ['Pack C: Marketing']);
    assert.deepEqual(view.cards[0]!.groups.map(group => group.label), ['C.1 Website kit', 'C.2 Counter print']);
    const all = resolveContentPacks(null);
    assert.deepEqual(all.cards.map(card => card.title), ['Pack 0: Onboarding', 'Pack A: Compliance', 'Pack B: Training', 'Pack C: Marketing']);
  });

  it('shows a group once its file is issued, and its card with it; never sends a storage path', () => {
    const { config } = issueGroup(resolveContentPacks(null), '0.1', { version: 'v1.2', issuedAt: '2026-11-20T09:00:00.000Z', file: file('HHH-0-SOP-01.zip') });
    const view = pharmacyContentPacks(config);
    assert.deepEqual(view.cards.map(card => card.id), ['0', 'C']);
    const group = view.cards[0]!.groups[0]!;
    assert.equal(group.label, '0.1 Payments set-up');
    assert.equal(group.version, 'v1.2');
    assert.equal(JSON.stringify(view).includes('content-packs/'), false);
  });

  it('a re-issue replaces the download and hands back the old file to delete; a withdrawal hides the group', () => {
    const first = issueGroup(resolveContentPacks(null), 'A.2', { version: 'v1', issuedAt: '2026-11-20T09:00:00.000Z', file: file('old.zip') });
    assert.equal(first.replaced, null);
    const second = issueGroup(first.config, 'A.2', { version: 'v2', issuedAt: '2026-12-01T09:00:00.000Z', file: file('new.zip') });
    assert.equal(second.replaced?.filename, 'old.zip');
    assert.equal(second.config.groups.find(group => group.id === 'A.2')?.file?.filename, 'new.zip');
    const withdrawn = withdrawGroup(second.config, 'A.2');
    assert.equal(withdrawn.removed?.filename, 'new.zip');
    assert.equal(pharmacyContentPacks(withdrawn.config).cards.some(card => card.id === 'A'), false);
    assert.throws(() => issueGroup(resolveContentPacks(null), 'C.2', { version: 'v1', issuedAt: '', file: file('x.zip') }));
  });

  it('admin edits titles, descriptions and labels without a release; ids and sources stay fixed', () => {
    const input = contentPacksTextSchema.parse({
      cards: [{ id: 'C', title: 'Pack C: Patients', audience: 'Owner', description: 'New words.' }],
      groups: [{ id: 'C.1', label: 'C.1 Web kit', libraryUrl: 'https://blocks.holistichealthhub.live' }],
    });
    const edited = applyContentPacksText(resolveContentPacks(null), input);
    // Stored and read back, as PlatformContent would.
    const reread = resolveContentPacks(JSON.parse(JSON.stringify(edited)));
    const card = pharmacyContentPacks(reread).cards[0]!;
    assert.equal(card.title, 'Pack C: Patients');
    assert.equal(card.groups[0]!.label, 'C.1 Web kit');
    assert.equal(card.groups[0]!.libraryUrl, 'https://blocks.holistichealthhub.live');
    assert.equal(card.groups[0]!.source, 'website_kit');
    assert.throws(() => contentPacksTextSchema.parse({ cards: [], groups: [{ id: 'Z.9', label: 'x' }] }));
    assert.throws(() => contentPacksTextSchema.parse({ cards: [], groups: [{ id: 'C.1', label: 'x', libraryUrl: 'javascript:alert(1)' }] }));
  });

  it('a damaged stored value falls back to the defaults rather than hiding the packs', () => {
    assert.equal(pharmacyContentPacks(resolveContentPacks({ cards: 'nonsense' })).cards.length, 1);
  });

  it('accepts only the file kinds a pack carries, with safe names', () => {
    assert.equal(contentTypeFor('kit.ZIP'), 'application/zip');
    assert.equal(contentTypeFor('licence.pdf'), 'application/pdf');
    assert.equal(contentTypeFor('evil.html'), null);
    assert.equal(safeFilename('../../etc/HHH "SOPs".zip'), 'etcHHH SOPs.zip');
  });
});
