import { useApp } from '../context/AppContext';
import WorkspacePageHeader from './WorkspacePageHeader';

const SCREEN_TITLES: Record<string, string> = {
  home: 'Pharmacy overview',
  formulary: 'Curaleaf catalogue',
  create: 'Create prescription order',
  orders: 'Orders',
  patients: 'Patients hub',
  finance: 'Prescription financials',
  settings: 'Settings & assets',
};

export default function Header() {
  const { state, dispatch } = useApp();
  const organisation = state.organisations.find((org) => org.id === state.currentOrganisationId) ?? state.organisations[0];
  const title = SCREEN_TITLES[state.screen] || 'HHH Portal';

  return (
    <WorkspacePageHeader
      section={organisation.tradingName}
      context={title}
      title={title}
      commandLabel="Find anything"
      onSectionClick={() => dispatch({ type: 'SET_SCREEN', screen: 'home' })}
      backAction={state.screenHistory.length ? { label: 'Return to previous workspace', onClick: () => dispatch({ type: 'GO_BACK' }) } : undefined}
      contextControl={
        <div className="header-context" aria-label={`Current pharmacy status: ${state.workspaceMode === 'live' ? 'Live' : 'Training'}${organisation?.status === 'paused' ? ', paused' : ''}`}>
          <span>Workspace</span>
          <span className={`tenant-status tenant-status--${state.workspaceMode}`}>{state.workspaceMode === 'live' ? 'Live' : 'Training'}</span>
          {organisation?.status === 'paused' ? <span className="tenant-status tenant-status--paused">Paused</span> : null}
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
