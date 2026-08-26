import { CheckCircle, Pencil, ShieldCheck, Trash2 } from 'lucide-react';
import type { CRMPatient } from '../../context/AppContext';
import { formatPatientDob } from '../../utils/patientDob';
import type { ReactNode } from 'react';

type Step1PatientPanelProps = {
  patient: CRMPatient | null;
  changingPatient: boolean;
  patientLocked: boolean;
  patientSearch: ReactNode;
  onBeginPatientChange: () => void;
  onRequestDeleteDraft: () => void;
  initials: (name: string) => string;
};

export default function Step1PatientPanel({
  patient,
  changingPatient,
  patientLocked,
  patientSearch,
  onBeginPatientChange,
  onRequestDeleteDraft,
  initials,
}: Step1PatientPanelProps) {
  return (
    <section id="rx-step-1" className={`rx-patient-band rx-builder-context card rx-create-step${changingPatient || !patient ? ' is-changing-patient' : ''}`}>
      <div className="rx-patient-band__identity rx-builder-patient">
        {patient ? (
          changingPatient ? (
            patientSearch
          ) : (
            <>
              <span className="avatar">{initials(patient.name)}</span>
              <span className="rx-patient-identity-copy">
                <p className="section-label">STEP 1</p>
                <p className="section-label rx-patient-approved-label"><CheckCircle size={12} /> Approved patient</p>
                <strong>{patient.name}</strong>
                <span className="rx-patient-meta" aria-label="Patient identity details">
                  <span>DOB {formatPatientDob(patient.dob)}</span>
                  <span>{patient.email}</span>
                  <span>{patient.mobile}</span>
                </span>
              </span>
              <div className="rx-patient-actions">
                {patientLocked
                  ? <span className="rx-redo-patient-lock"><ShieldCheck size={12} /> Locked to redo</span>
                  : <button type="button" className="btn btn-secondary btn-sm" onClick={onBeginPatientChange}><Pencil size={12} /> Change</button>}
                <button type="button" className="icon-button danger" aria-label="Delete this prescription draft" title="Delete draft" onClick={onRequestDeleteDraft}><Trash2 size={14} /></button>
              </div>
            </>
          )
        ) : (
          patientSearch
        )}
      </div>
    </section>
  );
}
