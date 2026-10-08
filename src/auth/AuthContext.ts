import { createContext } from 'react';
import type { AuthState } from './types';

export interface TotpEnrollmentDetails {
  secretKey: string;
  qrCodeUrl: string;
}

export interface AuthContextValue {
  state: AuthState;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithPharmsmart: (token: string) => Promise<void>;
  completePharmsmartSetup: (input: { email?: string; firstName?: string; lastName?: string }) => Promise<void>;
  clearPharmsmartSetup: () => void;
  signOutStaff: (reason?: string) => Promise<void>;
  sendPasswordReset: (email: string) => Promise<void>;
  resendVerification: () => Promise<void>;
  refreshVerification: () => Promise<void>;
  beginTotpEnrollment: () => Promise<TotpEnrollmentDetails>;
  completeTotpEnrollment: (code: string) => Promise<void>;
  completeMfaChallenge: (code: string) => Promise<void>;
  continueSession: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
