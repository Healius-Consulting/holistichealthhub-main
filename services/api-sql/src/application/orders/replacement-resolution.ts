import { replacementSerialPolicy } from '../prescriptions/serial-reuse.js';

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

export function replacementPrescriptionPolicy(input: {
  sourceSerial?: string | null;
  sourceIssueDate?: string | null;
  sourceOrderId?: string | null;
  sourcePatientId?: string | null;
  liveOrderId?: string | null;
  livePatientId?: string | null;
  currentPatientId?: string | null;
  replacementSerial?: string | null;
  replacementIssueDate?: string | null;
  replacementHasUsableFile: boolean;
  sourceLines: Array<{ packId?: string | null; formulaId?: string | null; quantity?: number | null; unitsNeededCount?: number | null }>;
  replacementLines: Array<{ packId?: string | null; formulaId?: string | null; quantity?: number | null; unitsNeededCount?: number | null }>;
  asOf?: Date | string;
}) {
  const decision = replacementSerialPolicy(input);
  return {
    allowed: decision.allowed,
    reusesSourceSerial: decision.reusesSourceSerial,
    reason: 'reason' in decision ? decision.reason : undefined,
    occupyingOrderId: 'occupyingOrderId' in decision ? decision.occupyingOrderId : undefined,
  };
}
