import assert from 'node:assert/strict';
import test from 'node:test';
import { CATALOGUE_TTL_MS, catalogueIsStale } from '../src/utils/catalogueFreshness.ts';

const NOW = Date.parse('2026-08-27T12:00:00.000Z');
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

test('the agreed window is fifteen minutes', () => {
  assert.equal(CATALOGUE_TTL_MS, 15 * 60 * 1000);
});

test('a catalogue inside the window is served without a refetch', () => {
  assert.equal(catalogueIsStale(at(0), NOW), false);
  assert.equal(catalogueIsStale(at(CATALOGUE_TTL_MS - 1_000), NOW), false);
});

test('a catalogue at or past the window is revalidated', () => {
  assert.equal(catalogueIsStale(at(CATALOGUE_TTL_MS), NOW), true);
  assert.equal(catalogueIsStale(at(60 * 60 * 1000), NOW), true);
});

test('never having fetched is stale, so the first load still fetches', () => {
  assert.equal(catalogueIsStale(null, NOW), true);
});

test('an unreadable timestamp is stale rather than trusted', () => {
  assert.equal(catalogueIsStale('not a date', NOW), true);
  assert.equal(catalogueIsStale('', NOW), true);
});

test('a future timestamp costs one refetch instead of pinning stale prices', () => {
  assert.equal(catalogueIsStale(new Date(NOW + 60_000).toISOString(), NOW), true);
});
