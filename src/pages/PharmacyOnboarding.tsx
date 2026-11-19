import { useState } from 'react';
import { Check, Clock3, ExternalLink } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { useAuth } from '../auth/useAuth';
import PharmacyAccountStatus from '../components/PharmacyAccountStatus';
import GoLiveChecklist from '../components/GoLiveChecklist';
import { useDemoMode } from '../components/useDemoMode';
import { PartnerTermsForm } from '../auth/PartnerTermsForm';
import { WorldpayApplicationForm } from '../worldpay/WorldpayApplicationForm';
import { PORTAL_ONBOARDING_QUEUE_UTM, pharmsmartOnboardingBookingUrl } from '../auth/pharmsmart-login';
import { acceptBranchPartnerTerms } from '../shared/api';
import { isLocalPortalPreview } from '../dev/localPortalPreview';
import { onboardingQueueItems, pharmacyAccountState, type OnboardingQueueItem } from '../onboarding/branchOnboarding';
import { useBranchOnboarding } from '../onboarding/useBranchOnboarding';

/** The pharmacy's Onboarding page: its account status, then the onboarding queue. */
export default function PharmacyOnboarding() {
  const { state, dispatch } = useApp();
  const { state: authState } = useAuth();
  const demo = useDemoMode();
  const organisation = state.organisations.find(org => org.id === state.currentOrganisationId) ?? state.organisations[0];
  const pharmacyStaff = state.staffSession?.role === 'pharmacy';
  const { view, error, update } = useBranchOnboarding(organisation?.id, pharmacyStaff);
  const [termsOpen, setTermsOpen] = useState(false);
  const [worldpayOpen, setWorldpayOpen] = useState(false);
  // Sending the Terms or the Worldpay form changes the checklist's own ticks, so it reloads.
  const [checklistVersion, setChecklistVersion] = useState(0);

  if (!organisation) return null;
  const live = view?.live ?? organisation.status === 'live';
  const accountState = live ? null : pharmacyAccountState(organisation.status);
  const items = onboardingQueueItems({
    live,
    termsAccepted: view?.termsAccepted ?? false,
    worldpaySubmittedAt: view?.worldpaySubmittedAt ?? null,
    demoActive: state.demoMode,
  });
  const staff = authState.staff;
  const bookingUrl = pharmsmartOnboardingBookingUrl(
    { firstName: staff?.name ?? null, lastName: null, email: staff?.email ?? null },
    { utm: PORTAL_ONBOARDING_QUEUE_UTM },
  );
  // Demo mode refuses every write, and the forms here are the real account's.
  const formsBlocked = state.demoMode || !pharmacyStaff || !view;

  const act = (item: OnboardingQueueItem) => {
    const kind = item.action?.kind;
    if (kind === 'terms') setTermsOpen(true);
    if (kind === 'worldpay') setWorldpayOpen(true);
    if (kind === 'demo') demo.turnOn();
  };

  const renderAction = (item: OnboardingQueueItem) => {
    if (!item.action) return item.status ? <span className="pharmacy-onboarding__status">{item.status}</span> : null;
    if (item.action.kind === 'book') {
      return (
        <a className="btn btn-sm" href={bookingUrl} target="_blank" rel="noopener noreferrer">
          {item.action.label} <ExternalLink size={13} aria-hidden="true" />
        </a>
      );
    }
    const isForm = item.action.kind === 'terms' || item.action.kind === 'worldpay';
    const disabled = (isForm && formsBlocked) || (item.action.kind === 'demo' && !demo.available);
    return (
      <button type="button" className="btn btn-primary btn-sm" disabled={disabled} onClick={() => act(item)}>
        {item.action.label}
      </button>
    );
  };

  return (
    <div className="page-body pharmacy-onboarding" data-tour="onboarding">
      {accountState ? (
        <PharmacyAccountStatus state={accountState}>
          <button type="button" className="btn btn-sm" onClick={() => dispatch({ type: 'SET_SCREEN', screen: 'patients' })}>Open patients</button>
        </PharmacyAccountStatus>
      ) : null}

      <section className="card pharmacy-onboarding__queue" aria-labelledby="pharmacy-onboarding-queue-title">
        <header>
          <h2 id="pharmacy-onboarding-queue-title">Onboarding</h2>
          <p>What is done, what we are waiting on, and what you can do next.</p>
        </header>
        {error ? <p className="pharmacy-onboarding__error" role="alert">{error}</p> : null}
        {state.demoMode ? <p className="pharmacy-onboarding__note">You are in demo mode. Return to live to send the Partner Terms or the Worldpay form.</p> : null}
        <ol className="pharmacy-onboarding__items">
          {items.map(item => (
            <li key={item.id} className={`pharmacy-onboarding__item is-${item.state}`} data-item={item.id}>
              <span className="pharmacy-onboarding__mark" aria-hidden="true">
                {item.state === 'done' ? <Check size={13} strokeWidth={3} /> : item.state === 'waiting' ? <Clock3 size={13} /> : null}
              </span>
              <span className="pharmacy-onboarding__text">
                <strong>{item.title}</strong>
                <small>{item.detail}</small>
              </span>
              <span className="pharmacy-onboarding__action">{renderAction(item)}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="card pharmacy-onboarding__checklist" aria-labelledby="pharmacy-onboarding-checklist-title">
        <header>
          <h2 id="pharmacy-onboarding-checklist-title">Go-live checklist</h2>
          <p>Tick what your pharmacy has done. Nothing on the platform waits on this list.</p>
        </header>
        <GoLiveChecklist
          key={checklistVersion}
          onOpenWorldpayForm={formsBlocked ? undefined : () => (view?.termsAccepted ? setWorldpayOpen(true) : setTermsOpen(true))}
        />
      </section>

      <PartnerTermsForm
        open={termsOpen}
        request={{ id: organisation.id, pharmacyName: organisation.name, registeredCompanyName: view?.registeredCompanyName ?? organisation.tradingName }}
        signer={{ name: staff?.name ?? '', email: staff?.email ?? '' }}
        intro="Accept the Partner Terms for your pharmacy. The Worldpay form opens straight after."
        send={async input => {
          if (isLocalPortalPreview) return;
          await acceptBranchPartnerTerms(input);
        }}
        onClose={() => setTermsOpen(false)}
        onAccepted={() => {
          setTermsOpen(false);
          update({ termsAccepted: true, termsAcceptedAt: new Date().toISOString() });
          setChecklistVersion(version => version + 1);
          // Straight on to Worldpay, which the pharmacy can close to do later.
          setWorldpayOpen(true);
        }}
      />
      <WorldpayApplicationForm
        open={worldpayOpen}
        owner={{ kind: 'branch' }}
        onClose={() => {
          setWorldpayOpen(false);
          setChecklistVersion(version => version + 1);
        }}
        onChanged={change => {
          if (change.status && change.status !== 'DRAFT') {
            update({ worldpaySubmittedAt: new Date().toISOString() });
            dispatch({ type: 'ADD_TOAST', message: 'Worldpay application sent. We have emailed you what happens next.', toastType: 'success' });
          }
        }}
      />
    </div>
  );
}
