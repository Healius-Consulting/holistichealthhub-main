import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useApp, type Screen } from '../context/AppContext';
import { useModalFocus } from '../accessibility/useModalFocus';
import { isLocalPortalPreview } from '../dev/localPortalPreview';
import { WORKSPACE_TOUR_STEPS } from '../training/workspaceTour';
import { persistWorkspaceTourCompleted } from '../training/workspaceTourPersist';
import {
  markWorkspaceTourKnownUnset,
  subscribeWorkspaceTour,
  workspaceTourCompleted,
  workspaceTourReplayNonce,
} from '../training/workspaceTourPreferences';
import './WorkspaceTour.css';

function firstTarget(ids: string[]) {
  for (const id of ids) {
    const node = document.querySelector<HTMLElement>(`[data-tour="${id}"]`);
    if (!node) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width < 2 && rect.height < 2) continue;
    return { node, rect };
  }
  return null;
}

export default function WorkspaceTour() {
  const { state, dispatch } = useApp();
  const [, setTick] = useState(0);
  const [stepIndex, setStepIndex] = useState(0);
  const [highlight, setHighlight] = useState<DOMRect | null>(null);
  const completed = workspaceTourCompleted();

  useEffect(() => subscribeWorkspaceTour(() => setTick(value => value + 1)), []);

  useEffect(() => {
    markWorkspaceTourKnownUnset(isLocalPortalPreview);
  }, []);

  const active = completed === false;
  const replayNonce = workspaceTourReplayNonce();
  const step = WORKSPACE_TOUR_STEPS[stepIndex] ?? WORKSPACE_TOUR_STEPS[0];
  const cardRef = useModalFocus<HTMLDivElement>(active, () => persistWorkspaceTourCompleted(true));

  useLayoutEffect(() => {
    if (!active) {
      setStepIndex(0);
      return;
    }
    setStepIndex(0);
    dispatch({ type: 'SET_SCREEN', screen: 'home' });
  }, [active, dispatch, replayNonce]);

  useEffect(() => {
    if (!active || !step) return;
    if (state.screen !== step.screen) dispatch({ type: 'SET_SCREEN', screen: step.screen as Screen });
  }, [active, dispatch, step, state.screen]);

  const measure = useCallback(() => {
    if (!active || !step) {
      setHighlight(null);
      return;
    }
    setHighlight(firstTarget(step.targets)?.rect ?? null);
  }, [active, step]);

  useLayoutEffect(() => {
    if (!active) return;
    const frame = window.requestAnimationFrame(() => {
      measure();
      window.requestAnimationFrame(measure);
    });
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => measure()) : null;
    observer?.observe(document.documentElement);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [active, measure, state.screen, stepIndex]);

  if (!active || !step) return null;

  const pad = 8;
  const highlightStyle = highlight
    ? {
        top: Math.max(8, highlight.top - pad),
        left: Math.max(8, highlight.left - pad),
        width: highlight.width + pad * 2,
        height: highlight.height + pad * 2,
      }
    : null;
  const last = stepIndex === WORKSPACE_TOUR_STEPS.length - 1;
  const status = `Step ${stepIndex + 1} of ${WORKSPACE_TOUR_STEPS.length}`;
  const cardTop = highlightStyle
    ? (highlightStyle.top + highlightStyle.height + 220 > window.innerHeight - 24
      ? Math.max(12, highlightStyle.top - 196)
      : highlightStyle.top + highlightStyle.height + 12)
    : undefined;

  const card = (
    <div className="workspace-tour" role="presentation">
      <div className={`workspace-tour__catcher${highlightStyle ? '' : ' is-dimmed'}`} aria-hidden="true" />
      {highlightStyle ? <div className="workspace-tour__spot" style={highlightStyle} aria-hidden="true" /> : null}
      <div
        ref={cardRef}
        className={`workspace-tour__card${highlightStyle ? '' : ' workspace-tour__card--solo'}`}
        style={highlightStyle ? { top: cardTop, left: Math.min(Math.max(12, highlightStyle.left), window.innerWidth - 372) } : undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-tour-title"
        aria-describedby="workspace-tour-body workspace-tour-status"
        tabIndex={-1}
      >
        <p id="workspace-tour-status" className="workspace-tour__status">{status}</p>
        <h2 id="workspace-tour-title">{step.title}</h2>
        <p id="workspace-tour-body">{step.body}</p>
        <div className="workspace-tour__actions">
          <button type="button" className="workspace-tour__skip" onClick={() => persistWorkspaceTourCompleted(true)}>
            Skip tour
          </button>
          <div className="workspace-tour__nav">
            <button type="button" className="btn btn-secondary" disabled={stepIndex === 0} onClick={() => setStepIndex(index => Math.max(0, index - 1))}>
              Back
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                if (last) persistWorkspaceTourCompleted(true);
                else setStepIndex(index => Math.min(WORKSPACE_TOUR_STEPS.length - 1, index + 1));
              }}
            >
              {last ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(card, document.body);
}
