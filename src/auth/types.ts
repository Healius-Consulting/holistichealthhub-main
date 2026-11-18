export type StaffRole = 'hhh_admin' | 'pharmacy_staff';

export interface AuthenticatedStaff {
  uid: string;
  email: string;
  name: string;
  role: StaffRole;
  organisationId?: string;
  emailVerified: boolean;
  mfaEnrolled: boolean;
  surface?: 'pharmacy' | 'admin';
  idleExpiresAt?: string;
  absoluteExpiresAt?: string;
}

export type AuthPhase =
  | 'loading'
  | 'unconfigured'
  | 'anonymous'
  | 'email-unverified'
  | 'mfa-challenge'
  | 'mfa-enrollment'
  | 'authenticated'
  | 'error';

export interface PharmsmartSetup {
  ticket: string;
  missing: Array<'email' | 'name'>;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
}

/** Curaleaf account form values PharmSmart sent. A missing key is left for the pharmacy to type. */
export type PharmsmartPrefill = Partial<Record<
  | 'pharmacyName'
  | 'registeredCompanyName'
  | 'deliveryAddress'
  | 'invoiceAddress'
  | 'pharmacyPhone'
  | 'pharmacyEmail'
  | 'accountsEmail'
  | 'accountsPhone'
  | 'faxNumber'
  | 'wdaNumber'
  | 'licenceDetails'
  | 'superintendentFirstName'
  | 'superintendentLastName'
  | 'superintendentEmail'
  | 'superintendentPhone'
  | 'managerFirstName'
  | 'managerLastName'
  | 'managerEmail'
  | 'managerPhone',
  string
>>;

export interface PharmsmartWelcome {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  gphcNumber?: string | null;
  pharmsmartPharmacyId?: string | null;
  prefill?: PharmsmartPrefill;
}

export interface AuthState {
  phase: AuthPhase;
  staff: AuthenticatedStaff | null;
  error: string | null;
  notice: string | null;
  sessionWarning?: boolean;
  pharmsmartSetup?: PharmsmartSetup | null;
  pharmsmartWelcome?: PharmsmartWelcome | null;
}
