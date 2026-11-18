import { ListChecks } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { pharmacyWorkspaceStatusLabel } from '../training/workspace';
import WorkspacePageHeader from './WorkspacePageHeader';

const SCREEN_TITLES: Record<string, string> = {
  home: 'Pharmacy overview',
  formulary: 'Curaleaf catalogue',
  create: 'Create prescription order',
  orders: 'Orders',
  patients: 'Patients hub',
  finance: 'Prescription financials',
  settings: 'Settings & support',
  contacts: 'Settings & support',
  onboarding: 'Onboarding',
};

export default function Header() {
  const { state, dispatch } = useApp();
  const organisation = state.organisations.find((org) => org.id === state.currentOrganisationId) ?? state.organisations[0];
  const title = SCREEN_TITLES[state.screen] || 'HHH Portal';
  const paused = organisation?.status === 'paused';
  const workspaceLabel = state.demoMode ? 'Demo' : pharmacyWorkspaceStatusLabel(state.workspaceMode);

  return (
    <WorkspacePageHeader
      section={organisation.name}
      context={title}
      title={title}
      commandLabel="Find anything"
      onSectionClick={() => dispatch({ type: 'SET_SCREEN', screen: 'home' })}
      backAction={state.screenHistory.length ? { label: 'Return to previous workspace', onClick: () => dispatch({ type: 'GO_BACK' }) } : undefined}
      actions={
        <button
          type="button"
          className={`btn btn-sm header-onboarding-button${state.screen === 'onboarding' ? ' is-active' : ''}`}
          aria-current={state.screen === 'onboarding' ? 'page' : undefined}
          onClick={() => dispatch({ type: 'SET_SCREEN', screen: 'onboarding' })}
        >
          <ListChecks size={14} aria-hidden="true" /> Onboarding
        </button>
      }
      contextControl={
        <div className="header-context" aria-label={`Current pharmacy status: ${workspaceLabel}${paused ? ', paused' : ''}`}>
          <span>Workspace</span>
          <span className={`tenant-status tenant-status--${state.demoMode ? 'demo' : state.workspaceMode}`}>{workspaceLabel}</span>
          {paused ? <span className="tenant-status tenant-status--paused">Paused</span> : null}
        </div>
      }
      identity={
        <div className="header-curaleaf-id">
          <span>Curaleaf customer ID</span>
          {' '}
          <strong title={organisation.curaleafPharmacyCode || undefined}>{organisation.curaleafPharmacyCode ?? 'Not connected'}</strong>
        </div>
      }
    />
  );
}
