import { useCallback, useEffect, useState } from 'react';
import { CreditCard } from 'lucide-react';
import { loadWorldpayApplication, type WorldpayApplicationView } from '../shared/api';
import { WorldpayApplicationForm } from './WorldpayApplicationForm';
import { WorldpayApplicationStatusPanel } from './WorldpayApplicationStatus';

/**
 * The awaiting activation page: the optional Worldpay application, for a pharmacy that has
 * not sent it yet. The same form and draft as the onboarding page (owned by the request,
 * moved to the branch at activation). Shows nothing when the form can't be reached here
 * (a load error), or when the pharmacy said it already takes online payments with Worldpay.
 */
export function AwaitingWorldpayOffer({ onboardingRequestId }: { onboardingRequestId: string }) {
  const [view, setView] = useState<WorldpayApplicationView<{ existingAccount?: string }> | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(() => {
    loadWorldpayApplication<{ existingAccount?: string }>({ kind: 'request', onboardingRequestId })
      .then(setView)
      .catch(() => setView(null));
  }, [onboardingRequestId]);
  useEffect(refresh, [refresh]);

  if (!view) return null;
  const sent = Boolean(view.status) && view.status !== 'DRAFT';
  if (!sent && view.status === 'DRAFT' && view.answers?.existingAccount === 'online') return null;
  const draft = view.status === 'DRAFT' && Boolean(view.id);

  return (
    <div className="onb-status__worldpay">
      {sent ? (
        <WorldpayApplicationStatusPanel view={view} />
      ) : (
        <>
          <p className="onb-status__worldpay-title"><CreditCard size={16} aria-hidden="true" /> <strong>Worldpay card payments</strong> <span>Optional</span></p>
          <p>
            {draft
              ? 'Your answers are saved. Pick up where you left off while you wait.'
              : 'Lets patients pay by card through a secure link. You can send the form while you wait, or later from your account.'}
          </p>
          <p className="onb-status__worldpay-note">Already sent us a Worldpay form by email? You don’t need to do it again.</p>
          <button type="button" className="onb-status__button" onClick={() => setOpen(true)}>
            {draft ? 'Continue application' : 'Fill in the Worldpay form'}
          </button>
        </>
      )}
      <WorldpayApplicationForm
        open={open}
        owner={{ kind: 'request', onboardingRequestId }}
        onClose={() => { setOpen(false); refresh(); }}
      />
    </div>
  );
}
