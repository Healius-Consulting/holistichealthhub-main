import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Analytics, type BeforeSendEvent } from '@vercel/analytics/react';
import '../../../src/index.css';
import EligibilityApp from '../../eligibility/src/EligibilityApp';
import PaymentReturn from '../../../src/pages/PaymentReturn';
import { readPublicAppCheckToken } from '../../../src/auth/appCheck';
import { setApiSecurityTokenProvider } from '../../../src/shared/api';
import PublicSite from './PublicSite';
import { canonicalEligibilityRedirect, resolvePublicView } from './publicRoute';

setApiSecurityTokenProvider(async () => {
  const token = await readPublicAppCheckToken();
  return token ? { 'X-Firebase-AppCheck': token } : {};
});

/** Drop query/hash so eligibility tokens and payment params never reach analytics. */
function sanitisePublicAnalyticsEvent(event: BeforeSendEvent): BeforeSendEvent | null {
  try {
    const url = new URL(event.url);
    url.search = '';
    url.hash = '';
    return { ...event, url: url.toString() };
  } catch {
    return null;
  }
}

export function PublicApp() {
  const view = resolvePublicView(window.location.pathname, window.location.search);
  if (view === 'eligibility') return <EligibilityApp />;
  if (view === 'payment-complete') return <PaymentReturn status="complete" />;
  if (view === 'payment-cancelled') return <PaymentReturn status="cancelled" />;
  return <PublicSite />;
}

const canonicalRedirect = canonicalEligibilityRedirect(window.location.hostname, window.location.pathname, window.location.search);
if (canonicalRedirect) {
  window.location.replace(canonicalRedirect);
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <PublicApp />
      <Analytics beforeSend={sanitisePublicAnalyticsEvent} />
    </StrictMode>,
  );
}
