import { KEY_CONTACTS, telHref, type KeyContactPill } from '@hhh/domain/key-contacts';
import './KeyContacts.css';

const PILL_CLASS: Record<KeyContactPill, string> = {
  info: 'pill-info',
  neutral: 'pill-neutral',
  ok: 'pill-green',
};

export default function KeyContacts() {
  return (
    <div className="page-body key-contacts">
      <p className="key-contacts__intro">
        Phone the first three. Holistic Health Hub has no telephone line, so those rows are email only.
      </p>
      <ol className="key-contacts__list">
        {KEY_CONTACTS.map(contact => (
          <li key={contact.key} className="card card-surface key-contacts__row">
            <header className="key-contacts__heading">
              <h2>{contact.org}</h2>
              <span className={`pill ${PILL_CLASS[contact.pill]}`}>{contact.role}</span>
            </header>
            {contact.description ? <p className="key-contacts__description">{contact.description}</p> : null}
            <div className="key-contacts__channels">
              {contact.emails.map(email => (
                <a key={email.address} className="key-contacts__link" href={`mailto:${email.address}`}>
                  {email.label ? <span className="key-contacts__purpose">{email.label}</span> : null}
                  <span>{email.address}</span>
                </a>
              ))}
              {contact.phone ? (
                <a className="key-contacts__link" href={telHref(contact.phone)}>{contact.phone}</a>
              ) : (
                <p className="key-contacts__email-only">Email only</p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
