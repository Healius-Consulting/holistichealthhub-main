import { HttpError } from '../../domain/common/errors.js';
import {
  conditionEditDiff,
  conditionEditFailureMessage,
  validateConditionEdit,
} from '../../domain/eligibility/condition-edit.js';
import { formConditionRecords } from '../../domain/eligibility/form-conditions.js';
import type { IntakeRepositoryPort } from '../../repositories/ports/intake.port.js';
import type { PatientRecord, PatientRepositoryPort } from '../../repositories/ports/patient.port.js';

/**
 * Rewriting a patient's recorded conditions, for pharmacy staff and HHH admin alike.
 *
 * Both surfaces run this exact code so that the Portal and the Admin patient
 * register can never drift into disagreeing about a patient's conditions — the
 * complaint that prompted this was precisely that they did.
 *
 * The write order matters. A patient's conditions are read from their source
 * submission's `conditionCodes` array when it has one, and from their own
 * condition rows otherwise. The submission is written first because it is the
 * authoritative copy for the patients that have one; the patient rows are then
 * brought into line so the two never disagree and so patients with no
 * submission are covered too.
 */
export async function rewritePatientConditions(input: {
  patient: PatientRecord;
  conditionCodes: unknown;
  primaryConditionCode: unknown;
  intakeRepo: IntakeRepositoryPort;
  patientRepo: PatientRepositoryPort;
}) {
  const validation = validateConditionEdit({
    conditionCodes: input.conditionCodes,
    primaryConditionCode: input.primaryConditionCode,
  });
  if (!validation.ok) {
    throw new HttpError(400, conditionEditFailureMessage(validation.failure), 'INVALID_CONDITIONS');
  }

  const before = formConditionRecords({ conditions: input.patient.conditions });
  const diff = conditionEditDiff(before, validation.records);

  if (input.patient.sourceSubmissionId) {
    await input.intakeRepo.rewriteSubmissionConditions(input.patient.sourceSubmissionId, validation.records);
  }
  await input.intakeRepo.rewritePatientConditions(input.patient.id, before, validation.records);

  return {
    conditions: validation.records,
    conditionCodes: validation.conditionCodes,
    primaryConditionCode: validation.primaryConditionCode,
    /** Empty-change edits are still recorded: "no change" is itself an audit fact. */
    diff,
    changed: diff.added.length > 0 || diff.removed.length > 0 || diff.primaryChanged,
  };
}
