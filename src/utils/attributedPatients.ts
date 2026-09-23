export function organisationRecordKey(id: string) {
  return id.replaceAll('-', '').toLowerCase();
}

/** Sum the patient register's per-pharmacy stage counts. Referred and closed records both count. */
export function attributedPatientCounts(
  scopeCounts: Array<{ organisationId: string; count: number }> | undefined,
  resultCount: number,
) {
  const byOrganisation = new Map<string, number>();
  for (const entry of scopeCounts ?? []) {
    if (!entry.organisationId) continue;
    const key = organisationRecordKey(entry.organisationId);
    byOrganisation.set(key, (byOrganisation.get(key) ?? 0) + entry.count);
  }
  const summed = [...byOrganisation.values()].reduce((total, count) => total + count, 0);
  return {
    total: byOrganisation.size ? summed : resultCount,
    byOrganisation,
  };
}

export function attributedCountForOrganisation(
  counts: { byOrganisation: Map<string, number> } | null,
  organisationId: string,
) {
  if (!counts) return null;
  return counts.byOrganisation.get(organisationRecordKey(organisationId)) ?? 0;
}

/** Portfolio total, skipping pharmacies the caller marks as test so they do not inflate the headline. */
export function portfolioAttributedCount<Organisation extends { id: string }>(
  counts: { byOrganisation: Map<string, number> },
  organisations: Organisation[],
  exclude: (organisation: Organisation) => boolean,
) {
  const seen = new Set<string>();
  let total = 0;
  for (const organisation of organisations) {
    const key = organisationRecordKey(organisation.id);
    if (seen.has(key)) continue;
    seen.add(key);
    if (exclude(organisation)) continue;
    total += counts.byOrganisation.get(key) ?? 0;
  }
  return total;
}
