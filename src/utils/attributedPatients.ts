export function organisationRecordKey(id: string) {
  return id.replaceAll('-', '').toLowerCase();
}

export type AttributedStageSplit = {
  referred: number;
  active: number;
  declined: number;
  withdrawn: number;
  suspended: number;
};

export function emptyAttributedSplit(): AttributedStageSplit {
  return { referred: 0, active: 0, declined: 0, withdrawn: 0, suspended: 0 };
}

/** Register stages the overview shows as referred, in care, or declined. */
export function addAttributedStage(target: AttributedStageSplit, stage: string, count: number) {
  const key = stage.trim().toLowerCase();
  if (key === 'referred' || key === 'approved') target.referred += count;
  else if (key === 'hhh approved' || key === 'active') target.active += count;
  else if (key === 'declined' || key === 'rejected') target.declined += count;
  else if (key === 'withdrawn') target.withdrawn += count;
  else if (key === 'suspended') target.suspended += count;
}

export function attributedInCare(split: AttributedStageSplit) {
  return split.referred + split.active;
}

export function attributedCareLabel(split: AttributedStageSplit) {
  if (split.referred && split.active) return 'Referred & active';
  if (split.active) return 'Active';
  return 'Referred';
}

export function attributedClosedNote(split: AttributedStageSplit) {
  const parts: string[] = [];
  if (split.withdrawn) parts.push(`${split.withdrawn} withdrawn`);
  if (split.suspended) parts.push(`${split.suspended} suspended`);
  return parts.join(' · ');
}

export function splitAttributedRecords(records: Array<{ stage: string }>) {
  const split = emptyAttributedSplit();
  for (const record of records) addAttributedStage(split, record.stage, 1);
  return split;
}

/** Sum the patient register's per-pharmacy stage counts. Referred and closed records both count. */
export function attributedPatientCounts(
  scopeCounts: Array<{ organisationId: string; stage?: string; count: number }> | undefined,
  resultCount: number,
) {
  const byOrganisation = new Map<string, number>();
  const stagesByOrganisation = new Map<string, AttributedStageSplit>();
  for (const entry of scopeCounts ?? []) {
    if (!entry.organisationId) continue;
    const key = organisationRecordKey(entry.organisationId);
    byOrganisation.set(key, (byOrganisation.get(key) ?? 0) + entry.count);
    if (!entry.stage) continue;
    const split = stagesByOrganisation.get(key) ?? emptyAttributedSplit();
    addAttributedStage(split, entry.stage, entry.count);
    stagesByOrganisation.set(key, split);
  }
  const summed = [...byOrganisation.values()].reduce((total, count) => total + count, 0);
  return {
    total: byOrganisation.size ? summed : resultCount,
    byOrganisation,
    stagesByOrganisation,
  };
}

export function attributedCountForOrganisation(
  counts: { byOrganisation: Map<string, number> } | null,
  organisationId: string,
) {
  if (!counts) return null;
  return counts.byOrganisation.get(organisationRecordKey(organisationId)) ?? 0;
}

export function attributedStagesForOrganisation(
  counts: { stagesByOrganisation: Map<string, AttributedStageSplit> } | null,
  organisationId: string,
) {
  if (!counts) return null;
  return counts.stagesByOrganisation.get(organisationRecordKey(organisationId)) ?? emptyAttributedSplit();
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
