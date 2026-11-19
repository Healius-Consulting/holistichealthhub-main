import { useEffect, useState } from 'react';
import { loadPartnerTerms } from '../../../src/onboarding/loadPartnerTerms';
import type { PartnerTermsLoad } from '../../../src/onboarding/partnerTerms';
import './partner-terms.css';

function setRobots(content: string) {
  const tag = document.querySelector('meta[name="robots"]');
  if (tag) tag.setAttribute('content', content);
}

/**
 * The Holistic Health Hub Partner Terms, as HHH publishes them in admin (the link in
 * the onboarding emails points here). Laid out like the Terms of Use and Privacy
 * Notice, and prints without the site's header and footer. Until the Terms are
 * published the page says so and asks not to be indexed.
 */
export default function PartnerTermsPage() {
  const [terms, setTerms] = useState<PartnerTermsLoad>({ state: 'loading' });

  useEffect(() => {
    let active = true;
    void loadPartnerTerms().then(result => { if (active) setTerms(result); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (terms.state === 'unpublished' || terms.state === 'failed') setRobots('noindex, follow');
  }, [terms.state]);

  return (
    <main id="main-content">
      <article className="hhh-legal hhh-section-inner partner-terms">
        <div className="hhh-rise-copy hhh-page-head__intro">
          <p className="hhh-kicker">Partner Terms</p>
          <h1>Partner Terms — partner pharmacies</h1>
          {terms.state === 'published' && terms.version
            ? <p className="hhh-legal-meta">Version: {terms.version}</p>
            : null}
        </div>

        {terms.state === 'published' ? (
          <>
            <div className="partner-terms__text">
              {terms.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
            </div>
            <p className="partner-terms__actions">
              <button type="button" className="partner-terms__print" onClick={() => window.print()}>Print or save as PDF</button>
            </p>
          </>
        ) : null}
        {terms.state === 'unpublished' ? <p>The Partner Terms will be published here soon.</p> : null}
        {terms.state === 'failed' ? <p role="alert">The Partner Terms could not be loaded. Refresh the page to try again.</p> : null}
        {terms.state === 'loading' ? <p role="status">Loading the Partner Terms…</p> : null}
      </article>
    </main>
  );
}
