import type { PharmsmartTermsRequest, PharmsmartWelcome } from './types';

/**
 * The sign-up runs Curaleaf form, then Partner Terms, then Worldpay (which can be
 * skipped). Each step opens the next; Worldpay stays shut until both before it are done.
 */
export type OnboardingSetupState = {
  /** The request the Curaleaf form created, once it has been sent. */
  termsRequest: PharmsmartTermsRequest | null;
  termsAccepted: boolean;
  worldpay: 'locked' | 'open' | 'sent' | 'skipped';
};

/** Where a visit starts: a pharmacy that left before the Terms comes back to them. */
export function initialSetupState(welcome: Pick<PharmsmartWelcome, 'onboardingRequest' | 'termsRequest'>): OnboardingSetupState {
  if (welcome.onboardingRequest === 'terms_outstanding' && welcome.termsRequest) {
    return { termsRequest: welcome.termsRequest, termsAccepted: false, worldpay: 'locked' };
  }
  return { termsRequest: null, termsAccepted: false, worldpay: 'locked' };
}

export function afterCuraleafSent(state: OnboardingSetupState, request: PharmsmartTermsRequest): OnboardingSetupState {
  return { ...state, termsRequest: request };
}

export function afterTermsAccepted(state: OnboardingSetupState): OnboardingSetupState {
  return { ...state, termsAccepted: true, worldpay: state.worldpay === 'locked' ? 'open' : state.worldpay };
}

export function worldpayUnlocked(state: OnboardingSetupState) {
  return Boolean(state.termsRequest) && state.termsAccepted;
}

/** Done once the Terms are in and Worldpay is either sent or skipped. */
export function setupFinished(state: OnboardingSetupState) {
  return worldpayUnlocked(state) && (state.worldpay === 'sent' || state.worldpay === 'skipped');
}

/** The welcome states that replace the forms with a message. `terms_outstanding` resumes the forms instead. */
export function requestStateView(state: PharmsmartWelcome['onboardingRequest']): 'pending' | 'on_hold' | null {
  return state === 'pending' || state === 'on_hold' ? state : null;
}
