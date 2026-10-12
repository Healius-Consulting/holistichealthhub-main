import { useEffect } from 'react';
import { PharmsmartWelcome } from '../../../src/auth/PharmsmartOnboardingGuide';

const PORTAL_LOGIN = 'https://portal.holistichealthhub.live/login';
const PAGE_TITLE = 'Pharmacy onboarding | Holistic Health Hub';
const PAGE_DESCRIPTION = 'Send the Curaleaf and Worldpay forms to join Holistic Health Hub. A call is optional.';

export default function PharmacyOnboardingPage() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = PAGE_TITLE;
    const description = document.querySelector('meta[name="description"]');
    const previousDescription = description?.getAttribute('content') ?? null;
    description?.setAttribute('content', PAGE_DESCRIPTION);
    const canonical = document.querySelector('link[rel="canonical"]');
    const previousCanonical = canonical?.getAttribute('href') ?? null;
    canonical?.setAttribute('href', 'https://holistichealthhub.live/pharmacy-onboarding');
    return () => {
      document.title = previousTitle;
      if (previousDescription) description?.setAttribute('content', previousDescription);
      if (previousCanonical) canonical?.setAttribute('href', previousCanonical);
    };
  }, []);

  return (
    <PharmsmartWelcome
      welcome={{ email: null, firstName: null, lastName: null }}
      accountHref={PORTAL_LOGIN}
    />
  );
}
