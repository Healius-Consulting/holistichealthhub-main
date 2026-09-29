const POSTCODE = /^(?:GIR0AA|(?:[A-Z][0-9][0-9A-Z]?|[A-Z][A-Z][0-9][0-9A-Z]?)[0-9][A-Z]{2})$/;
const STOP_WORDS = new Set(['pharmacy', 'chemist', 'chemists', 'ltd', 'limited', 'the', 'and', 'of', 'for', 'road', 'street']);

export type LegacyPharmacyRow = {
  name: string;
  address: string;
};

export type LegacyPharmacyCandidate = {
  id: string;
  name: string;
  tradingName: string;
  postcode: string | null;
  address: string;
  status: string;
};

export type LegacyPharmacyMatch =
  | { status: 'matched'; organisationId: string; name: string }
  | { status: 'unmatched'; reason: string };

export function compactPostcode(value: string): string | null {
  const pattern = /(?:^|[^A-Z0-9])((?:GIR\s*0AA|(?:[A-Z][0-9][0-9A-Z]?|[A-Z][A-Z][0-9][0-9A-Z]?)\s*[0-9][A-Z]{2}))(?![A-Z0-9])/gi;
  let found: string | null = null;
  for (const match of value.toUpperCase().matchAll(pattern)) {
    const compact = (match[1] ?? '').replace(/[^A-Z0-9]/g, '');
    if (POSTCODE.test(compact)) found = compact;
  }
  return found;
}

function nameTokens(value: string): Set<string> {
  const tokens = value
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 4 && !STOP_WORDS.has(token));
  return new Set(tokens);
}

function sharesName(row: LegacyPharmacyRow, candidate: LegacyPharmacyCandidate): boolean {
  const wanted = nameTokens(row.name);
  const present = nameTokens(`${candidate.name} ${candidate.tradingName} ${candidate.address}`);
  for (const token of wanted) {
    if (present.has(token)) return true;
  }
  return false;
}

function rank(status: string): number {
  if (status === 'LIVE' || status === 'INTAKE_LIVE') return 2;
  if (status === 'ONBOARDING') return 1;
  return 0;
}

export function matchLegacyPharmacy(
  row: LegacyPharmacyRow,
  candidates: readonly LegacyPharmacyCandidate[],
): LegacyPharmacyMatch {
  const postcode = compactPostcode(row.address);
  if (!postcode) return { status: 'unmatched', reason: 'The spreadsheet address has no postcode.' };
  const atPostcode = candidates.filter(candidate => compactPostcode(candidate.postcode ?? candidate.address) === postcode);
  const named = atPostcode.filter(candidate => sharesName(row, candidate));
  if (named.length === 0) {
    return { status: 'unmatched', reason: `No pharmacy at ${postcode} matches this name.` };
  }
  const bestRank = Math.max(...named.map(candidate => rank(candidate.status)));
  const best = named.filter(candidate => rank(candidate.status) === bestRank);
  if (best.length !== 1) {
    return { status: 'unmatched', reason: `More than one pharmacy at ${postcode} matches this name.` };
  }
  const match = best[0];
  if (!match) return { status: 'unmatched', reason: `No pharmacy at ${postcode} matches this name.` };
  return { status: 'matched', organisationId: match.id, name: match.name };
}
