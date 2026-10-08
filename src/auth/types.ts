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

export interface AuthState {
  phase: AuthPhase;
  staff: AuthenticatedStaff | null;
  error: string | null;
  notice: string | null;
  sessionWarning?: boolean;
  pharmsmartSetup?: PharmsmartSetup | null;
}
