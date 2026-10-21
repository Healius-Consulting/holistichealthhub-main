export interface PatientConditionRecord {
  conditionCode: string;
  primary: boolean;
}

export interface PatientSourceSubmissionRecord {
  sourceType: 'GENERAL_HHH_WEBSITE' | 'PHARMACY_QR' | 'LEGACY_PHARMACY_QR';
  triedTwoTreatments: boolean;
  psychiatricExclusion: boolean;
  heardAbout: string | null;
  marketingConsent: boolean;
  /** Admin-only. Existing Curaleaf Clinic account: no £50 initial fee. */
  existingClinicAccount?: boolean;
  conditionCodes?: string[] | null;
  primaryConditionCode?: string | null;
}

export interface PatientRecord {
  id: string;
  organisationId: string;
  sourceSubmissionId: string | null;
  firstName: string;
  surname: string;
  dob: string;
  email: string;
  mobile: string;
  address: string | null;
  postcode: string;
  status: 'REFERRED' | 'ACTIVE' | 'INACTIVE';
  activatedAt: string | null;
  statusChangedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  conditions: PatientConditionRecord[];
  sourceSubmission: PatientSourceSubmissionRecord | null;
}

export interface PatientRepositoryPort {
  listTenantPatients(organisationId: string, limit?: number): Promise<PatientRecord[]>;
  listPlatformPatients(limit?: number): Promise<PatientRecord[]>;
  listActivePatients(limit?: number): Promise<PatientRecord[]>;
  findPatientById(organisationId: string, patientId: string): Promise<PatientRecord | null>;
  updatePatientStatus(data: {
    id: string;
    organisationId: string;
    status: PatientRecord['status'];
    activatedAt?: string | null;
    statusChangedAt?: string | null;
  }): Promise<void>;
}
