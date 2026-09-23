import assert from 'node:assert/strict';
import test from 'node:test';
import { attributedCountForOrganisation, attributedPatientCounts, portfolioAttributedCount } from '../src/utils/attributedPatients.ts';

test('attributed counts add referred and closed records for one pharmacy', () => {
  const counts = attributedPatientCounts([
    { organisationId: '1edf6ba6265940b6bb816e5096f56c3e', count: 21 },
    { organisationId: '1edf6ba6-2659-40b6-bb81-6e5096f56c3e', count: 4 },
    { organisationId: '70913a3071c34a41952ed532927af58c', count: 2 },
  ], 27);
  assert.equal(counts.total, 27);
  assert.equal(attributedCountForOrganisation(counts, '1edf6ba6-2659-40b6-bb81-6e5096f56c3e'), 25);
  assert.equal(attributedCountForOrganisation(counts, 'missing'), 0);
  assert.equal(portfolioAttributedCount(counts, [
    { id: '1edf6ba6-2659-40b6-bb81-6e5096f56c3e' },
    { id: '70913a3071c34a41952ed532927af58c' },
  ], organisation => organisation.id.startsWith('70913a30')), 25);
});
