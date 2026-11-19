import type { PharmsmartTermsRequest, PharmsmartWelcome } from './types';

/**
 * The sign-up runs Curaleaf form, then Partner Terms (only while HHH has them switched
 * on), then Worldpay (which can be skipped). Each step opens the next; Worldpay stays
 * shut until the steps before it are done.
 */
export type OnboardingSetupState = {
  /** The request the Curaleaf form created, once it has been sent. */
  termsRequest: PharmsmartTermsRequest | null;
  termsAccepted: boolean;
  /** Whether the Partner Terms step is part of sign-up (HHH switched them on). */
  termsRequired: boolean;
  worldpay: 'locked' | 'open' | 'sent' | 'skipped';
};

/** Where a visit starts: a pharmacy that left before the Terms comes back to them. */
export function initialSetupState(welcome: Pick<PharmsmartWelcome, 'onboardingRequest' | 'termsRequest' | 'termsRequired'>): OnboardingSetupState {
  const termsRequired = Boolean(welcome.termsRequired);
  if (welcome.onboardingRequest === 'terms_outstanding' && welcome.termsRequest) {
    return { termsRequest: welcome.termsRequest, termsAccepted: false, termsRequired: true, worldpay: 'locked' };
  }
  return { termsRequest: null, termsAccepted: false, termsRequired, worldpay: 'locked' };
}

/** The Curaleaf form went in. Without a Terms step it has already gone to Curaleaf, and Worldpay opens. */
export function afterCuraleafSent(state: OnboardingSetupState, request: PharmsmartTermsRequest): OnboardingSetupState {
  return { ...state, termsRequest: request, worldpay: !state.termsRequired && state.worldpay === 'locked' ? 'open' : state.worldpay };
}

export function afterTermsAccepted(state: OnboardingSetupState): OnboardingSetupState {
  return { ...state, termsAccepted: true, worldpay: state.worldpay === 'locked' ? 'open' : state.worldpay };
}

export function worldpayUnlocked(state: OnboardingSetupState) {
  return Boolean(state.termsRequest) && (state.termsAccepted || !state.termsRequired);
}

/** Done once the Curaleaf form (and the Terms, when asked for) are in and Worldpay is either sent or skipped. */
export function setupFinished(state: OnboardingSetupState) {
  return worldpayUnlocked(state) && (state.worldpay === 'sent' || state.worldpay === 'skipped');
}

/** The welcome states that replace the forms with a message. `terms_outstanding` resumes the forms instead. */
export function requestStateView(state: PharmsmartWelcome['onboardingRequest']): 'pending' | 'on_hold' | null {
  return state === 'pending' || state === 'on_hold' ? state : null;
}
