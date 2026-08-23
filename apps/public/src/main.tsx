import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Analytics } from '@vercel/analytics/react';
import { SpeedInsights } from '@vercel/speed-insights/react';
import '../../../src/index.css';
import EligibilityApp from '../../eligibility/src/EligibilityApp';
import PaymentReturn from '../../../src/pages/PaymentReturn';
import { readPublicAppCheckToken } from '../../../src/auth/appCheck';
import { setApiSecurityTokenProvider } from '../../../src/shared/api';
import PublicSite from './PublicSite';
import { usePublicLocation } from './publicLocation';
import { canonicalEligibilityRedirect, resolvePublicView } from './publicRoute';
import { applyPublicSurface } from './publicSurface';
import './public-site.css';

setApiSecurityTokenProvider(async () => {
  const token = await readPublicAppCheckToken();
  return token ? { 'X-Firebase-AppCheck': token } : {};
});

/** Drop query/hash so eligibility tokens and payment params never reach Vercel. */
function stripPublicTrackingUrl<T extends { url: string }>(event: T): T | null {
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
  const location = usePublicLocation();
  const view = resolvePublicView(location.pathname, location.search);
  if (view === 'payment-complete') return <PaymentReturn status="complete" />;
  if (view === 'payment-cancelled') return <PaymentReturn status="cancelled" />;
  if (view === 'eligibility') return <EligibilityApp />;
  return <PublicSite />;
}

applyPublicSurface(window.location.pathname, window.location.search);

const canonicalRedirect = canonicalEligibilityRedirect(window.location.hostname, window.location.pathname, window.location.search);
if (canonicalRedirect) {
  window.location.replace(canonicalRedirect);
} else {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <PublicApp />
      <Analytics beforeSend={stripPublicTrackingUrl} />
      <SpeedInsights beforeSend={stripPublicTrackingUrl} />
    </StrictMode>,
  );
}
