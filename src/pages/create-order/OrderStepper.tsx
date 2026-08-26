import { CheckCircle } from 'lucide-react';
import type { WizardProgress, WizardStep } from './types';
import { WIZARD_STEP_LABELS, WIZARD_STEP_SHORT_LABELS } from './types';

type OrderStepperProps = {
  progress: WizardProgress;
  focusedStep: WizardStep;
  onStepClick: (step: WizardStep) => void;
};

const STEPS: WizardStep[] = [1, 2, 3, 4];

export default function OrderStepper({ progress, focusedStep, onStepClick }: OrderStepperProps) {
  return (
    <nav className="rx-order-stepper" aria-label="Create order progress">
      <ol className="rx-order-stepper__list">
        {STEPS.map((step, index) => {
          const complete = progress.steps[step].complete;
          const current = focusedStep === step;
          const unlocked = step <= progress.furthestUnlocked;
          const label = WIZARD_STEP_LABELS[step];
          const shortLabel = WIZARD_STEP_SHORT_LABELS[step];
          return (
            <li
              key={step}
              className={`rx-order-stepper__item${complete ? ' is-complete' : ''}${current ? ' is-current' : ''}${!unlocked ? ' is-locked' : ''}`}
            >
              {index > 0 ? <span className="rx-order-stepper__sep" aria-hidden="true">›</span> : null}
              <button
                type="button"
                className="rx-order-stepper__button"
                aria-current={current ? 'step' : undefined}
                aria-disabled={!unlocked && !complete}
                disabled={!unlocked && !complete}
                onClick={() => onStepClick(step)}
              >
                <span className="rx-order-stepper__number">
                  {complete ? <CheckCircle size={14} aria-hidden="true" /> : step}
                </span>
                <span className="rx-order-stepper__label">{label}</span>
                <span className="rx-order-stepper__label rx-order-stepper__label--short">{shortLabel}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
