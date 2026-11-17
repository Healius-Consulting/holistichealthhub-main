import { useState, type FormEvent } from 'react';
import { describeApiError, type AdminPatientDetails } from '../../shared/api';
import { isLocalPortalPreview } from '../../dev/localPortalPreview';

/**
 * HHH correcting a patient's own details inside the Contact card. The server
 * applies the same rules as the public form (adult, valid email and UK postcode)
 * and moves the duplicate check with the email and date of birth.
 */
export function PatientDetailsForm({ save, initial, onCancel, onSaved, note }: {
  /** Sends the edit to the server and returns the saved, normalised values. */
  save: (details: AdminPatientDetails) => Promise<AdminPatientDetails & { changed: string[] }>;
  initial: AdminPatientDetails;
  note?: string;
  onCancel: () => void;
  onSaved: (saved: AdminPatientDetails, changed: string[]) => void;
}) {
  const [draft, setDraft] = useState<AdminPatientDetails>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (field: keyof AdminPatientDetails) => (value: string) => setDraft(current => ({ ...current, [field]: value }));
  const dirty = (Object.keys(initial) as Array<keyof AdminPatientDetails>).some(field => draft[field].trim() !== initial[field].trim());

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty) { onCancel(); return; }
    setBusy(true);
    setError(null);
    try {
      if (isLocalPortalPreview) {
        const saved = { ...draft, email: draft.email.trim().toLowerCase(), postcode: draft.postcode.trim().toUpperCase() };
        const changed = (Object.keys(initial) as Array<keyof AdminPatientDetails>).filter(field => saved[field].trim() !== initial[field].trim());
        onSaved(saved, changed);
        return;
      }
      const result = await save(draft);
      onSaved({ firstName: result.firstName, surname: result.surname, dob: result.dob, email: result.email, mobile: result.mobile, postcode: result.postcode }, result.changed);
    } catch (cause) {
      setError(describeApiError(cause, 'The patient details could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  const field = (key: keyof AdminPatientDetails, label: string, props: { type?: string; autoComplete?: string; inputMode?: 'email' | 'tel' | 'text' } = {}) => (
    <label>
      {label}
      <input
        className="input"
        type={props.type ?? 'text'}
        value={draft[key]}
        onChange={event => set(key)(event.target.value)}
        autoComplete={props.autoComplete ?? 'off'}
        inputMode={props.inputMode}
        required
        disabled={busy}
      />
    </label>
  );

  return (
    <form className="admin-intake-form admin-patient-edit" onSubmit={event => void submit(event)} noValidate>
      <div className="admin-patient-edit__grid">
        {field('firstName', 'First name')}
        {field('surname', 'Surname')}
        {field('dob', 'Date of birth', { type: 'date' })}
        {field('postcode', 'Postcode')}
        {field('email', 'Email', { type: 'email', inputMode: 'email' })}
        {field('mobile', 'Mobile', { type: 'tel', inputMode: 'tel' })}
      </div>
      <p className="admin-intake-note">{note ?? 'Changes show for the pharmacy straight away. Curaleaf keeps its own copy, so update it there too if the clinic needs it.'}</p>
      {error ? <p className="admin-activation__error" role="alert">{error}</p> : null}
      <div className="admin-intake-actions">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save details'}</button>
      </div>
    </form>
  );
}
