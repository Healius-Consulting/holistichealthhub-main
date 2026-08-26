type SourceLine = {
  packId: string;
  quantity: number;
  fixedPatientPricePence: number;
};

type FulfilmentLine = {
  productId?: string | null;
  ordered?: number | null;
  shipped?: number | null;
  received?: number | null;
  cancelledRemainder?: number | null;
  reconciliationRequired?: boolean | null;
};

export function replacementSupplierResolution(input: {
  hasPurchaseOrder: boolean;
  cancellationConfirmed: boolean;
  fulfilmentLines: FulfilmentLine[];
}) {
  if (!input.hasPurchaseOrder) return { resolved: true as const };
  if (!input.cancellationConfirmed) {
    return { resolved: false as const, reason: 'supplier_cancellation_not_confirmed' };
  }
  if (!input.fulfilmentLines.length || input.fulfilmentLines.some(line => line.reconciliationRequired)) {
    return { resolved: false as const, reason: 'supplier_lines_require_reconciliation' };
  }
  for (const line of input.fulfilmentLines) {
    const ordered = Math.max(0, Math.trunc(Number(line.ordered || 0)));
    const shipped = Math.max(0, Math.trunc(Number(line.shipped || 0)));
    const cancelled = Math.max(0, Math.trunc(Number(line.cancelledRemainder || 0)));
    if (ordered <= 0 || shipped + cancelled !== ordered) {
      return { resolved: false as const, reason: 'supplier_split_not_fully_resolved' };
    }
  }
  return { resolved: true as const };
}

export function replacementAllocationAmount(input: {
  activeAllocationPence: number;
  hasPurchaseOrder: boolean;
  sourceLines: SourceLine[];
  fulfilmentLines: FulfilmentLine[];
}) {
  const active = Math.max(0, Math.round(input.activeAllocationPence));
  if (!input.hasPurchaseOrder) return active;
  if (input.fulfilmentLines.some(line => line.reconciliationRequired)) {
    throw new Error('Supplier fulfilment lines require reconciliation.');
  }
  const shipped = input.fulfilmentLines.reduce((sum, line) => sum + Math.max(0, Number(line.shipped || 0)), 0);
  if (shipped === 0) return active;

  const sourceByPack = new Map<string, SourceLine[]>();
  for (const line of input.sourceLines) {
    const rows = sourceByPack.get(line.packId) ?? [];
    rows.push(line);
    sourceByPack.set(line.packId, rows);
  }

  let remainderPence = 0;
  for (const line of input.fulfilmentLines) {
    const count = Math.max(0, Math.trunc(Number(line.cancelledRemainder || 0)));
    if (count === 0) continue;
    const packId = String(line.productId || '').trim();
    const candidates = sourceByPack.get(packId) ?? [];
    if (!packId || candidates.length !== 1) {
      throw new Error('Cancelled supplier remainder could not be matched to one priced order line.');
    }
    remainderPence += Math.max(0, Number(candidates[0]!.fixedPatientPricePence || 0)) * count;
  }
  if (remainderPence <= 0) throw new Error('The cancelled supplier remainder has no transferable patient value.');
  if (remainderPence > active) throw new Error('The cancelled remainder exceeds the active payment allocation.');
  return remainderPence;
}

function normalisedBasket(lines: Array<{ packId: string; quantity: number }>) {
  return lines
    .map(line => ({ packId: String(line.packId || '').trim(), quantity: Math.trunc(Number(line.quantity)) }))
    .filter(line => line.packId && line.quantity > 0)
    .sort((left, right) => left.packId.localeCompare(right.packId));
}

export function replacementPrescriptionPolicy(input: {
  hasPurchaseOrder: boolean;
  sourcePrescriptionId?: string | null;
  sourcePrescriptionState?: string | null;
  sourceExpiryDate?: string | null;
  sourceLines: Array<{ packId: string; quantity: number }>;
  replacementPrescriptionIds: string[];
  replacementHasFiles: boolean;
  replacementLines: Array<{ packId: string; quantity: number }>;
  asOf?: Date;
}) {
  const sourceId = String(input.sourcePrescriptionId || '').trim();
  const replacementIds = input.replacementPrescriptionIds.map(id => String(id || '').trim()).filter(Boolean);
  const reusesSource = Boolean(sourceId && replacementIds.includes(sourceId));
  if (input.hasPurchaseOrder && reusesSource) {
    return { allowed: false as const, reusesSource, reason: 'new_prescription_required_after_purchase_order' };
  }
  if (!reusesSource) {
    return input.replacementHasFiles
      ? { allowed: true as const, reusesSource: false }
      : { allowed: false as const, reusesSource: false, reason: 'replacement_prescription_file_required' };
  }
  const state = String(input.sourcePrescriptionState || '').toUpperCase();
  const expiry = Date.parse(String(input.sourceExpiryDate || ''));
  const asOf = input.asOf ?? new Date();
  const exactBasket = JSON.stringify(normalisedBasket(input.sourceLines)) === JSON.stringify(normalisedBasket(input.replacementLines));
  if (!['PENDING', 'ACTIVE'].includes(state) || !Number.isFinite(expiry) || expiry < asOf.getTime() || !exactBasket) {
    return { allowed: false as const, reusesSource: true, reason: 'source_prescription_not_reusable' };
  }
  return { allowed: true as const, reusesSource: true };
}
