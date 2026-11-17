import { dataConnect } from '../../bootstrap/firebase.js';
import { asUuid } from '../../domain/common/uuid.js';
import { formConditionRecords, primaryConditionCode } from '../../domain/eligibility/form-conditions.js';
import type { PatientRecord, PatientRepositoryPort } from '../ports/patient.port.js';

const PATIENT_FIELDS = `
  id
  organisationId
  sourceSubmissionId
  firstName
  surname
  dob
  email
  mobile
  address
  postcode
  status
  activatedAt
  statusChangedAt
  version
  createdAt
  updatedAt
  patientConditions_on_patient {
    conditionCode
    primary
  }
  sourceSubmission {
    sourceType
    triedTwoTreatments
    psychiatricExclusion
    heardAbout
    marketingConsent
    existingClinicAccount
    conditionCodes
    primaryConditionCode
    eligibilityConditions_on_submission {
      conditionCode
      primary
    }
  }
`;

const LIST_TENANT_PATIENTS_GQL = `
  query ListTenantPatients($organisationId: UUID!, $limit: Int!) {
    patients(
      where: {
        organisationId: { eq: $organisationId }
        archivedAt: { isNull: true }
      }
      orderBy: { createdAt: DESC }
      limit: $limit
    ) {
      ${PATIENT_FIELDS}
    }
  }
`;

const LIST_PLATFORM_PATIENTS_GQL = `
  query ListPlatformPatients($limit: Int!) {
    patients(
      where: { archivedAt: { isNull: true } }
      orderBy: { createdAt: DESC }
      limit: $limit
    ) {
      ${PATIENT_FIELDS}
    }
  }
`;

const LIST_ACTIVE_PATIENTS_GQL = `
  query ListActivePatients($limit: Int!) {
    patients(
      where: {
        status: { eq: ACTIVE }
        archivedAt: { isNull: true }
      }
      orderBy: { createdAt: DESC }
      limit: $limit
    ) {
      ${PATIENT_FIELDS}
    }
  }
`;

type RawPatient = Omit<PatientRecord, 'conditions' | 'sourceSubmission'> & {
  patientConditions_on_patient?: PatientRecord['conditions'];
  sourceSubmission?: PatientRecord['sourceSubmission'] & {
    eligibilityConditions_on_submission?: PatientRecord['conditions'];
  };
};

function mapPatient(raw: RawPatient): PatientRecord {
  const { patientConditions_on_patient, sourceSubmission, ...patient } = raw;
  const joined = sourceSubmission?.eligibilityConditions_on_submission;
  const fromForm = formConditionRecords({
    conditionCodes: sourceSubmission?.conditionCodes,
    primaryConditionCode: sourceSubmission?.primaryConditionCode,
    conditions: joined?.length ? joined : patientConditions_on_patient,
  });
  return {
    ...patient,
    conditions: fromForm.length ? fromForm : patientConditions_on_patient ?? [],
    sourceSubmission: sourceSubmission
      ? {
        sourceType: sourceSubmission.sourceType,
        triedTwoTreatments: sourceSubmission.triedTwoTreatments,
        psychiatricExclusion: sourceSubmission.psychiatricExclusion,
        heardAbout: sourceSubmission.heardAbout,
        marketingConsent: sourceSubmission.marketingConsent,
        existingClinicAccount: sourceSubmission.existingClinicAccount === true,
        conditionCodes: fromForm.map((record) => record.conditionCode),
        primaryConditionCode: primaryConditionCode(fromForm),
      }
      : null,
  };
}

const GET_TENANT_PATIENT_GQL = `
  query GetTenantPatient($organisationId: UUID!, $patientId: UUID!) {
    patients(
      where: {
        id: { eq: $patientId }
        organisationId: { eq: $organisationId }
        archivedAt: { isNull: true }
      }
      limit: 1
    ) {
      ${PATIENT_FIELDS}
    }
  }
`;

const UPDATE_PATIENT_STATUS_GQL = `
  mutation UpdatePatientStatus(
    $id: UUID!
    $status: PatientStatus!
    $activatedAt: Timestamp
    $statusChangedAt: Timestamp
  ) {
    patient_update(
      key: { id: $id }
      data: {
        status: $status
        activatedAt: $activatedAt
        statusChangedAt: $statusChangedAt
        updatedAt_expr: "request.time"
      }
    )
  }
`;

// The identity row (email hash + date of birth) is what stops one person being
// two patients at a pharmacy, so it moves with the details in one transaction.
const UPDATE_PATIENT_DETAILS_GQL = `
  mutation UpdatePatientDetails(
    $id: UUID!
    $organisationId: UUID!
    $expectedVersion: Int!
    $newVersion: Int!
    $firstName: String!
    $surname: String!
    $dob: Date!
    $email: String!
    $emailHash: String!
    $mobile: String!
    $postcode: String!
  ) @transaction {
    updated: patient_updateMany(
      where: {
        id: { eq: $id }
        organisationId: { eq: $organisationId }
        version: { eq: $expectedVersion }
        archivedAt: { isNull: true }
      }
      data: {
        firstName: $firstName
        surname: $surname
        dob: $dob
        email: $email
        mobile: $mobile
        postcode: $postcode
        version: $newVersion
        updatedAt_expr: "request.time"
      }
    ) @check(expr: "this == 1", message: "PATIENT_VERSION_CONFLICT")
    patientIdentity_updateMany(
      where: { patientId: { eq: $id } }
      data: { emailHash: $emailHash, dob: $dob }
    )
  }
`;

export class SqlPatientRepository implements PatientRepositoryPort {
  async listTenantPatients(organisationId: string, limit = 500): Promise<PatientRecord[]> {
    const result = await dataConnect.executeGraphql<{ patients: RawPatient[] }, any>(
      LIST_TENANT_PATIENTS_GQL,
      { variables: { organisationId: asUuid(organisationId), limit } },
    );
    return (result.data.patients ?? []).map(mapPatient);
  }

  async listPlatformPatients(limit = 20_001): Promise<PatientRecord[]> {
    const result = await dataConnect.executeGraphql<{ patients: RawPatient[] }, any>(
      LIST_PLATFORM_PATIENTS_GQL,
      { variables: { limit } },
    );
    return (result.data.patients ?? []).map(mapPatient);
  }

  async listActivePatients(limit = 2_000): Promise<PatientRecord[]> {
    const result = await dataConnect.executeGraphql<{ patients: RawPatient[] }, { limit: number }>(
      LIST_ACTIVE_PATIENTS_GQL,
      { variables: { limit } },
    );
    return (result.data.patients ?? []).map(mapPatient);
  }

  async findPatientById(organisationId: string, patientId: string): Promise<PatientRecord | null> {
    const result = await dataConnect.executeGraphql<{ patients: RawPatient[] }, any>(
      GET_TENANT_PATIENT_GQL,
      { variables: { organisationId: asUuid(organisationId), patientId: asUuid(patientId) } },
    );
    const raw = result.data.patients?.[0];
    return raw ? mapPatient(raw) : null;
  }

  async updatePatientStatus(data: {
    id: string;
    organisationId: string;
    status: PatientRecord['status'];
    activatedAt?: string | null;
    statusChangedAt?: string | null;
  }): Promise<void> {
    const existing = await this.findPatientById(data.organisationId, data.id);
    if (!existing) return;
    await dataConnect.executeGraphql(UPDATE_PATIENT_STATUS_GQL, {
      variables: {
        id: data.id,
        status: data.status,
        activatedAt: data.activatedAt ?? existing.activatedAt,
        statusChangedAt: data.statusChangedAt ?? new Date().toISOString(),
      },
    });
  }

  async updatePatientDetails(data: {
    id: string;
    organisationId: string;
    expectedVersion: number;
    firstName: string;
    surname: string;
    dob: string;
    email: string;
    emailHash: string;
    mobile: string;
    postcode: string;
  }): Promise<boolean> {
    try {
      await dataConnect.executeGraphql(UPDATE_PATIENT_DETAILS_GQL, {
        variables: {
          ...data,
          id: asUuid(data.id),
          organisationId: asUuid(data.organisationId),
          newVersion: data.expectedVersion + 1,
        },
      });
      return true;
    } catch (error) {
      if (error instanceof Error && error.message.includes('PATIENT_VERSION_CONFLICT')) return false;
      throw error;
    }
  }
}
