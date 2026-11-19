import '../styles/partner-terms-form.css';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ApiRequestError, acceptPartnerTerms, describeApiError } from '../shared/api';
import type { PharmsmartTermsRequest } from './types';
import { Field, FormBottom, FormIntro, FormTop, PillChoice, Row, Section, Stepper, SummaryCard } from '../components/OnboardingFormParts';
import { loadPartnerTerms } from '../onboarding/loadPartnerTerms';
import type { PartnerTermsLoad } from '../onboarding/partnerTerms';

const ROLES = [
  { id: 'SUPERINTENDENT_PHARMACIST', label: 'Superintendent pharmacist', pharmacist: true },
  { id: 'PHARMACIST', label: 'Pharmacist', pharmacist: true },
  { id: 'DIRECTOR', label: 'Director', pharmacist: false },
  { id: 'PHARMACY_MANAGER', label: 'Pharmacy manager', pharmacist: false },
  { id: 'OTHER', label: 'Other', pharmacist: false },
] as const;

type RoleId = typeof ROLES[number]['id'];
type Person = { name: string; email: string };

/**
 * The Partner Terms step, between the Curaleaf form and Worldpay. Shows the Terms HHH
 * published in admin, with their version; until they are published it keeps the
 * placeholder block. Accepting is what sends the Curaleaf application.
 */
export function PartnerTermsForm({
  open,
  request,
  pharmsmartTicket,
  signer,
  onClose,
  onAccepted,
  send,
  intro = 'Your Curaleaf account form is in. Accept the Partner Terms to send it to Curaleaf Laboratories.',
  people,
}: {
  open: boolean;
  request: PharmsmartTermsRequest | null;
  pharmsmartTicket?: string | null;
  /** Who signed in from PharmSmart, as a starting point. */
  signer: { name: string; email: string };
  onClose: () => void;
  onAccepted: () => void;
  /** The portal accepts for the signed-in branch instead of an onboarding request. */
  send?: (input: { signerName: string; signerRole: string; signerRoleOther: string; signerEmail: string; signerGphcNumber: string; authorised: true }) => Promise<unknown>;
  intro?: string;
  /** Who PharmSmart says the superintendent and manager are, so choosing that role fills them in. */
  people?: { superintendent?: Person | null; manager?: Person | null };
}) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(false);
  onCloseRef.current = onClose;
  const [name, setName] = useState(signer.name);
  const [email, setEmail] = useState(signer.email);
  const [role, setRole] = useState<RoleId | ''>('');
  const [roleOther, setRoleOther] = useState('');
  /** The name and email the last role choice filled in, so a later choice only replaces those, never typing. */
  const filledBy = useRef<{ name: string; email: string } | null>(null);
  const [gphc, setGphc] = useState('');
  const [authorised, setAuthorised] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [step, setStep] = useState<1 | 2>(1);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  busyRef.current = busy;
  const [terms, setTerms] = useState<PartnerTermsLoad>({ state: 'loading' });

  // Fetched once the form opens; anything but published Terms keeps the placeholder.
  useEffect(() => {
    if (!open) return;
    let active = true;
    void loadPartnerTerms().then(result => { if (active) setTerms(result); });
    return () => { active = false; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setProblems({});
    setStep(1);
    setBusy(false);
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open || !request) return null;
  const company = request.registeredCompanyName || request.pharmacyName;
  const pharmacist = ROLES.find(option => option.id === role)?.pharmacist ?? false;

  const scrollTop = () => bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });

  const signerProblems = () => {
    const found: Record<string, string> = {};
    if (!role) found.role = 'Choose your role.';
    if (role === 'OTHER' && !roleOther.trim()) found.roleOther = 'Type your role.';
    if (name.trim().length < 2) found.name = 'Enter your full name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) found.email = 'Enter your email address.';
    if (pharmacist && !/^\s*(\d\s*){7}$/.test(gphc)) found.gphc = 'Enter your 7-digit GPhC registration number.';
    return found;
  };

  const toSign = () => {
    const found = signerProblems();
    setProblems(found);
    if (Object.keys(found).length) { setStep(1); scrollTop(); return; }
    setStep(2);
    scrollTop();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (step === 1) { toSign(); return; }
    const found = signerProblems();
    if (Object.keys(found).length || !role) { setProblems(found); setStep(1); scrollTop(); return; }
    const signProblems: Record<string, string> = {};
    if (!authorised) signProblems.authorised = 'Tick to confirm you are authorised to accept the terms.';
    setProblems(signProblems);
    if (Object.keys(signProblems).length) return;
    setBusy(true);
    setError(null);
    try {
      const signed = {
        signerName: name.trim(),
        signerRole: role,
        signerRoleOther: role === 'OTHER' ? roleOther.trim() : '',
        signerEmail: email.trim(),
        signerGphcNumber: pharmacist ? gphc.trim() : '',
        authorised: true as const,
      };
      if (send) await send(signed);
      else await acceptPartnerTerms({ onboardingRequestId: request.id, ...signed, ...(pharmsmartTicket ? { pharmsmartTicket } : {}) });
      onAccepted();
    } catch (cause) {
      setError(cause instanceof ApiRequestError ? describeApiError(cause, 'The terms could not be accepted. Try again.') : 'The terms could not be accepted. Try again.');
      setBusy(false);
    }
  };

  const roleLabel = role === 'OTHER' ? roleOther.trim() || 'Other' : ROLES.find(option => option.id === role)?.label ?? '';
  const personFor = (choice: RoleId | '') => (choice === 'SUPERINTENDENT_PHARMACIST' ? people?.superintendent : choice === 'PHARMACY_MANAGER' ? people?.manager : null) ?? null;
  const known = personFor(role);
  const filledNow = Boolean(known && filledBy.current && name === filledBy.current.name && email === filledBy.current.email);

  /** Choosing the superintendent or manager fills in who PharmSmart says they are; another choice puts back what was there. */
  const chooseRole = (choice: RoleId) => {
    setRole(choice);
    const untouched = !filledBy.current || (name === filledBy.current.name && email === filledBy.current.email);
    if (!untouched) return;
    const person = personFor(choice);
    if (person) {
      const next = { name: person.name || name, email: person.email || email };
      filledBy.current = next;
      setName(next.name);
      setEmail(next.email);
    } else if (filledBy.current) {
      filledBy.current = null;
      setName(signer.name);
      setEmail(signer.email);
    }
  };

  return createPortal(
    <div className="onboarding-dialog" role="presentation">
      <button className="onboarding-dialog__backdrop" type="button" aria-label="Close terms" onClick={onClose} disabled={busy} />
      <form className="onboarding-dialog__panel wpa" role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={event => void submit(event)} noValidate>
        <FormTop eyebrow="Partner Terms" title={company} titleId={titleId} onClose={onClose} closeLabel="Close terms" disabled={busy} closeRef={closeRef}>
          <Stepper steps={['Who is signing', 'Read and sign']} current={step} onGo={index => (index === 1 ? setStep(1) : toSign())} locked={busy} />
        </FormTop>
        <div className="wpa-body" ref={bodyRef}>
          <div className="wpa-content">
            {error ? <p className="wpa-alert" role="alert">{error}</p> : null}
            {step === 1 ? (
              <>
                <FormIntro title="Who is signing">{intro}</FormIntro>
                <Section title="About you" description={`The person accepting the terms on behalf of ${company}.`}>
                  <span className="wpa-field__label">Your role</span>
                  <PillChoice name="Your role" value={role} options={ROLES.map(option => ({ value: option.id, label: option.label }))} onChange={chooseRole} />
                  {problems.role ? <span className="wpa-field__problem">{problems.role}</span> : null}
                  {role === 'OTHER' ? (
                    <div className="wpa-grid has-gap-above">
                      <Field label="What is your role?" hint="For example, company secretary or area manager." problem={problems.roleOther}>
                        <input className="input" name="signerRoleOther" value={roleOther} onChange={event => setRoleOther(event.target.value)} maxLength={80} autoComplete="organization-title" />
                      </Field>
                    </div>
                  ) : null}
                  {filledNow && known ? (
                    <p className="wpa-note has-gap-above">Filled in from PharmSmart: {known.name}, the pharmacy’s {role === 'SUPERINTENDENT_PHARMACIST' ? 'superintendent pharmacist' : 'manager'}. Change the details below if someone else is signing.</p>
                  ) : null}
                  <div className="wpa-grid has-gap-above">
                    <Field label="Your full name" hint="This is the name your signature is made from." problem={problems.name}>
                      <input className="input" name="signerName" value={name} onChange={event => setName(event.target.value)} maxLength={160} autoComplete="name" />
                    </Field>
                    <Field label="Your email" problem={problems.email}>
                      <input className="input" name="signerEmail" type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" />
                    </Field>
                    {pharmacist ? (
                      <Field label="Your GPhC registration number" hint="7 digits. Your own number, not the premises number." problem={problems.gphc}>
                        <input className="input" name="signerGphcNumber" value={gphc} onChange={event => setGphc(event.target.value)} inputMode="numeric" autoComplete="off" />
                      </Field>
                    ) : null}
                  </div>
                </Section>
              </>
            ) : (
              <>
                <FormIntro title="Read and sign">Read the Partner Terms, then sign to accept them for {company}.</FormIntro>
                <Section title="The terms" description={terms.state === 'published' && terms.version ? `Version ${terms.version}` : undefined} tone="quiet">
                  <div
                    className={`partner-terms-form__terms${terms.state === 'published' ? ' is-published' : ''}`}
                    aria-label="Partner Terms text"
                    {...(terms.state === 'published' ? { role: 'region', tabIndex: 0 } : {})}
                  >
                    {terms.state === 'published'
                      ? terms.paragraphs.map((paragraph, index) => <p key={index} className="partner-terms-form__paragraph">{paragraph}</p>)
                      : <p>New item — to be updated here</p>}
                  </div>
                </Section>
                <SummaryCard title="Signing as" step={1} onEdit={() => setStep(1)}>
                  <Row label="Name" value={name.trim()} />
                  <Row label="Role" value={roleLabel} />
                  <Row label="Email" value={email} />
                  {pharmacist ? <Row label="GPhC registration number" value={gphc} /> : null}
                </SummaryCard>
                <Section title="Sign">
                  <label className="wpa-check">
                    <input type="checkbox" name="authorised" checked={authorised} onChange={event => setAuthorised(event.target.checked)} />
                    <span>I confirm I am authorised to accept these terms on behalf of <strong>{company}</strong></span>
                  </label>
                  {problems.authorised ? <span className="wpa-field__problem">{problems.authorised}</span> : null}
                  <div className="wpa-signature">
                    <p className="curaleaf-account-form__sign"><strong>{name.trim()}</strong></p>
                    <small className="wpa-tiny">Your signature, from the name you gave. Ticking the box and accepting signs the terms, with today’s date.</small>
                  </div>
                </Section>
              </>
            )}
          </div>
        </div>
        <FormBottom status={<span className="wpa-save">{step === 1 ? 'Nothing is sent until you accept.' : 'Accepting sends your Curaleaf form to Curaleaf Laboratories.'}</span>}>
          {step === 2 ? <button type="button" className="wpa-back" onClick={() => { setStep(1); scrollTop(); }} disabled={busy}>Back</button> : null}
          <button className="btn btn-primary wpa-next" type="submit" disabled={busy}>
            {step === 1 ? 'Continue' : busy ? 'Accepting…' : 'Accept and continue'} <span aria-hidden="true">→</span>
          </button>
        </FormBottom>
      </form>
    </div>,
    document.body,
  );
}
