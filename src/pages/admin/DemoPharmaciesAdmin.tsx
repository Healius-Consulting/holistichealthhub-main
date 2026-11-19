import { useCallback, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiRequestError, deleteDemoPharmacy, getDemoPharmacies, saveDemoPharmacies, type DemoPharmaciesView } from '../../shared/api';
import { FormBottom, FormIntro, FormTop, Section } from '../../components/OnboardingFormParts';

/**
 * HHH admin: demo pharmacies. GPhC numbers used to walk through onboarding on
 * production. Their Curaleaf email goes to HHH only, a new Curaleaf form from one wipes
 * its previous run automatically, and each can be wiped here at any time.
 */

const day = (iso: string) => new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const message = (error: unknown, fallback: string) => (error instanceof ApiRequestError ? error.message : fallback);

export function DemoPharmaciesAdmin({ open, onClose }: { open: boolean; onClose: () => void }) {
  const titleId = useId();
  const [view, setView] = useState<DemoPharmaciesView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    getDemoPharmacies().then(setView).catch(cause => setError(message(cause, 'The demo pharmacies could not be loaded.')));
  }, []);
  useEffect(() => { if (open) { setError(null); setNotice(null); setConfirming(null); load(); } }, [open, load]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;

  const save = async (gphcNumbers: string[], done: string) => {
    setBusy('save');
    setError(null);
    try {
      setView(await saveDemoPharmacies(gphcNumbers));
      setNotice(done);
    } catch (cause) {
      setError(message(cause, 'The list could not be saved.'));
    } finally {
      setBusy(null);
    }
  };
  const add = () => {
    const gphc = adding.replace(/\s+/g, '');
    if (!/^\d{7}$/.test(gphc)) { setError('A GPhC premises number is 7 digits.'); return; }
    if (view?.gphcNumbers.includes(gphc)) { setAdding(''); return; }
    void save([...(view?.gphcNumbers ?? []), gphc], `${gphc} is now a demo pharmacy.`).then(() => setAdding(''));
  };
  const wipe = async (gphc: string) => {
    setBusy(gphc);
    setError(null);
    try {
      const result = await deleteDemoPharmacy(gphc);
      setView(result);
      const rows = Object.values(result.result.deleted).reduce((sum, count) => sum + count, 0);
      setNotice(rows ? `Deleted ${rows} records for ${gphc}. It can go through onboarding again.` : `Nothing was on the platform for ${gphc}.`);
    } catch (cause) {
      setError(message(cause, 'The demo pharmacy could not be deleted.'));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  return createPortal(
    <div className="onboarding-dialog" role="presentation">
      <button className="onboarding-dialog__backdrop" type="button" aria-label="Close" onClick={onClose} />
      <div className="onboarding-dialog__panel wpa" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <FormTop eyebrow="Admin" title="Demo pharmacies" titleId={titleId} onClose={onClose} closeLabel="Close" />
        <div className="wpa-body">
          <div className="wpa-content">
            <FormIntro title="Show onboarding on production">A demo pharmacy goes through the real journey, but its Curaleaf application goes to HHH only, never to Curaleaf. When it sends a new Curaleaf form, its previous run is deleted first, so you can show the process again.</FormIntro>
            {notice ? <p className="wpa-banner is-green" role="status">{notice}</p> : null}
            {error ? <p className="wpa-alert" role="alert">{error}</p> : null}
            {!view ? <p className="wpa-muted">Loading…</p> : (
              <>
                {view.pharmacies.map(item => (
                  <Section key={item.gphcNumber} title={`GPhC ${item.gphcNumber}`}>
                    <div className="demo-pharmacy">
                      <div className="demo-pharmacy__state">
                        {item.branch ? (
                          <><strong>{item.branch.name}</strong><span>Branch {item.branch.status.toLowerCase().replace(/_/g, ' ')} · created {day(item.branch.createdAt)}</span></>
                        ) : item.request ? (
                          <><strong>{item.request.pharmacyName}</strong><span>Onboarding request {item.request.status.toLowerCase().replace(/_/g, ' ')} · sent {day(item.request.createdAt)}</span></>
                        ) : (
                          <span className="wpa-muted">Not on the platform. Ready to start.</span>
                        )}
                        {item.hasPatientsOrOrders ? <span className="wpa-field__warn">Has patients or orders: delete those before wiping it.</span> : null}
                      </div>
                      <div className="demo-pharmacy__actions">
                        {confirming === item.gphcNumber ? (
                          <>
                            <span className="wpa-field__warn">Delete everything for {item.gphcNumber}? This cannot be undone.</span>
                            <button type="button" className="btn btn-sm" onClick={() => setConfirming(null)} disabled={busy !== null}>Cancel</button>
                            <button type="button" className="btn btn-sm btn-danger" onClick={() => void wipe(item.gphcNumber)} disabled={busy !== null}>{busy === item.gphcNumber ? 'Deleting…' : 'Yes, delete'}</button>
                          </>
                        ) : (
                          <>
                            <button type="button" className="btn btn-sm" onClick={() => setConfirming(item.gphcNumber)} disabled={busy !== null || (!item.branch && !item.request) || item.hasPatientsOrOrders}>Delete now</button>
                            <button type="button" className="wpa-link is-danger" onClick={() => void save(view.gphcNumbers.filter(gphc => gphc !== item.gphcNumber), `${item.gphcNumber} is no longer a demo pharmacy.`)} disabled={busy !== null}>Remove from list</button>
                          </>
                        )}
                      </div>
                    </div>
                  </Section>
                ))}
                <Section title="Add a demo GPhC number" description="Only use numbers that are not real partner pharmacies: everything for a demo number can be deleted.">
                  <span className="wpa-lookup">
                    <input className="input" value={adding} onChange={event => setAdding(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} placeholder="7-digit GPhC premises number" inputMode="numeric" />
                    <button type="button" className="btn" onClick={add} disabled={busy !== null}>Add</button>
                  </span>
                </Section>
              </>
            )}
          </div>
        </div>
        <FormBottom status={<span className="wpa-save">The same delete runs from scripts/delete-demo-pharmacy.</span>}>
          <button type="button" className="btn btn-primary wpa-next" onClick={onClose}>Done</button>
        </FormBottom>
      </div>
    </div>,
    document.body,
  );
}
