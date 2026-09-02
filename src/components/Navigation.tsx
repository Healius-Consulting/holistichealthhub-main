import { ArrowUpRight, BadgePoundSterling, FilePlus, Home, LogOut, Package, Settings, Tags, Users } from 'lucide-react';


import { useAuth } from '../auth/useAuth';
import { useApp, type Screen } from '../context/AppContext';
import HhhBrandMark from './HhhBrandMark';
import WorkspaceNavigation, { type WorkspaceNavGroup } from './WorkspaceNavigation';
import { PORTAL_APP_VERSION } from '../constants/pharmacy';
import { pharmacyWorkspaceStatusLabel } from '../training/workspace';

export default function Navigation() {
  const { state, dispatch } = useApp();
  const { signOutStaff } = useAuth();
  const organisation = state.organisations.find(org => org.id === state.currentOrganisationId) ?? state.organisations[0];
  const tenantOrders = state.orders.filter(order => order.organisationId === organisation.id);
  const isAdminViewingClient = state.staffSession?.role === 'admin';
  const staffName = state.staffSession?.name || 'Staff User';
  const staffInitials = staffName.split(' ').map(part => part[0]).join('').slice(0, 2).toUpperCase();
  const counts: Partial<Record<Screen, number>> = {
    create: tenantOrders.filter(o => o.payment.status === 'none' && o.prescriptions.some(r => r.items.length > 0)).length,
    orders: tenantOrders.filter(o => o.payment.status !== 'none' && o.prescriptions.some(r => r.status !== 'collected')).length,
  };

  const groups: WorkspaceNavGroup<Screen>[] = [
    {
      label: 'Operations',
      items: [
        { key: 'home', label: 'Overview', icon: <Home size={17} /> },
        { key: 'create', label: 'Create order', shortLabel: 'Create', icon: <FilePlus size={17} />, count: counts.create },
        { key: 'orders', label: 'Orders', shortLabel: 'Orders', icon: <Package size={17} />, count: counts.orders },
        { key: 'patients', label: 'Patients', shortLabel: 'Patients', icon: <Users size={17} />, count: counts.patients },
      ],
    },
    {
      label: 'Workspace',
      items: [
        { key: 'formulary', label: 'Catalogue', shortLabel: 'Catalogue', icon: <Tags size={17} /> },
        { key: 'finance', label: 'Financials', shortLabel: 'Financials', icon: <BadgePoundSterling size={17} /> },
        { key: 'settings', label: 'Settings & Assets', icon: <Settings size={17} /> },
      ],
    },
  ];


  return (
    <WorkspaceNavigation
      ariaLabel="Pharmacy workspace"
      activeKey={state.screen}
      groups={groups}
      mobilePrimaryKeys={['home', 'create', 'orders', 'patients']}
      onNavigate={screen => dispatch({ type: 'SET_SCREEN', screen })}
      brand={{ title: 'Holistic Health Hub', subtitle: 'Pharmacy operations', partner: organisation.tradingName, logo: <HhhBrandMark /> }}
      version={PORTAL_APP_VERSION}
      user={{ initials: staffInitials, name: staffName, role: isAdminViewingClient ? 'HHH administrator' : `Pharmacy staff · ${pharmacyWorkspaceStatusLabel(state.workspaceMode)}` }}
      exitAction={{
        label: isAdminViewingClient ? 'Return to administration' : 'Sign out',
        icon: isAdminViewingClient ? <ArrowUpRight size={14} /> : <LogOut size={14} />,
        onClick: () => { if (isAdminViewingClient) dispatch({ type: 'SET_PORTAL_MODE', mode: 'admin' }); else void signOutStaff(); },
      }}
    />
  );
}
