import type { Prescription } from '../../context/AppContext';
import type { ComputeWizardProgressInput, RxSubStep, WizardProgress, WizardStep } from './types';

export function isRouteChosen(rx: Prescription | null, routeExplicitlyChosen: boolean) {
  if (!rx) return false;
  if (routeExplicitlyChosen) return true;
  return Boolean(rx.clinicScanId || rx.copyFileName || rx.serialNumber?.trim());
}

export function prescriptionUploaded(rx: Prescription | null) {
  return Boolean(rx && (rx.copyFileName || rx.clinicScanId));
}

export function deriveRxSubStep(rx: Prescription | null, routeChosen: boolean): RxSubStep {
  if (!routeChosen) return 'route';
  if (!prescriptionUploaded(rx)) return 'upload';
  return 'details';
}

export function computeWizardProgress(input: ComputeWizardProgressInput): WizardProgress {
  const {
    patientReady,
    prescriptionReady,
    readyForProducts,
    draftBasketCount,
    readyForPayment,
    selectedRx,
    routeExplicitlyChosen,
    isReplacement,
  } = input;

  const routeChosen = isRouteChosen(selectedRx, routeExplicitlyChosen);
  const rxSubStep = deriveRxSubStep(selectedRx, routeChosen);
  const medicinesComplete = draftBasketCount >= 1 && readyForProducts;

  const steps: WizardProgress['steps'] = {
    1: { complete: patientReady },
    2: {
      complete: prescriptionReady,
      blockedReason: !patientReady ? 'Link a patient first' : undefined,
    },
    3: {
      complete: medicinesComplete,
      blockedReason: !prescriptionReady ? 'Authenticate prescription first' : undefined,
    },
    4: {
      complete: readyForPayment,
      blockedReason: !prescriptionReady
        ? 'Prescription incomplete'
        : draftBasketCount < 1
          ? 'Add medicines first'
          : undefined,
    },
  };

  let furthestUnlocked: WizardStep = 1;
  if (patientReady) furthestUnlocked = 2;
  if (prescriptionReady) furthestUnlocked = 3;
  if (prescriptionReady && draftBasketCount >= 1) furthestUnlocked = 4;

  let suggestedFocus = furthestUnlocked;
  if (isReplacement && patientReady && !prescriptionReady) {
    suggestedFocus = 2;
  } else if (patientReady && !prescriptionReady) {
    suggestedFocus = 2;
  } else if (prescriptionReady && draftBasketCount < 1) {
    suggestedFocus = 3;
  } else if (readyForPayment) {
    suggestedFocus = 4;
  }

  return {
    furthestUnlocked,
    suggestedFocus,
    rxSubStep,
    steps,
    basketUnlocked: prescriptionReady && draftBasketCount > 0,
    basketIsProvisional: isReplacement && draftBasketCount > 0 && !prescriptionReady,
    isReplacement,
    patientLocked: isReplacement,
    routeChosen,
  };
}

export function wizardStageTitle(input: {
  focusedStep: WizardStep;
  rxSubStep: RxSubStep;
  entryMode?: 'clinic' | 'manual';
  paidRedo: boolean;
}): string {
  const { focusedStep, rxSubStep, entryMode, paidRedo } = input;
  if (focusedStep === 1) return 'Link an approved patient';
  if (focusedStep === 2) {
    if (rxSubStep === 'route') return 'Scan the Curaleaf QR or enter it manually';
    if (rxSubStep === 'upload') return 'Upload the prescription';
    return entryMode === 'manual' ? 'Enter the signed prescription' : 'Confirm the Curaleaf scan';
  }
  if (focusedStep === 3) {
    return entryMode === 'manual' ? 'Select the prescribed medicines' : 'Review the Curaleaf pack match';
  }
  return paidRedo ? 'Review and carry over payment' : 'Review and request payment';
}

export function wizardNextHint(input: {
  progress: WizardProgress;
  patientLinked: boolean;
  patientEligible: boolean;
  entryMode?: 'clinic' | 'manual';
  readyForProducts: boolean;
  draftBasketCount: number;
}): string {
  const { progress, patientLinked, patientEligible, entryMode, readyForProducts, draftBasketCount } = input;
  if (!progress.steps[1].complete) {
    if (patientLinked && !patientEligible) return 'This patient cannot start an order until they are approved.';
    return 'Link an approved patient to continue.';
  }
  if (!progress.routeChosen) return 'Choose Scan Curaleaf QR or Enter details manually.';
  if (progress.rxSubStep === 'upload') {
    return 'Upload the prescription copy to continue.';
  }
  if (progress.rxSubStep === 'details' && !readyForProducts) {
    return entryMode === 'manual'
      ? 'Enter the signed prescription details to review medicines.'
      : 'Wait until Curaleaf verifies the barcode, or try the scan again.';
  }
  if (draftBasketCount === 0 && progress.steps[2].complete) return 'Add a prescribed medicine to review payment.';
  return '';
}
