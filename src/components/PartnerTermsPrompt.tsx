import { useCallback, useEffect, useRef, useState } from 'react';
import { FileSignature, X } from 'lucide-react';
import { useAuth } from '../auth/useAuth';
import { PartnerTermsForm } from '../auth/PartnerTermsForm';
import { useApp } from '../context/AppContext';
import { isLocalPortalPreview } from '../dev/localPortalPreview';
import {
  acceptBranchPartnerTerms,
  getBranchOnboarding,
  getPortalSession,
  openPharmacyPartnerTerms,
  recordPartnerTermsViewed,
  skipPartnerTerms,
} from '../shared/api';
import { GoLiveChecklistPrompt } from './GoLiveChecklist';
import { PdfPreview } from './PdfPreview';
import '../styles/partner-terms-prompt.css';

/**
 * At login, when HHH has published a Partner Terms version this branch has not signed:
 * read it, then sign or skip. Anyone at the branch can sign once for it; anyone can
 * skip, which is recorded and comes back at the next login. Closing counts as a skip,
 * so the prompt is never quietly lost. The go-live checklist prompt waits behind it.
 */

const SEEN_KEY = 'hhh_partner_terms_seen';

function loginKey(staff: { uid: string; absoluteExpiresAt?: string | null }, documentId: string) {
  return `${staff.uid}:${staff.absoluteExpiresAt ?? ''}:${documentId}`;
}

function seen(key: string, kind: 'viewed' | 'closed') {
  try {
    return globalThis.sessionStorage?.getItem(`${SEEN_KEY}:${kind}`) === key;
  } catch {
    return false;
  }
}

function remember(key: string, kind: 'viewed' | 'closed') {
  try {
    globalThis.sessionStorage?.setItem(`${SEEN_KEY}:${kind}`, key);
  } catch {
    // Storage blocked: the prompt comes back on refresh, which only asks again.
  }
}

export function LoginPrompts() {
  const { state: authState } = useAuth();
  const { state, dispatch } = useApp();
  const staff = authState.phase === 'authenticated' ? authState.staff : null;
  const pharmacy = staff?.role === 'pharmacy_staff';
  const organisation = state.organisations.find(org => org.id === state.currentOrganisationId) ?? state.organisations[0];
  const [owed, setOwed] = useState<{ documentId: string; version: string } | null | undefined>(undefined);
  const [closed, setClosed] = useState(false);
  const [signing, setSigning] = useState(false);
  const [file, setFile] = useState<{ url: string | null; failed: boolean }>({ url: null, failed: false });
  const [company, setCompany] = useState('');
  const [busy, setBusy] = useState(false);
  const signButton = useRef<HTMLButtonElement>(null);
  const key = staff && owed ? loginKey(staff, owed.documentId) : null;

  useEffect(() => {
    if (!pharmacy || isLocalPortalPreview) { setOwed(null); return; }
    let active = true;
    void getPortalSession()
      .then(session => { if (active) setOwed(session.partnerTerms ?? null); })
      .catch(() => { if (active) setOwed(null); });
    return () => { active = false; };
  }, [pharmacy, staff?.uid]);

  const open = Boolean(pharmacy && owed && key && !closed && !seen(key, 'closed') && !state.demoMode);

  useEffect(() => {
    if (!open || !key) return;
    signButton.current?.focus();
    let active = true;
    void openPharmacyPartnerTerms()
      .then(url => { if (active) setFile({ url, failed: false }); })
      .catch(() => { if (active) setFile({ url: null, failed: true }); });
    void getBranchOnboarding().then(view => { if (active) setCompany(view.registeredCompanyName); }).catch(() => undefined);
    if (!seen(key, 'viewed')) {
      remember(key, 'viewed');
      void recordPartnerTermsViewed().catch(() => undefined);
    }
    return () => { active = false; };
  }, [open, key]);

  const skip = useCallback(async () => {
    if (!key || busy) return;
    setBusy(true);
    remember(key, 'closed');
    setClosed(true);
    try {
      await skipPartnerTerms();
    } catch {
      // The skip is recorded best effort; the prompt still returns next login.
    } finally {
      setBusy(false);
    }
  }, [busy, key]);

  useEffect(() => {
    if (!open || signing) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') void skip(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, signing, skip]);

  // The checklist prompt only once there is no Terms prompt to show.
  if (owed === undefined && pharmacy && !isLocalPortalPreview) return null;
  if (!open || !owed || !organisation) return <GoLiveChecklistPrompt />;

  return (
    <>
      <div className="terms-prompt__scrim" onClick={event => { if (event.target === event.currentTarget && !signing) void skip(); }}>
        <section className="terms-prompt" role="dialog" aria-modal="true" aria-labelledby="terms-prompt-title">
          <header className="terms-prompt__head">
            <span className="terms-prompt__icon" aria-hidden="true"><FileSignature size={20} /></span>
            <div>
              <small>Partner Terms · version {owed.version}</small>
              <h3 id="terms-prompt-title">New Partner Terms to sign for {organisation.name}</h3>
              <p>
                Holistic Health Hub has published version {owed.version} of its Partner Terms. Please read them below.
                The superintendent pharmacist, or someone authorised to sign for the company, can sign them now.
                Not the right person? Skip for now and let them know: you will be asked again at your next login.
              </p>
            </div>
            <button type="button" className="btn btn-sm" aria-label="Skip for now" onClick={() => void skip()} disabled={busy}><X size={14} /></button>
          </header>
          <div className="terms-prompt__pdf">
            {file.url ? <PdfPreview href={file.url} /> : file.failed ? <p className="terms-prompt__note">The Partner Terms could not be opened. Skip for now and try again at your next login.</p> : <p className="terms-prompt__note">Opening the Partner Terms…</p>}
          </div>
          <footer className="terms-prompt__foot">
            {file.url ? <a className="terms-prompt__download" href={file.url} download={`Partner-Terms-${owed.version}.pdf`}>Download PDF</a> : <span />}
            <span className="terms-prompt__actions">
              <button type="button" className="btn btn-sm" onClick={() => void skip()} disabled={busy}>Skip for now</button>
              <button ref={signButton} type="button" className="btn btn-primary btn-sm" onClick={() => setSigning(true)} disabled={busy}>Sign the Partner Terms</button>
            </span>
          </footer>
        </section>
      </div>
      <PartnerTermsForm
        open={signing}
        request={{ id: organisation.id, pharmacyName: organisation.name, registeredCompanyName: company || organisation.tradingName || organisation.name }}
        signer={{ name: staff?.name ?? '', email: staff?.email ?? '' }}
        intro={`Sign version ${owed.version} of the Partner Terms for ${organisation.name}.`}
        termsFile={async () => file.url ?? openPharmacyPartnerTerms()}
        termsVersion={owed.version}
        acceptNote="Accepting signs the Partner Terms for the pharmacy. A signed copy is emailed to you."
        send={input => acceptBranchPartnerTerms(input)}
        onClose={() => setSigning(false)}
        onAccepted={() => {
          setSigning(false);
          if (key) remember(key, 'closed');
          setOwed(null);
          dispatch({ type: 'ADD_TOAST', toastType: 'success', message: `Partner Terms ${owed.version} signed. A signed copy is on its way by email, and on your Onboarding page.` });
        }}
      />
    </>
  );
}
