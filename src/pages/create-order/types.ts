import type { Prescription } from '../../context/AppContext';

export type WizardStep = 1 | 2 | 3 | 4;
export type RxSubStep = 'route' | 'upload' | 'details';

export type WizardStepState = {
  complete: boolean;
  blockedReason?: string;
};

export type WizardProgress = {
  furthestUnlocked: WizardStep;
  suggestedFocus: WizardStep;
  rxSubStep: RxSubStep;
  steps: Record<WizardStep, WizardStepState>;
  basketUnlocked: boolean;
  basketIsProvisional: boolean;
  isReplacement: boolean;
  patientLocked: boolean;
  routeChosen: boolean;
};

export type ComputeWizardProgressInput = {
  patientReady: boolean;
  prescriptionReady: boolean;
  readyForProducts: boolean;
  draftBasketCount: number;
  readyForPayment: boolean;
  selectedRx: Prescription | null;
  routeExplicitlyChosen: boolean;
  isReplacement: boolean;
};

export const WIZARD_STEP_LABELS: Record<WizardStep, string> = {
  1: 'Patient',
  2: 'Prescription',
  3: 'Medicines',
  4: 'Payment',
};

export const WIZARD_STEP_SHORT_LABELS: Record<WizardStep, string> = {
  1: 'Patient',
  2: 'Rx',
  3: 'Meds',
  4: 'Pay',
};
