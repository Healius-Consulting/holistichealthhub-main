export type PlacementRxItem = {
  productId: string;
  count: number;
  formulaId: string;
  unitsNeededCount: number;
  packSize: number;
};

export type PlacementUnitsResult = {
  items: PlacementRxItem[];
  missingPackSize: string[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function positiveInt(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

export function packIdFromRecord(record: Record<string, unknown>): string {
  return String(record.productId || record.packId || record.id || '').trim();
}

export function packSizeFromLineRecord(record: unknown): number | null {
  const entry = asRecord(record);
  return positiveInt(entry.packSize) ?? positiveInt(entry.pack_size);
}

export function packSizeFromProductRecord(record: unknown): number | null {
  const entry = asRecord(record);
  return packSizeFromLineRecord(entry) ?? positiveInt(entry.quantity);
}

export function resolveUnitsNeededCount(input: {
  packCount: unknown;
  packSize?: unknown;
}): { unitsNeededCount: number; packSize: number } | null {
  const packCount = positiveInt(input.packCount);
  const packSize = positiveInt(input.packSize);
  if (!packCount || !packSize) return null;
  return { unitsNeededCount: packCount * packSize, packSize };
}

function matchingPrescriptionItem(
  line: Record<string, unknown>,
  prescriptionItems: Array<Record<string, unknown>>,
) {
  const packId = packIdFromRecord(line);
  const formulaId = typeof line.formulaId === 'string' ? line.formulaId : '';
  return prescriptionItems.find((item) => {
    const itemPackId = packIdFromRecord(item);
    if (packId && itemPackId && packId === itemPackId) return true;
    const itemFormulaId = typeof item.formulaId === 'string' ? item.formulaId : '';
    return Boolean(packId && formulaId && itemFormulaId && packId === itemPackId && formulaId === itemFormulaId);
  }) ?? prescriptionItems.find((item) => {
    const itemFormulaId = typeof item.formulaId === 'string' ? item.formulaId : '';
    return Boolean(formulaId && itemFormulaId && formulaId === itemFormulaId && !packIdFromRecord(item));
  }) ?? null;
}

export function prescriptionItemsFromSnapshot(snapshot: unknown): Array<Record<string, unknown>> {
  const root = asRecord(snapshot);
  const prescriptions = Array.isArray(root.prescriptions) ? root.prescriptions : [];
  return prescriptions.flatMap((entry) => {
    const rx = asRecord(entry);
    return Array.isArray(rx.items) ? rx.items.map(asRecord) : [];
  });
}

export function catalogPackSize(
  packId: string,
  catalogPackSizeByPackId?: ReadonlyMap<string, number>,
) {
  if (!packId || !catalogPackSizeByPackId) return null;
  return positiveInt(catalogPackSizeByPackId.get(packId));
}

export function buildPrescriptionPlacementItems(input: {
  rawLines: Array<Record<string, unknown>>;
  prescriptionItems?: Array<Record<string, unknown>>;
  catalogPackSizeByPackId?: ReadonlyMap<string, number>;
}): PlacementUnitsResult {
  const prescriptionItems = input.prescriptionItems ?? [];
  const items: PlacementRxItem[] = [];
  const missingPackSize: string[] = [];

  for (const raw of input.rawLines) {
    const line = asRecord(raw);
    const productId = packIdFromRecord(line);
    const count = positiveInt(line.quantity ?? line.qty ?? line.count) ?? 0;
    const matched = matchingPrescriptionItem(line, prescriptionItems);
    const formulaId = String(line.formulaId || matched?.formulaId || '').trim();
    if (!productId || count <= 0 || !formulaId || formulaId === productId) continue;

    const packSize = packSizeFromLineRecord(line)
      ?? packSizeFromLineRecord(matched)
      ?? catalogPackSize(productId, input.catalogPackSizeByPackId);
    const resolved = resolveUnitsNeededCount({ packCount: count, packSize });
    if (!resolved) {
      missingPackSize.push(productId);
      continue;
    }

    items.push({
      productId,
      count,
      formulaId,
      unitsNeededCount: resolved.unitsNeededCount,
      packSize: resolved.packSize,
    });
  }

  return { items, missingPackSize };
}

export function stampPackFieldsOnSnapshot(
  snapshot: unknown,
  lineItems: Array<{ packId?: string; productId?: string; packSize?: number; quantity?: number }>,
) {
  const root = asRecord(snapshot);
  const byPack = new Map<string, { packSize?: number; quantity?: number }>();
  for (const item of lineItems) {
    const id = String(item.packId || item.productId || '').trim();
    if (id) byPack.set(id, item);
  }
  if (!Array.isArray(root.lineItems)) return root;
  return {
    ...root,
    lineItems: root.lineItems.map((raw) => {
      const item = asRecord(raw);
      const match = byPack.get(packIdFromRecord(item));
      const packSize = packSizeFromLineRecord(item) ?? positiveInt(match?.packSize);
      const count = positiveInt(item.quantity ?? item.qty ?? item.count ?? match?.quantity);
      const resolved = resolveUnitsNeededCount({ packCount: count, packSize });
      return {
        ...item,
        ...(packSize ? { packSize } : {}),
        ...(resolved ? { unitsNeededCount: resolved.unitsNeededCount } : {}),
      };
    }),
  };
}
