import { dataConnect } from '../../bootstrap/firebase.js';
import { HttpError } from '../../domain/common/errors.js';
import { asUuid } from '../../domain/common/uuid.js';
import { formConditionRecords, type FormConditionRecord } from '../../domain/eligibility/form-conditions.js';
import type {
  ActivateSubmissionInput,
  CreateSubmissionInput,
  DeclinedSubmissionRecord,
  DeclineSubmissionInput,
  IdempotentSubmissionRecord,
  IntakeRepositoryPort,
  PlatformSubmissionRecord,
  ReassignSubmissionInput,
  RetentionCandidateRecord,
  SubmissionConditionRecord,
  TenantPendingEnquiryRecord,
  UpdateSubmissionFollowUpInput,
  WithdrawSubmissionInput,
} from '../ports/intake.port.js';

const GET_SUBMISSION_BY_ID_GQL = `
  query GetEligibilitySubmissionById($id: UUID!) {
    eligibilitySubmission(key: { id: $id }) {
      id
      sourceOrganisationId
      assignedOrganisationId
      sourceType
      firstName
      surname
      dob
      mobile
      email
      emailHash
      postcode
      triedTwoTreatments
      psychiatricExclusion
      heardAbout
      conditionCodes
      primaryConditionCode
      idempotencyKeyHash
      assignmentStatus
      assignmentVersion
      pharmacyAccessStatus
      followUpStatus
      pharmacyReviewStatus
      outcomeStatus
      onboardingDecision
      assignmentReason
      privateAllocationNote
      privateOnboardingNote
      declineRule
      declineReason
      consentVersion
      referralConsent
      dataSharingConsent
      marketingConsent
      privacyNoticeVersion
      submittedAt
      allocationCompletedAt
      operationalStartedAt
      reviewedAt
      completedAt
      updatedAt
    }
  }
`;

const LIST_TENANT_PENDING_ENQUIRIES_GQL = `
  query ListTenantPendingEnquiries($organisationId: UUID!, $limit: Int!) {
    eligibilitySubmissions(
      where: {
        _and: [
          { pharmacyAccessStatus: { eq: WITHHELD } }
          { outcomeStatus: { eq: OPEN } }
          { assignedOrganisationId: { eq: $organisationId } }
        ]
      }
      limit: $limit
    ) {
      id
      submittedAt
      followUpStatus
      sourceType
      firstName
      surname
      dob
      email
      mobile
      postcode
      conditionCodes
      primaryConditionCode
      triedTwoTreatments
      psychiatricExclusion
      heardAbout
    }
  }
`;

const LIST_PLATFORM_SUBMISSIONS_GQL = `
  query ListPlatformEligibilitySubmissions($limit: Int!) {
    eligibilitySubmissions(limit: $limit) {
      id
      sourceOrganisationId
      assignedOrganisationId
      sourceType
      firstName
      surname
      dob
      mobile
      email
      postcode
      triedTwoTreatments
      psychiatricExclusion
      heardAbout
      conditionCodes
      primaryConditionCode
      assignmentStatus
      assignmentVersion
      pharmacyAccessStatus
      followUpStatus
      pharmacyReviewStatus
      outcomeStatus
      onboardingDecision
      assignmentReason
      privateAllocationNote
      privateOnboardingNote
      declineRule
      declineReason
      consentVersion
      referralConsent
      dataSharingConsent
      marketingConsent
      privacyNoticeVersion
      submittedAt
      allocationCompletedAt
      operationalStartedAt
      reviewedAt
      completedAt
      updatedAt
    }
  }
`;

const LIST_SUBMISSION_CONDITIONS_GQL = `
  query ListEligibilityConditionsForSubmission($submissionId: UUID!) {
    eligibilityConditions(where: { submissionId: { eq: $submissionId } }) {
      conditionCode
      primary
    }
  }
`;

const CREATE_SUBMISSION_GQL = `
  mutation CreateEligibilitySubmission(
    $sourceOrganisationId: UUID
    $assignedOrganisationId: UUID
    $sourceType: ReferralSourceType!
    $firstName: String!
    $surname: String!
    $dob: Date!
    $mobile: String!
    $email: String!
    $emailHash: String!
    $postcode: String!
    $triedTwoTreatments: Boolean!
    $psychiatricExclusion: Boolean!
    $heardAbout: String
    $conditionCodes: [String!]
    $primaryConditionCode: String
    $idempotencyKeyHash: String!
    $assignmentStatus: AssignmentStatus!
    $pharmacyAccessStatus: AccessStatus!
    $consentVersion: String!
    $referralConsent: Boolean!
    $dataSharingConsent: Boolean!
    $marketingConsent: Boolean!
    $privacyNoticeVersion: String!
    $termsVersion: String
    $referralConsentVersion: String
    $dataSharingConsentVersion: String
    $marketingConsentVersion: String
    $submissionIpHash: String
    $outcomeStatus: OutcomeStatus!
    $declineRule: String
    $declinedAt: Timestamp
  ) {
    eligibilitySubmission_insert(data: {
      sourceOrganisationId: $sourceOrganisationId
      assignedOrganisationId: $assignedOrganisationId
      sourceType: $sourceType
      firstName: $firstName
      surname: $surname
      dob: $dob
      mobile: $mobile
      email: $email
      emailHash: $emailHash
      postcode: $postcode
      triedTwoTreatments: $triedTwoTreatments
      psychiatricExclusion: $psychiatricExclusion
      heardAbout: $heardAbout
      conditionCodes: $conditionCodes
      primaryConditionCode: $primaryConditionCode
      idempotencyKeyHash: $idempotencyKeyHash
      assignmentStatus: $assignmentStatus
      pharmacyAccessStatus: $pharmacyAccessStatus
      consentVersion: $consentVersion
      referralConsent: $referralConsent
      dataSharingConsent: $dataSharingConsent
      marketingConsent: $marketingConsent
      privacyNoticeVersion: $privacyNoticeVersion
      termsVersion: $termsVersion
      referralConsentVersion: $referralConsentVersion
      dataSharingConsentVersion: $dataSharingConsentVersion
      marketingConsentVersion: $marketingConsentVersion
      submissionIpHash: $submissionIpHash
      outcomeStatus: $outcomeStatus
      declineRule: $declineRule
      declinedAt: $declinedAt
    })
  }
`;

const GET_SUBMISSION_BY_IDEMPOTENCY_HASH_GQL = `
  query GetSubmissionByIdempotencyHash($idempotencyKeyHash: String!) {
    eligibilitySubmissions(
      where: { idempotencyKeyHash: { eq: $idempotencyKeyHash } }
      limit: 1
    ) {
      id
      assignedOrganisationId
      assignmentStatus
      submittedAt
    }
  }
`;

const UPDATE_SUBMISSION_CONDITIONS_GQL = `
  mutation UpdateEligibilitySubmissionConditions(
    $id: UUID!
    $conditionCodes: [String!]
    $primaryConditionCode: String
  ) {
    eligibilitySubmission_update(
      key: { id: $id }
      data: {
        conditionCodes: $conditionCodes
        primaryConditionCode: $primaryConditionCode
        updatedAt_expr: "request.time"
      }
    )
  }
`;

const UPSERT_SUBMISSION_CONDITION_GQL = `
  mutation UpsertSubmissionCondition(
    $submissionId: UUID!
    $conditionCode: String!
    $primary: Boolean!
  ) {
    eligibilityCondition_upsert(data: {
      submissionId: $submissionId
      conditionCode: $conditionCode
      primary: $primary
    })
  }
`;

const DELETE_SUBMISSION_CONDITION_GQL = `
  mutation DeleteSubmissionCondition($submissionId: UUID!, $conditionCode: String!) {
    eligibilityCondition_delete(key: { submissionId: $submissionId, conditionCode: $conditionCode })
  }
`;

const DELETE_PATIENT_CONDITION_GQL = `
  mutation DeletePatientCondition($patientId: UUID!, $conditionCode: String!) {
    patientCondition_delete(key: { patientId: $patientId, conditionCode: $conditionCode })
  }
`;

const REASSIGN_SUBMISSION_GQL = `
  mutation ReassignPendingSubmission(
    $id: UUID!
    $newOrganisationId: UUID!
    $expectedAssignmentVersion: Int!
    $newAssignmentVersion: Int!
    $actorUid: String!
    $reasonCode: String!
    $note: String
    $previousOrganisationId: UUID
    $notePresent: Boolean!
    $patientAgreementChannel: String
  ) @transaction {
    updated: eligibilitySubmission_updateMany(
      where: {
        id: { eq: $id }
        assignmentVersion: { eq: $expectedAssignmentVersion }
        pharmacyAccessStatus: { eq: WITHHELD }
        outcomeStatus: { eq: OPEN }
      }
      data: {
        assignedOrganisationId: $newOrganisationId
        assignmentStatus: PROVISIONAL
        assignmentVersion: $newAssignmentVersion
        assignmentReason: $reasonCode
        privateAllocationNote: $note
        updatedAt_expr: "request.time"
      }
    ) @check(expr: "this == 1", message: "INTAKE_STATE_CONFLICT") @redact
    eligibilityAssignmentEvent_insert(data: {
      submissionId: $id
      previousOrganisationId: $previousOrganisationId
      newOrganisationId: $newOrganisationId
      actorUid: $actorUid
      action: "pending_reassigned"
      reasonCode: $reasonCode
      previousAssignmentVersion: $expectedAssignmentVersion
      newAssignmentVersion: $newAssignmentVersion
      notePresent: $notePresent
      patientAgreementChannel: $patientAgreementChannel
      patientAgreementRecordedAt_expr: "request.time"
    })
  }
`;

const UPDATE_SUBMISSION_FOLLOW_UP_GQL = `
  mutation UpdateSubmissionFollowUp(
    $id: UUID!
    $expectedAssignmentVersion: Int!
    $newAssignmentVersion: Int!
    $followUpStatus: FollowUpStatus!
  ) @transaction {
    updated: eligibilitySubmission_updateMany(
      where: {
        id: { eq: $id }
        assignmentVersion: { eq: $expectedAssignmentVersion }
        pharmacyAccessStatus: { eq: WITHHELD }
        outcomeStatus: { eq: OPEN }
      }
      data: {
        followUpStatus: $followUpStatus
        assignmentVersion: $newAssignmentVersion
        updatedAt_expr: "request.time"
      }
    ) @check(expr: "this == 1", message: "INTAKE_STATE_CONFLICT") @redact
  }
`;

const ACTIVATE_SUBMISSION_GQL = `
  mutation ActivateSubmission(
    $id: UUID!
    $patientId: UUID!
    $organisationId: UUID!
    $expectedAssignmentVersion: Int!
    $newAssignmentVersion: Int!
    $firstName: String!
    $surname: String!
    $dob: Date!
    $email: String!
    $emailHash: String!
    $mobile: String!
    $postcode: String!
    $onboardingNote: String
  ) @transaction {
    updated: eligibilitySubmission_updateMany(
      where: {
        id: { eq: $id }
        assignedOrganisationId: { eq: $organisationId }
        assignmentVersion: { eq: $expectedAssignmentVersion }
        pharmacyAccessStatus: { eq: WITHHELD }
        outcomeStatus: { eq: OPEN }
      }
      data: {
        assignmentStatus: CONFIRMED
        pharmacyAccessStatus: ACTIVATED
        onboardingDecision: APPROVED
        outcomeStatus: COMPLETED
        assignmentVersion: $newAssignmentVersion
        privateOnboardingNote: $onboardingNote
        allocationCompletedAt_expr: "request.time"
        completedAt_expr: "request.time"
        updatedAt_expr: "request.time"
      }
    ) @check(expr: "this == 1", message: "INTAKE_STATE_CONFLICT") @redact
    patient_insert(data: {
      id: $patientId
      organisationId: $organisationId
      sourceSubmissionId: $id
      firstName: $firstName
      surname: $surname
      dob: $dob
      email: $email
      mobile: $mobile
      postcode: $postcode
      status: REFERRED
      activatedAt_expr: "request.time"
      statusChangedAt_expr: "request.time"
      patientIdentity_on_patient: {
        organisationId: $organisationId
        emailHash: $emailHash
        dob: $dob
      }
    })
  }
`;

const MARK_REVIEW_REQUESTED_GQL = `
  mutation MarkSubmissionReviewRequested($id: UUID!, $note: String) {
    updated: eligibilitySubmission_updateMany(
      where: {
        id: { eq: $id }
        outcomeStatus: { eq: DECLINED }
      }
      data: {
        reviewRequestedAt_expr: "request.time"
        reviewRequestedNote: $note
        updatedAt_expr: "request.time"
      }
    ) @check(expr: "this == 1", message: "INTAKE_STATE_CONFLICT") @redact
  }
`;

const LIST_DECLINED_SUBMISSIONS_GQL = `
  query ListDeclinedSubmissions($limit: Int!) {
    eligibilitySubmissions(
      where: { outcomeStatus: { eq: DECLINED } }
      limit: $limit
    ) {
      id
      submittedAt
      sourceType
      firstName
      surname
      dob
      email
      mobile
      postcode
      assignedOrganisationId
      declineRule
      declinedAt
      reviewRequestedAt
      reviewRequestedNote
    }
  }
`;

const LIST_RETENTION_CANDIDATES_GQL = `
  query ListRetentionCandidates($limit: Int!) {
    eligibilitySubmissions(
      where: { outcomeStatus: { ne: OPEN } }
      limit: $limit
    ) {
      id
      outcomeStatus
      completedAt
      updatedAt
      minimalRecordSince
    }
  }
`;

/**
 * Strips a closed application back to the minimal record Privacy 6 allows to survive:
 * name, the decision date and the outcome. Contact details, health answers and free
 * text are overwritten rather than left for the later delete, because the three-month
 * promise is about the data, not about the row.
 */
const REDUCE_TO_MINIMAL_RECORD_GQL = `
  mutation ReduceSubmissionToMinimalRecord($id: UUID!) {
    updated: eligibilitySubmission_updateMany(
      where: { id: { eq: $id }, minimalRecordSince: { isNull: true } }
      data: {
        mobile: ""
        email: ""
        postcode: ""
        heardAbout: null
        conditionCodes: null
        primaryConditionCode: null
        privateAllocationNote: null
        privateOnboardingNote: null
        reviewRequestedNote: null
        submissionIpHash: null
        minimalRecordSince_expr: "request.time"
        updatedAt_expr: "request.time"
      }
    ) @check(expr: "this == 1", message: "RETENTION_STATE_CONFLICT") @redact
  }
`;

const DELETE_SUBMISSION_GQL = `
  mutation DeleteEligibilitySubmission($id: UUID!) @transaction {
    eligibilityCondition_deleteMany(where: { submissionId: { eq: $id } })
    eligibilitySubmission_delete(key: { id: $id })
  }
`;

const UPSERT_PATIENT_CONDITION_GQL = `
  mutation UpsertPatientCondition(
    $patientId: UUID!
    $conditionCode: String!
    $primary: Boolean!
  ) {
    patientCondition_upsert(data: {
      patientId: $patientId
      conditionCode: $conditionCode
      primary: $primary
    })
  }
`;

const DECLINE_SUBMISSION_GQL = `
  mutation DeclineSubmission(
    $id: UUID!
    $expectedAssignmentVersion: Int!
    $newAssignmentVersion: Int!
    $onboardingNote: String
    $reason: DeclineReason!
  ) @transaction {
    updated: eligibilitySubmission_updateMany(
      where: {
        id: { eq: $id }
        assignmentVersion: { eq: $expectedAssignmentVersion }
        pharmacyAccessStatus: { eq: WITHHELD }
        outcomeStatus: { eq: OPEN }
      }
      data: {
        pharmacyAccessStatus: REVOKED
        onboardingDecision: DECLINED
        outcomeStatus: DECLINED
        assignmentVersion: $newAssignmentVersion
        privateOnboardingNote: $onboardingNote
        declineReason: $reason
        declinedAt_expr: "request.time"
        completedAt_expr: "request.time"
        updatedAt_expr: "request.time"
      }
    ) @check(expr: "this == 1", message: "INTAKE_STATE_CONFLICT") @redact
  }
`;

/**
 * A withdrawal is the patient's decision, not ours, so it leaves onboardingDecision
 * PENDING: nothing was decided on the merits. completedAt still moves, because
 * retention counts three months from the decision *or* the withdrawal alike.
 */
const WITHDRAW_SUBMISSION_GQL = `
  mutation WithdrawSubmission(
    $id: UUID!
    $expectedAssignmentVersion: Int!
    $newAssignmentVersion: Int!
    $onboardingNote: String
  ) @transaction {
    updated: eligibilitySubmission_updateMany(
      where: {
        id: { eq: $id }
        assignmentVersion: { eq: $expectedAssignmentVersion }
        outcomeStatus: { eq: OPEN }
      }
      data: {
        pharmacyAccessStatus: REVOKED
        outcomeStatus: WITHDRAWN
        assignmentVersion: $newAssignmentVersion
        privateOnboardingNote: $onboardingNote
        completedAt_expr: "request.time"
        updatedAt_expr: "request.time"
      }
    ) @check(expr: "this == 1", message: "INTAKE_STATE_CONFLICT") @redact
  }
`;

function rethrowMutationError(error: unknown): never {
  if (error instanceof Error && error.message.includes('INTAKE_STATE_CONFLICT')) {
    throw new HttpError(409, 'This intake changed or is no longer pending. Refresh before continuing.', 'VERSION_CONFLICT');
  }
  if (error instanceof Error && /unique constraint|duplicate key/i.test(error.message)) {
    throw new HttpError(409, 'A patient record already exists for this referral or identity.', 'PATIENT_ALREADY_EXISTS');
  }
  throw error;
}

export class SqlIntakeRepository implements IntakeRepositoryPort {
  async findSubmissionById(id: string): Promise<any | null> {
    const result = await dataConnect.executeGraphql<{ eligibilitySubmission: any | null }, any>(
      GET_SUBMISSION_BY_ID_GQL,
      { variables: { id: asUuid(id) } }
    );
    return result.data.eligibilitySubmission ?? null;
  }

  async listTenantPendingEnquiries(organisationId: string, limit = 200): Promise<TenantPendingEnquiryRecord[]> {
    const result = await dataConnect.executeGraphql<{
      eligibilitySubmissions: TenantPendingEnquiryRecord[];
    }, any>(
      LIST_TENANT_PENDING_ENQUIRIES_GQL,
      { variables: { organisationId: asUuid(organisationId), limit } }
    );
    return (result.data.eligibilitySubmissions ?? [])
      .sort((left, right) => right.submittedAt.localeCompare(left.submittedAt));
  }

  async markReviewRequested(id: string, note?: string | null): Promise<void> {
    await dataConnect.executeGraphql(
      MARK_REVIEW_REQUESTED_GQL,
      { variables: { id: asUuid(id), note: note ?? null } },
    );
  }

  async listDeclinedSubmissions(limit = 200): Promise<DeclinedSubmissionRecord[]> {
    const result = await dataConnect.executeGraphql<{
      eligibilitySubmissions: DeclinedSubmissionRecord[];
    }, any>(LIST_DECLINED_SUBMISSIONS_GQL, { variables: { limit } });
    return (result.data.eligibilitySubmissions ?? [])
      // Review requests first, then newest: a waiting patient outranks a closed decline.
      .sort((left, right) => {
        if (Boolean(left.reviewRequestedAt) !== Boolean(right.reviewRequestedAt)) {
          return left.reviewRequestedAt ? -1 : 1;
        }
        return right.submittedAt.localeCompare(left.submittedAt);
      });
  }

  async listRetentionCandidates(limit = 500): Promise<RetentionCandidateRecord[]> {
    const result = await dataConnect.executeGraphql<{
      eligibilitySubmissions: RetentionCandidateRecord[];
    }, any>(LIST_RETENTION_CANDIDATES_GQL, { variables: { limit } });
    return result.data.eligibilitySubmissions ?? [];
  }

  async reduceToMinimalRecord(id: string): Promise<void> {
    await dataConnect.executeGraphql(REDUCE_TO_MINIMAL_RECORD_GQL, { variables: { id: asUuid(id) } });
  }

  async deleteSubmission(id: string): Promise<void> {
    await dataConnect.executeGraphql(DELETE_SUBMISSION_GQL, { variables: { id: asUuid(id) } });
  }

  async listPlatformSubmissions(limit = 500): Promise<PlatformSubmissionRecord[]> {
    const result = await dataConnect.executeGraphql<{
      eligibilitySubmissions: PlatformSubmissionRecord[];
    }, any>(LIST_PLATFORM_SUBMISSIONS_GQL, { variables: { limit } });
    return result.data.eligibilitySubmissions ?? [];
  }

  async listSubmissionConditions(submissionId: string): Promise<SubmissionConditionRecord[]> {
    const submission = await this.findSubmissionById(submissionId) as PlatformSubmissionRecord | null;
    const fromForm = formConditionRecords({
      conditionCodes: submission?.conditionCodes,
      primaryConditionCode: submission?.primaryConditionCode,
    });
    if (fromForm.length) return fromForm;

    const result = await dataConnect.executeGraphql<{
      eligibilityConditions: SubmissionConditionRecord[];
    }, any>(LIST_SUBMISSION_CONDITIONS_GQL, { variables: { submissionId: asUuid(submissionId) } });
    return formConditionRecords({ conditions: result.data.eligibilityConditions ?? [] });
  }

  async createSubmission(input: CreateSubmissionInput): Promise<{ id?: string }> {
    const result = await dataConnect.executeGraphql<{ eligibilitySubmission_insert: { id: string } }, any>(
      CREATE_SUBMISSION_GQL,
      {
        variables: {
          sourceOrganisationId: input.sourceOrganisationId ?? null,
          assignedOrganisationId: input.assignedOrganisationId ?? null,
          sourceType: input.sourceType,
          firstName: input.firstName,
          surname: input.surname,
          dob: input.dob,
          mobile: input.mobile,
          email: input.email,
          emailHash: input.emailHash,
          postcode: input.postcode,
          triedTwoTreatments: input.triedTwoTreatments,
          psychiatricExclusion: input.psychiatricExclusion,
          heardAbout: input.heardAbout ?? null,
          conditionCodes: input.conditionCodes,
          primaryConditionCode: input.primaryConditionCode,
          idempotencyKeyHash: input.idempotencyKeyHash,
          assignmentStatus: input.assignmentStatus,
          pharmacyAccessStatus: input.pharmacyAccessStatus,
          consentVersion: input.consentVersion,
          referralConsent: input.referralConsent,
          dataSharingConsent: input.dataSharingConsent,
          marketingConsent: input.marketingConsent,
          privacyNoticeVersion: input.privacyNoticeVersion,
          termsVersion: input.termsVersion ?? null,
          referralConsentVersion: input.referralConsentVersion ?? null,
          dataSharingConsentVersion: input.dataSharingConsentVersion ?? null,
          marketingConsentVersion: input.marketingConsentVersion ?? null,
          submissionIpHash: input.submissionIpHash ?? null,
          outcomeStatus: input.outcomeStatus ?? 'OPEN',
          declineRule: input.declineRule ?? null,
          declinedAt: input.declinedAt ?? null,
        },
      }
    );
    return { id: result.data.eligibilitySubmission_insert?.id };
  }

  async findSubmissionByIdempotencyHash(idempotencyKeyHash: string): Promise<IdempotentSubmissionRecord | null> {
    const result = await dataConnect.executeGraphql<{
      eligibilitySubmissions: IdempotentSubmissionRecord[];
    }, any>(GET_SUBMISSION_BY_IDEMPOTENCY_HASH_GQL, {
      variables: { idempotencyKeyHash },
    });
    return result.data.eligibilitySubmissions?.[0] ?? null;
  }

  async saveSubmissionConditions(submissionId: string, conditionCodes: string[], primaryConditionCode: string): Promise<void> {
    await dataConnect.executeGraphql(UPDATE_SUBMISSION_CONDITIONS_GQL, {
      variables: { id: asUuid(submissionId), conditionCodes, primaryConditionCode },
    });
    const records = formConditionRecords({ conditionCodes, primaryConditionCode });
    await Promise.all(records.map(async (condition) => {
      try {
        await dataConnect.executeGraphql(UPSERT_SUBMISSION_CONDITION_GQL, {
          variables: {
            submissionId: asUuid(submissionId),
            conditionCode: condition.conditionCode,
            primary: condition.primary,
          },
        });
      } catch (error) {
        console.warn('[Eligibility] Catalogue condition link skipped:', {
          submissionId,
          conditionCode: condition.conditionCode,
          error,
        });
      }
    }));
  }

  async reassignPendingSubmission(input: ReassignSubmissionInput): Promise<void> {
    try {
      const current = await this.findSubmissionById(input.id) as PlatformSubmissionRecord | null;
      await dataConnect.executeGraphql<any, any>(REASSIGN_SUBMISSION_GQL, {
        variables: {
          id: asUuid(input.id),
          newOrganisationId: asUuid(input.newOrganisationId),
          expectedAssignmentVersion: input.expectedAssignmentVersion,
          newAssignmentVersion: input.newAssignmentVersion,
          actorUid: input.actorUid,
          reasonCode: input.reasonCode,
          note: input.note,
          previousOrganisationId: current?.assignedOrganisationId ? asUuid(current.assignedOrganisationId) : null,
          notePresent: Boolean(input.note),
          patientAgreementChannel: input.patientAgreementChannel,
        },
      });
    } catch (error) {
      rethrowMutationError(error);
    }
  }

  async updateSubmissionFollowUp(input: UpdateSubmissionFollowUpInput): Promise<void> {
    try {
      await dataConnect.executeGraphql<any, any>(UPDATE_SUBMISSION_FOLLOW_UP_GQL, {
        variables: { ...input, id: asUuid(input.id) },
      });
    } catch (error) {
      rethrowMutationError(error);
    }
  }

  async activateSubmission(input: ActivateSubmissionInput): Promise<void> {
    try {
      await dataConnect.executeGraphql<any, any>(ACTIVATE_SUBMISSION_GQL, {
        variables: {
          ...input,
          id: asUuid(input.id),
          patientId: asUuid(input.patientId),
          organisationId: asUuid(input.organisationId),
        },
      });
    } catch (error) {
      rethrowMutationError(error);
    }
  }

  async copySubmissionConditionsToPatient(patientId: string, submissionId: string): Promise<void> {
    const conditions = await this.listSubmissionConditions(submissionId);
    // The application's answers remain the authoritative copy; a catalogue link
    // that cannot be written must not fail a referral the transaction has already
    // committed, so it is logged and skipped exactly as it is at submission time.
    await Promise.all(conditions.map(async condition => {
      try {
        await dataConnect.executeGraphql(UPSERT_PATIENT_CONDITION_GQL, {
          variables: {
            patientId: asUuid(patientId),
            conditionCode: condition.conditionCode,
            primary: condition.primary,
          },
        });
      } catch (error) {
        console.warn('[Eligibility] Patient condition link skipped:', { patientId, submissionId, conditionCode: condition.conditionCode, error });
      }
    }));
  }

  /**
   * Replace a submission's conditions with exactly this set.
   *
   * `saveSubmissionConditions` only ever adds, because intake only ever adds.
   * A staff edit can remove one, so the join rows for dropped codes are deleted
   * here. The authoritative write is the single `conditionCodes` update inside
   * `saveSubmissionConditions` — every read path prefers that array over the
   * join rows — so if a delete below fails the record already reads correctly
   * and only a shadowed row is left behind.
   */
  async rewriteSubmissionConditions(submissionId: string, records: FormConditionRecord[]): Promise<void> {
    const existing = await this.listSubmissionConditions(submissionId);
    const keep = new Set(records.map(record => record.conditionCode));
    const primary = records.find(record => record.primary)?.conditionCode ?? records[0]?.conditionCode;
    if (!primary) throw new Error('A submission condition rewrite needs at least one condition.');

    await this.saveSubmissionConditions(submissionId, records.map(record => record.conditionCode), primary);

    for (const condition of existing) {
      if (keep.has(condition.conditionCode)) continue;
      try {
        await dataConnect.executeGraphql(DELETE_SUBMISSION_CONDITION_GQL, {
          variables: { submissionId: asUuid(submissionId), conditionCode: condition.conditionCode },
        });
      } catch (error) {
        console.warn('[Eligibility] Stale submission condition link not removed:', {
          submissionId,
          conditionCode: condition.conditionCode,
          error,
        });
      }
    }
  }

  /**
   * Replace a patient's condition rows with exactly this set. These rows are
   * what the record falls back to for a patient with no source submission, so
   * for those patients this write is the authoritative one.
   */
  async rewritePatientConditions(patientId: string, existing: FormConditionRecord[], records: FormConditionRecord[]): Promise<void> {
    for (const condition of records) {
      await dataConnect.executeGraphql(UPSERT_PATIENT_CONDITION_GQL, {
        variables: {
          patientId: asUuid(patientId),
          conditionCode: condition.conditionCode,
          primary: condition.primary,
        },
      });
    }
    const keep = new Set(records.map(record => record.conditionCode));
    for (const condition of existing) {
      if (keep.has(condition.conditionCode)) continue;
      await dataConnect.executeGraphql(DELETE_PATIENT_CONDITION_GQL, {
        variables: { patientId: asUuid(patientId), conditionCode: condition.conditionCode },
      });
    }
  }

  async declineSubmission(input: DeclineSubmissionInput): Promise<void> {
    try {
      await dataConnect.executeGraphql<any, any>(DECLINE_SUBMISSION_GQL, {
        variables: { ...input, id: asUuid(input.id) },
      });
    } catch (error) {
      rethrowMutationError(error);
    }
  }

  async withdrawSubmission(input: WithdrawSubmissionInput): Promise<void> {
    try {
      await dataConnect.executeGraphql<any, any>(WITHDRAW_SUBMISSION_GQL, {
        variables: { ...input, id: asUuid(input.id) },
      });
    } catch (error) {
      rethrowMutationError(error);
    }
  }
}
