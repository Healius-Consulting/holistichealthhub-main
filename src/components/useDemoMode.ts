import { useCallback } from 'react';
import { useAuth } from '../auth/useAuth';
import { useApp } from '../context/AppContext';
import { demoOwnerFor, enterDemo, leaveDemo, resetDemo, startingDemoData } from '../training/demoMode';

/** Turn Demo mode on and off, and reset it. Pharmacy staff only. */
export function useDemoMode() {
  const { state: authState } = useAuth();
  const { state, dispatch } = useApp();
  const staff = authState.phase === 'authenticated' ? authState.staff : null;
  const available = staff?.role === 'pharmacy_staff' && state.staffSession?.role === 'pharmacy' && Boolean(state.currentOrganisationId);

  const turnOn = useCallback(() => {
    if (!staff || !available || state.demoMode) return;
    enterDemo(demoOwnerFor(staff));
    dispatch({ type: 'ENTER_DEMO', data: startingDemoData(state.currentOrganisationId) });
    dispatch({ type: 'ADD_TOAST', message: 'Demo mode is on. Nothing you do here is real or sent anywhere.', toastType: 'info', dedupeKey: 'demo-mode' });
  }, [available, dispatch, staff, state.currentOrganisationId, state.demoMode]);

  const returnToLive = useCallback(() => {
    leaveDemo();
    dispatch({ type: 'LEAVE_DEMO' });
    dispatch({ type: 'ADD_TOAST', message: 'Back on your live account. Nothing from the demo was kept.', toastType: 'info', dedupeKey: 'demo-mode' });
  }, [dispatch]);

  const reset = useCallback(() => {
    if (!state.demoMode) return;
    resetDemo();
    dispatch({ type: 'RESET_DEMO', data: startingDemoData(state.currentOrganisationId) });
    dispatch({ type: 'ADD_TOAST', message: 'Demo reset to its starting data.', toastType: 'info', dedupeKey: 'demo-mode' });
  }, [dispatch, state.currentOrganisationId, state.demoMode]);

  return { available, active: state.demoMode, turnOn, returnToLive, reset };
}
