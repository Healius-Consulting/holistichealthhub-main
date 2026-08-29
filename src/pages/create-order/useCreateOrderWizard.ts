import { useCallback, useEffect, useRef, useState } from 'react';
import { computeWizardProgress, isRouteChosen, prescriptionUploaded } from './computeWizardProgress';
import type { ComputeWizardProgressInput, WizardStep } from './types';

type UseCreateOrderWizardOptions = Omit<ComputeWizardProgressInput, 'routeExplicitlyChosen'> & {
  activeOrderId: number | null;
  selectedRxId: number | null;
  onPatientLinked?: () => void;
};

export function useCreateOrderWizard(options: UseCreateOrderWizardOptions) {
  const {
    activeOrderId,
    selectedRxId,
    onPatientLinked,
    ...progressInput
  } = options;

  const initialProgress = computeWizardProgress({ ...progressInput, routeExplicitlyChosen: false });
  const [focusedStep, setFocusedStep] = useState<WizardStep>(initialProgress.suggestedFocus);
  const [routeExplicitlyChosen, setRouteExplicitlyChosen] = useState(false);
  const [lockNotice, setLockNotice] = useState<string | null>(null);
  const stageHeadingRef = useRef<HTMLHeadingElement>(null);
  const skipFocusRef = useRef(true);
  const previousOrderId = useRef<number | null>(null);
  const previousPatientReady = useRef(progressInput.patientReady);

  const progressWithRoute = computeWizardProgress({
    ...progressInput,
    routeExplicitlyChosen,
  });

  const previousSelectedRxId = useRef<number | null>(null);

  useEffect(() => {
    if (activeOrderId === null) return;
    if (previousOrderId.current !== activeOrderId) {
      previousOrderId.current = activeOrderId;
      previousSelectedRxId.current = selectedRxId;
      const rx = progressInput.selectedRx;
      const routeWasChosen = isRouteChosen(rx, false);
      const next = computeWizardProgress({ ...progressInput, routeExplicitlyChosen: routeWasChosen });
      setRouteExplicitlyChosen(routeWasChosen);
      setFocusedStep(next.suggestedFocus);
      setLockNotice(null);
      skipFocusRef.current = true;
      previousPatientReady.current = progressInput.patientReady;
    }
  }, [activeOrderId, progressInput, selectedRxId]);

  useEffect(() => {
    if (activeOrderId === null) return;
    if (previousOrderId.current !== activeOrderId) return;
    if (previousSelectedRxId.current === selectedRxId) return;
    previousSelectedRxId.current = selectedRxId;
    const routeWasChosen = isRouteChosen(progressInput.selectedRx, false);
    setRouteExplicitlyChosen(routeWasChosen);
    setLockNotice(null);
    skipFocusRef.current = true;
    const next = computeWizardProgress({ ...progressInput, routeExplicitlyChosen: routeWasChosen });
    setFocusedStep(current => (current > next.furthestUnlocked ? next.furthestUnlocked : current));
  }, [activeOrderId, progressInput, selectedRxId]);

  useEffect(() => {
    if (progressInput.patientReady && !previousPatientReady.current) {
      skipFocusRef.current = true;
      setFocusedStep(current => (current === 1 ? 2 : current));
      setLockNotice(null);
      onPatientLinked?.();
    }
    previousPatientReady.current = progressInput.patientReady;
  }, [onPatientLinked, progressInput.patientReady]);

  useEffect(() => {
    if (skipFocusRef.current) {
      skipFocusRef.current = false;
      return;
    }
    stageHeadingRef.current?.focus();
  }, [focusedStep, progressWithRoute.rxSubStep]);

  const goToStep = useCallback((step: WizardStep) => {
    if (step > progressWithRoute.furthestUnlocked) {
      const blocked = progressWithRoute.steps[step]?.blockedReason;
      setLockNotice(blocked ?? 'Complete the earlier steps first.');
      return;
    }
    setLockNotice(null);
    skipFocusRef.current = false;
    setFocusedStep(step);
  }, [progressWithRoute]);

  const commitRouteChoice = useCallback(() => {
    setRouteExplicitlyChosen(true);
    setLockNotice(null);
  }, []);

  return {
    progress: progressWithRoute,
    focusedStep,
    setFocusedStep,
    goToStep,
    routeExplicitlyChosen,
    commitRouteChoice,
    lockNotice,
    setLockNotice,
    stageHeadingRef,
    markSkipFocus: () => { skipFocusRef.current = true; },
    prescriptionUploaded: prescriptionUploaded(progressInput.selectedRx),
  };
}
