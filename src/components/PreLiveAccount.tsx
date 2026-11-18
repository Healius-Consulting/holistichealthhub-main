import './PharmacyOnboarding.css';
import { FlaskConical, ListChecks } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { awaitingSetupBanner } from '../onboarding/branchOnboarding';
import { useBranchOnboarding } from '../onboarding/useBranchOnboarding';
import { useDemoMode } from './useDemoMode';

const SCREEN_NAMES: Record<string, string> = {
  formulary: 'The Curaleaf catalogue, with stock and prices,',
  create: 'Ordering',
  orders: 'Orders',
};

/**
 * In place of a Curaleaf-dependent screen before go-live. It never shows demo data in
 * the real account: it points at Demo mode instead.
 */
export function PreLiveScreen({ screen }: { screen: string }) {
  const { dispatch } = useApp();
  const demo = useDemoMode();
  return (
    <div className="page-body pre-live-screen">
      <section className="card pre-live-screen__card" aria-labelledby="pre-live-screen-title">
        <h2 id="pre-live-screen-title">Available once your account is live</h2>
        <p>
          {SCREEN_NAMES[screen] ?? 'This screen'} opens when Curaleaf Laboratories have set up your account.
          Until then you can try it on example data in Demo mode. Nothing you do there is real or sent anywhere.
        </p>
        <div className="pre-live-screen__actions">
          {demo.available ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={demo.turnOn}>
              <FlaskConical size={14} aria-hidden="true" /> Try it in Demo mode
            </button>
          ) : null}
          <button type="button" className="btn btn-sm" onClick={() => dispatch({ type: 'SET_SCREEN', screen: 'onboarding' })}>
            <ListChecks size={14} aria-hidden="true" /> See your onboarding
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * The one banner a branch awaiting Curaleaf sees in its own account. It clears at
 * go-live, and gives way to the Demo mode banner while demo is on.
 */
export function AwaitingSetupBanner() {
  const { state } = useApp();
  const organisation = state.organisations.find(org => org.id === state.currentOrganisationId);
  const flags = { status: organisation?.status, workspaceMode: state.workspaceMode, demo: state.demoMode };
  const awaiting = awaitingSetupBanner({ ...flags, submittedAt: null }) !== null;
  const { view } = useBranchOnboarding(organisation?.id, awaiting && state.staffSession?.role === 'pharmacy');
  const banner = awaitingSetupBanner({ ...flags, submittedAt: view?.submittedAt });
  if (!banner) return null;
  return (
    <div className="training-mode-banner awaiting-setup-banner" role="status">
      <strong>Awaiting Curaleaf</strong>
      <span>
        <b>{banner.title}</b>
        {banner.submitted ? <> · {banner.submitted}</> : null}. {banner.body}
      </span>
    </div>
  );
}
