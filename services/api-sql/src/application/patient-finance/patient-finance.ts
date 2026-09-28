import { createHash } from 'node:crypto';
import { inactiveFromLastPayment } from '../../domain/commercial/rules.js';
import { HttpError } from '../../domain/common/errors.js';
import type { PatientFinanceRepositoryPort } from '../../repositories/ports/patient-finance.port.js';
import type { PatientRepositoryPort } from '../../repositories/ports/patient.port.js';

export const REFERRAL_FEE_PENCE = 5_000;
export const ANNUAL_PATIENT_FEE_PENCE = 4_000;

export type PatientFinanceDeps = {
  patientRepo: PatientRepositoryPort;
  patientFinanceRepo: PatientFinanceRepositoryPort;
};

function stableId(...parts: string[]) {
  return createHash('sha256').update(parts.join(':')).digest('hex');
}

function referralFeeIdempotencyKey(patientId: string) {
  return stableId(patientId, 'NEW_REFERRAL');
}

function annualFeeIdempotencyKey(patientId: string, dueDate: string) {
  return stableId(patientId, 'ANNUAL_PATIENT', dueDate);
}

export function dateOnlyInLondon(date: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

/** Anniversary date in a given calendar year, clamping day for shorter months (e.g. 29 Feb → 28 Feb). */
export function anniversaryDate(originalDate: string, year: number): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(originalDate);
  if (!match?.[2] || !match[3]) return null;
  const monthValue = match[2];
  const dayValue = match[3];
  const month = Number(monthValue);
  const day = Number(dayValue);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${monthValue}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

/**
 * SQL Patient has no referralCompletedAt; activatedAt is the anniversary anchor
 * (set when a referred patient is first activated or on first collected dispense).
 */
export function evaluateAnnualFeeAccrual(input: {
  activatedAt: string | null;
  statusChangedAt: string | null;
  todayLondon: string;
}): { dueDate: string } | null {
  if (!input.activatedAt) return null;
  const year = Number(input.todayLondon.slice(0, 4));
  const anniversary = anniversaryDate(input.activatedAt, year);
  const activationYear = Number(input.activatedAt.slice(0, 4));
  if (!anniversary || year <= activationYear || anniversary !== input.todayLondon) {
    return null;
  }
  const statusChangedDate = input.statusChangedAt?.slice(0, 10) ?? null;
  if (statusChangedDate && statusChangedDate > anniversary) {
    return null;
  }
  return { dueDate: anniversary };
}

export function addMonthsClamped(value: Date, months: number): Date {
  const year = value.getUTCFullYear();
  const month = value.getUTCMonth() + months;
  const day = value.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay), 12, 0, 0, 0));
}

/** Mirrors legacy nextApptEst: +1 month after first dispense, +3 months after subsequent ones. */
export function estimateNextAppointmentFromDispenses(
  dispenses: Array<{ dispensedAt?: string }>,
): Date | null {
  const latest = dispenses[0]?.dispensedAt;
  if (!latest) return null;
  const collectionDate = new Date(latest);
  if (!Number.isFinite(collectionDate.getTime())) return null;
  return addMonthsClamped(collectionDate, dispenses.length === 1 ? 1 : 3);
}

export function assertPatientEligibleForOrder(patient: { status: 'REFERRED' | 'ACTIVE' | 'INACTIVE' } | null) {
  if (!patient) {
    throw new HttpError(404, 'Patient not found.', 'NOT_FOUND');
  }
}

export async function activatePatientForOrder(
  deps: PatientFinanceDeps,
  input: { organisationId: string; patientId: string; orderId: string; activatedAt?: string },
) {
  const patient = await deps.patientRepo.findPatientById(input.organisationId, input.patientId);
  if (!patient || (patient.status !== 'REFERRED' && patient.status !== 'INACTIVE')) {
    return { patientId: input.patientId, activated: false };
  }
  const activatedAt = input.activatedAt ?? new Date().toISOString();
  await deps.patientRepo.updatePatientStatus({
    id: input.patientId,
    organisationId: input.organisationId,
    status: 'ACTIVE',
    activatedAt: patient.activatedAt ?? activatedAt,
    statusChangedAt: activatedAt,
  });
  return { patientId: input.patientId, activated: true };
}

export async function recordCollectedDispense(
  deps: PatientFinanceDeps,
  input: {
    organisationId: string;
    patientId: string;
    orderId: string;
    actorUid: string;
    dispenseKey: string;
    collectedAt?: string;
  },
) {
  const patient = await deps.patientRepo.findPatientById(input.organisationId, input.patientId);
  if (!patient) {
    throw new HttpError(404, 'Patient not found.', 'NOT_FOUND');
  }

  const collectedAt = input.collectedAt ?? new Date().toISOString();
  const existingDispense = await deps.patientFinanceRepo.findDispenseEvent(input.orderId, input.dispenseKey);
  if (existingDispense) {
    return { patientId: input.patientId, feeCreated: false, idempotent: true };
  }

  await deps.patientFinanceRepo.insertDispenseEvent({
    organisationId: input.organisationId,
    patientId: input.patientId,
    orderId: input.orderId,
    dispenseKey: input.dispenseKey,
    recordedByUid: input.actorUid,
    dispensedAt: collectedAt,
  });

  if (patient.status === 'REFERRED') {
    await deps.patientRepo.updatePatientStatus({
      id: input.patientId,
      organisationId: input.organisationId,
      status: 'ACTIVE',
      activatedAt: patient.activatedAt ?? collectedAt,
      statusChangedAt: collectedAt,
    });
  }

  let feeCreated = false;
  const hasReferralFee = await deps.patientFinanceRepo.hasNewReferralFee(input.patientId);
  if (!hasReferralFee) {
    await deps.patientFinanceRepo.insertReferralFeeEvent({
      organisationId: input.organisationId,
      patientId: input.patientId,
      orderId: input.orderId,
      kind: 'NEW_REFERRAL',
      amountPence: REFERRAL_FEE_PENCE,
      dueDate: dateOnlyInLondon(new Date(collectedAt)),
      status: 'accrued',
      idempotencyKey: referralFeeIdempotencyKey(input.patientId),
    });
    feeCreated = true;
  }

  return { patientId: input.patientId, feeCreated, idempotent: false };
}

export async function accrueAnnualPatientFees(deps: PatientFinanceDeps, asOf = new Date()) {
  const today = dateOnlyInLondon(asOf);
  const patients = await deps.patientRepo.listActivePatients(2_000);
  let created = 0;
  let skipped = 0;
  for (const patient of patients) {
    const evaluation = evaluateAnnualFeeAccrual({
      activatedAt: patient.activatedAt,
      statusChangedAt: patient.statusChangedAt,
      todayLondon: today,
    });
    if (!evaluation) {
      skipped += 1;
      continue;
    }
    const inserted = await deps.patientFinanceRepo.insertReferralFeeEvent({
      organisationId: patient.organisationId,
      patientId: patient.id,
      kind: 'ANNUAL_PATIENT',
      amountPence: ANNUAL_PATIENT_FEE_PENCE,
      dueDate: evaluation.dueDate,
      status: 'accrued',
      idempotencyKey: annualFeeIdempotencyKey(patient.id, evaluation.dueDate),
    });
    if (inserted) created += 1;
    else skipped += 1;
  }
  return { asOf: today, activePatientsChecked: patients.length, created, skipped };
}

/**
 * Inactive means the patient has not paid for 56 days. It is not clinic retention.
 * The clock starts at the payment and does not restart if that order is refunded.
 */
export async function updatePatientRetentionStates(deps: PatientFinanceDeps, asOf = new Date()) {
  const patients = await deps.patientRepo.listActivePatients(2_000);
  const summary = { checked: patients.length, skipped: 0, inactive: 0 };
  for (const patient of patients) {
    const lastPaidAt = await deps.patientFinanceRepo.latestPaidAt(patient.id);
    if (!inactiveFromLastPayment(lastPaidAt, asOf)) {
      summary.skipped += 1;
      continue;
    }
    await deps.patientRepo.updatePatientStatus({
      id: patient.id,
      organisationId: patient.organisationId,
      status: 'INACTIVE',
      statusChangedAt: asOf.toISOString(),
    });
    summary.inactive += 1;
  }
  return summary;
}

export async function promotePatientAfterCuraleafPlacement(
  deps: PatientFinanceDeps,
  order: { id: string; organisationId: string; patientId: string | null | undefined },
  curaleafResult: { purchaseOrder?: { id?: string | null } | null; skipped?: boolean } | null | undefined,
) {
  if (!order.patientId) return { activated: false };
  if (!curaleafResult?.purchaseOrder?.id) return { activated: false };
  return activatePatientForOrder(deps, {
    organisationId: order.organisationId,
    patientId: order.patientId,
    orderId: order.id,
  });
}
