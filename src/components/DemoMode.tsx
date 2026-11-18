import { useEffect } from 'react';
import { Compass, LogIn, RotateCcw } from 'lucide-react';
import { useAuth } from '../auth/useAuth';
import { useApp } from '../context/AppContext';
import { demoBelongsToAnotherLogin, demoOwnerFor, leaveDemo, resumeDemo, startingDemoData } from '../training/demoMode';
import { replayWorkspaceTour } from '../training/workspaceTourPreferences';
import { useDemoMode } from './useDemoMode';

/**
 * Keeps Demo mode tied to the login: a refresh resumes it, logout ends it and deletes the
 * demo changes, and a new sign-in always opens the real account.
 */
export function DemoModeSessionBridge() {
  const { state: authState } = useAuth();
  const { state, dispatch } = useApp();
  const staff = authState.staff;
  const organisationId = state.currentOrganisationId;
  const ready = authState.phase === 'authenticated' && staff?.role === 'pharmacy_staff' && state.staffSession?.role === 'pharmacy' && Boolean(organisationId);

  useEffect(() => {
    if (authState.phase === 'loading') return;
    if (authState.phase !== 'authenticated' || !staff) {
      leaveDemo();
      if (state.demoMode) dispatch({ type: 'LEAVE_DEMO' });
      return;
    }
    const owner = demoOwnerFor(staff);
    if (demoBelongsToAnotherLogin(owner)) {
      leaveDemo();
      if (state.demoMode) dispatch({ type: 'LEAVE_DEMO' });
      return;
    }
    if (!ready || state.demoMode) return;
    const resumed = resumeDemo(owner);
    if (!resumed) return;
    dispatch({ type: 'ENTER_DEMO', data: resumed === 'starting' ? startingDemoData(organisationId) : resumed });
  }, [authState.phase, dispatch, organisationId, ready, staff, state.demoMode]);

  return null;
}

/** Fixed on every screen while Demo mode is on. */
export function DemoModeBanner() {
  const { active, returnToLive, reset } = useDemoMode();
  if (!active) return null;
  return (
    <div className="demo-mode-banner" role="status">
      <strong>Demo</strong>
      <span>You’re in demo mode — nothing here is real</span>
      <div className="demo-mode-banner__actions">
        <button type="button" className="btn btn-sm" onClick={() => replayWorkspaceTour()}>
          <Compass size={13} aria-hidden="true" /> Take the tour
        </button>
        <button type="button" className="btn btn-sm" onClick={reset}>
          <RotateCcw size={13} aria-hidden="true" /> Reset demo
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={returnToLive}>
          <LogIn size={13} aria-hidden="true" /> Return to live
        </button>
      </div>
    </div>
  );
}
