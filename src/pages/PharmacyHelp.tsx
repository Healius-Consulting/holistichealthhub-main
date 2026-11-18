import { useId, useState } from 'react';
import { BookOpen, Compass, ExternalLink, LifeBuoy, ListChecks, Mail, Search } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { requestWorkspaceTourReplay } from '../training/workspaceTourPersist';
import { HELP_TOPICS, ONBOARDING_INBOX, PHARMACY_GUIDES, searchFaq } from '../onboarding/pharmacyHelp';
import './PharmacyHelp.css';

/** Brief 2.10: the FAQ and links to the guides, for the pharmacy's own staff. */
export default function PharmacyHelp() {
  const { dispatch } = useApp();
  const [query, setQuery] = useState('');
  const searchId = useId();
  const matches = searchFaq(query);

  return (
    <div className="page-body pharmacy-help">
      <section className="card pharmacy-help__faq" aria-labelledby="pharmacy-help-faq-title">
        <header>
          <h2 id="pharmacy-help-faq-title">Frequently asked questions</h2>
          <p>Quick answers about setting up and using the platform.</p>
        </header>
        <label className="pharmacy-help__search" htmlFor={searchId}>
          <Search size={15} aria-hidden="true" />
          <span className="sr-only">Search the questions</span>
          <input id={searchId} type="search" className="input" placeholder="Search the questions" value={query} onChange={event => setQuery(event.target.value)} />
        </label>
        {matches.length ? HELP_TOPICS.map(topic => {
          const items = matches.filter(item => item.topic === topic.id);
          if (!items.length) return null;
          return (
            <section key={topic.id} className="pharmacy-help__topic" aria-labelledby={`pharmacy-help-${topic.id}`}>
              <h3 id={`pharmacy-help-${topic.id}`}>{topic.title}</h3>
              {items.map(item => (
                <details key={item.id} className="pharmacy-help__question" open={query.trim() ? true : undefined}>
                  <summary>{item.question}</summary>
                  <p>{item.answer}</p>
                </details>
              ))}
            </section>
          );
        }) : (
          <p className="pharmacy-help__empty" role="status">
            No questions match. Email <a href={`mailto:${ONBOARDING_INBOX}`}>{ONBOARDING_INBOX}</a> and we'll help.
          </p>
        )}
      </section>

      <aside className="pharmacy-help__side">
        <section className="card pharmacy-help__card" aria-labelledby="pharmacy-help-guides-title">
          <h2 id="pharmacy-help-guides-title"><BookOpen size={15} aria-hidden="true" /> Guides</h2>
          <ul>
            {PHARMACY_GUIDES.map(guide => (
              <li key={guide.id}>
                <a href={guide.href} target="_blank" rel="noopener noreferrer">{guide.title} <ExternalLink size={12} aria-hidden="true" /></a>
                <small>{guide.detail}</small>
              </li>
            ))}
            <li>
              <button type="button" className="pharmacy-help__link" onClick={() => requestWorkspaceTourReplay()}>
                <Compass size={13} aria-hidden="true" /> Replay the workspace tour
              </button>
              <small>A walk through each screen.</small>
            </li>
            <li>
              <button type="button" className="pharmacy-help__link" onClick={() => dispatch({ type: 'SET_SCREEN', screen: 'onboarding' })}>
                <ListChecks size={13} aria-hidden="true" /> Your onboarding
              </button>
              <small>What's done, what's next, and the go-live checklist.</small>
            </li>
          </ul>
        </section>
        <section className="card pharmacy-help__card" aria-labelledby="pharmacy-help-contact-title">
          <h2 id="pharmacy-help-contact-title"><LifeBuoy size={15} aria-hidden="true" /> Still stuck?</h2>
          <p>Holistic Health Hub is email only.</p>
          <a className="btn btn-sm" href={`mailto:${ONBOARDING_INBOX}`}><Mail size={13} aria-hidden="true" /> {ONBOARDING_INBOX}</a>
          <button type="button" className="pharmacy-help__link" onClick={() => dispatch({ type: 'SET_SCREEN', screen: 'contacts' })}>
            All contacts, for the clinic and supply
          </button>
        </section>
      </aside>
    </div>
  );
}
