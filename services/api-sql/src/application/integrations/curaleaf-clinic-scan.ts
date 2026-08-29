import { createHash } from 'node:crypto';
import { HttpError } from '../../domain/common/errors.js';
import { curaleafCataloguePackIsUnsafe, curaleafCatalogueRecordIsUnsafe } from '../../domain/curaleaf-catalogue-label.js';
import { curaleafMoneyPence } from '../../domain/integrations/curaleaf-money.js';

export const CURALEAF_PRESCRIPTION_STATES = ['ACTIVE', 'FULFILLED', 'EXPIRED', 'CANCELLED', 'PENDING'] as const;
export type CuraleafPrescriptionState = (typeof CURALEAF_PRESCRIPTION_STATES)[number];

export const SCAN_PRESCRIPTION_ID_META = 'curaleaf_prescription_id';
export const SCAN_STATUS_META = 'curaleaf_scan_status';

export type ClinicScanStatus = 'processing' | 'ready' | 'failed' | 'reconciliation_required';

export function clinicPrescriptionPlacementEligibility(state: CuraleafPrescriptionState) {
  if (state === 'ACTIVE' || state === 'PENDING') return { eligible: true as const, waiting: state === 'PENDING' };
  return {
    eligible: false as const,
    waiting: false as const,
    reason: state === 'FULFILLED'
      ? 'This Curaleaf prescription has already been fulfilled.'
      : state === 'EXPIRED'
        ? 'This Curaleaf prescription has expired.'
        : 'This Curaleaf prescription has been cancelled.',
  };
}

export type ClinicScanLine = {
  formulaId: string;
  formulaName: string;
  unit: string;
  unitsNeededCount: number;
  unitsAssignedCount: number;
};

export type ClinicScanProduct = {
  id: string;
  formulaId: string;
  formulaName?: string;
  formulaUnit?: string;
  patientPackPrice: string;
  quantity: number;
  state: string;
};

export type ClinicScanMatchedItem = {
  packId: string;
  formulaId: string;
  formulaName: string;
  unit: string;
  packSize: number;
  quantity: number;
  unitsNeededCount: number;
  patientPackPrice: string;
};

export function clinicScanId(organisationId: string, fileId: string) {
  return createHash('sha256').update(`${organisationId}:${fileId}:curaleaf-clinic-scan`).digest('hex');
}

export function curaleafHttpStatus(error: unknown): number | undefined {
  if (!(error instanceof HttpError) || !error.details || typeof error.details !== 'object') return undefined;
  const status = (error.details as { curaleafStatus?: unknown }).curaleafStatus;
  return typeof status === 'number' ? status : undefined;
}

export function prescriptionIdFromUpload(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  if (typeof record.id === 'string' && record.id.trim()) return record.id.trim();
  const nested = record.prescription;
  if (nested && typeof nested === 'object') {
    const id = (nested as Record<string, unknown>).id;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return undefined;
}

export function prescriptionPatientIdentity(prescription: Record<string, unknown>) {
  const nested = prescription.patient && typeof prescription.patient === 'object'
    ? prescription.patient as Record<string, unknown>
    : {};
  const firstName = [nested.firstName, prescription.patientFirstName].find(value => typeof value === 'string') as string | undefined;
  const surname = [nested.surname, nested.lastName, prescription.patientSurname, prescription.patientLastName].find(value => typeof value === 'string') as string | undefined;
  const combinedName = [nested.name, nested.fullName, prescription.patientName, prescription.patientFullName].find(value => typeof value === 'string') as string | undefined;
  const name = combinedName?.trim() || [firstName, surname].filter(Boolean).join(' ').trim();
  const dob = [
    nested.dob,
    nested.dateOfBirth,
    prescription.patientDob,
    prescription.patientDOB,
    prescription.patientDateOfBirth,
  ].find(value => typeof value === 'string') as string | undefined;
  return name && dob ? { name, dob } : null;
}

export function parseClinicPrescription(body: unknown) {
  if (!body || typeof body !== 'object') {
    throw new HttpError(502, 'Curaleaf returned an invalid prescription detail response.', 'CURALEAF_REQUEST_FAILED');
  }
  const prescription = body as Record<string, unknown>;
  const state = prescription.state;
  if (
    typeof prescription.id !== 'string'
    || typeof prescription.serialNumber !== 'string'
    || typeof prescription.prescriberId !== 'string'
    || typeof prescription.prescriberName !== 'string'
    || typeof prescription.issueDate !== 'string'
    || typeof prescription.expiryDate !== 'string'
    || typeof state !== 'string'
    || !CURALEAF_PRESCRIPTION_STATES.includes(state as CuraleafPrescriptionState)
  ) {
    throw new HttpError(502, 'Curaleaf returned an invalid prescription detail response.', 'CURALEAF_REQUEST_FAILED');
  }
  const rawItems = Array.isArray(prescription.items)
    ? prescription.items
    : Array.isArray(prescription.formulas)
      ? prescription.formulas
      : null;
  if (!rawItems) {
    throw new HttpError(502, 'Curaleaf returned an invalid prescription detail response.', 'CURALEAF_REQUEST_FAILED');
  }
  const items = rawItems.map(item => parseClinicPrescriptionLine(item));
  if (!items.length) {
    throw new HttpError(502, 'Curaleaf returned a prescription without medicine lines.', 'CURALEAF_REQUEST_FAILED');
  }
  return {
    id: prescription.id,
    serialNumber: prescription.serialNumber,
    state: state as CuraleafPrescriptionState,
    issueDate: prescription.issueDate,
    expiryDate: prescription.expiryDate,
    prescriberId: prescription.prescriberId,
    prescriberName: prescription.prescriberName,
    items,
    patient: prescriptionPatientIdentity(prescription),
  };
}

function parseClinicPrescriptionLine(value: unknown): ClinicScanLine {
  if (!value || typeof value !== 'object') {
    throw new HttpError(502, 'Curaleaf returned an invalid prescription line.', 'CURALEAF_REQUEST_FAILED');
  }
  const item = value as Record<string, unknown>;
  if (
    typeof item.formulaId !== 'string'
    || typeof item.formulaName !== 'string'
    || typeof item.unit !== 'string'
    || !Number.isInteger(item.unitsNeededCount)
    || Number(item.unitsNeededCount) <= 0
    || !Number.isInteger(item.unitsAssignedCount)
  ) {
    throw new HttpError(502, 'Curaleaf returned an invalid prescription line.', 'CURALEAF_REQUEST_FAILED');
  }
  return {
    formulaId: item.formulaId,
    formulaName: item.formulaName,
    unit: item.unit,
    unitsNeededCount: Number(item.unitsNeededCount),
    unitsAssignedCount: Number(item.unitsAssignedCount),
  };
}

export function parseClinicPrescriber(body: unknown) {
  if (!body || typeof body !== 'object') {
    throw new HttpError(502, 'Curaleaf returned an invalid prescriber response.', 'CURALEAF_REQUEST_FAILED');
  }
  const prescriber = body as Record<string, unknown>;
  if (
    typeof prescriber.id !== 'string'
    || typeof prescriber.pin !== 'string'
    || typeof prescriber.name !== 'string'
    || typeof prescriber.initials !== 'string'
  ) {
    throw new HttpError(502, 'Curaleaf returned an invalid prescriber response.', 'CURALEAF_REQUEST_FAILED');
  }
  return {
    id: prescriber.id,
    pin: prescriber.pin,
    name: prescriber.name,
    initials: prescriber.initials,
    gmcNumber: typeof prescriber.gmcNumber === 'number' ? prescriber.gmcNumber : null,
    gphcNumber: typeof prescriber.gphcNumber === 'string' ? prescriber.gphcNumber : null,
  };
}

export const CLINIC_SCAN_PACK_UNAVAILABLE = 'Curaleaf has not supplied an active pack that can be matched for this prescription. Contact your HHH administrator.';

export function matchClinicPrescriptionPacks(lines: ClinicScanLine[], products: ClinicScanProduct[]): ClinicScanMatchedItem[] {
  return lines.map(line => {
    if (curaleafCatalogueRecordIsUnsafe({ formulaName: line.formulaName, formulaUnit: line.unit })) {
      throw new HttpError(409, CLINIC_SCAN_PACK_UNAVAILABLE, 'CURALEAF_PACK_MATCH_UNAVAILABLE');
    }
    const candidates = products
      .filter(product => (
        product.state === 'ACTIVE'
        && product.formulaId === line.formulaId
        && product.quantity > 0
        && line.unitsNeededCount % product.quantity === 0
        && !curaleafCataloguePackIsUnsafe(product)
      ))
      .map(product => ({
        product,
        packQuantity: line.unitsNeededCount / product.quantity,
        totalPence: curaleafMoneyPence(product.patientPackPrice, 'patient pack price') * (line.unitsNeededCount / product.quantity),
      }))
      .sort((left, right) => left.packQuantity - right.packQuantity || left.totalPence - right.totalPence || left.product.id.localeCompare(right.product.id));
    if (!candidates.length) {
      throw new HttpError(409, `Curaleaf has not supplied an active pack that exactly fulfils ${line.formulaName}. Contact your HHH administrator.`, 'CURALEAF_PACK_MATCH_UNAVAILABLE');
    }
    const best = candidates[0]!;
    const equallyRanked = candidates.filter(candidate => candidate.packQuantity === best.packQuantity && candidate.totalPence === best.totalPence);
    if (equallyRanked.length > 1) {
      throw new HttpError(409, `Curaleaf returned more than one equivalent pack for ${line.formulaName}. Contact your HHH administrator before taking payment.`, 'CURALEAF_PACK_MATCH_AMBIGUOUS');
    }
    return {
      packId: best.product.id,
      formulaId: line.formulaId,
      formulaName: line.formulaName,
      unit: line.unit,
      packSize: best.product.quantity,
      quantity: best.packQuantity,
      unitsNeededCount: line.unitsNeededCount,
      patientPackPrice: best.product.patientPackPrice,
    };
  });
}

export function asClinicScanProducts(records: unknown[]): ClinicScanProduct[] {
  return records.flatMap(record => {
    if (!record || typeof record !== 'object') return [];
    const product = record as Record<string, unknown>;
    if (
      typeof product.id !== 'string'
      || typeof product.formulaId !== 'string'
      || typeof product.patientPackPrice !== 'string'
      || typeof product.quantity !== 'number'
      || typeof product.state !== 'string'
    ) return [];
    const pack = {
      id: product.id,
      formulaId: product.formulaId,
      formulaName: typeof product.formulaName === 'string' ? product.formulaName : undefined,
      formulaUnit: typeof product.formulaUnit === 'string' ? product.formulaUnit : undefined,
      patientPackPrice: product.patientPackPrice,
      quantity: product.quantity,
      state: product.state,
    };
    return curaleafCataloguePackIsUnsafe(pack) ? [] : [pack];
  });
}
