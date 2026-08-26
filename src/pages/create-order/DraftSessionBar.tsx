import { Trash2 } from 'lucide-react';
import { orderReference, type CRMPatient, type PatientOrder } from '../../context/AppContext';

type DraftSessionBarProps = {
  draftOrders: PatientOrder[];
  activeOrderId: number | null;
  organisationPatients: CRMPatient[];
  confirmingDraftDeleteId: number | null;
  onSelectDraft: (orderId: number) => void;
  onNewDraft: () => void;
  onRequestDelete: (orderId: number) => void;
  onConfirmDelete: (orderId: number) => void;
  onCancelDelete: () => void;
  initials: (name: string) => string;
};

export default function DraftSessionBar({
  draftOrders,
  activeOrderId,
  organisationPatients,
  confirmingDraftDeleteId,
  onSelectDraft,
  onNewDraft,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
  initials,
}: DraftSessionBarProps) {
  const confirmingDraft = confirmingDraftDeleteId === null
    ? null
    : draftOrders.find(order => order.id === confirmingDraftDeleteId) ?? null;
  const confirmingDraftPatient = confirmingDraft?.patientId
    ? organisationPatients.find(candidate => candidate.id === confirmingDraft.patientId)
    : null;
  const confirmingDraftLabel = confirmingDraftPatient?.name ?? (confirmingDraft ? `Unlinked draft #${confirmingDraft.id}` : 'this draft');

  return (
    <>
      <section className="rx-draft-bar card" aria-label="Prescription draft sessions">
        <div className="rx-draft-bar__title">
          <p className="section-label">Draft sessions</p>
          <strong>{draftOrders.length} open</strong>
        </div>
        <div className="rx-draft-tabs" role="tablist" aria-label="Open prescription drafts">
          {draftOrders.map(order => {
            const draftPatient = order.patientId ? organisationPatients.find(candidate => candidate.id === order.patientId) : null;
            const active = order.id === activeOrderId;
            return (
              <div className={`rx-draft-tab-wrap${active ? ' active' : ''}`} key={order.id}>
                <button type="button" role="tab" aria-selected={active} className="rx-draft-tab" onClick={() => onSelectDraft(order.id)}>
                  <span className="rx-draft-tab__avatar">{draftPatient ? initials(draftPatient.name) : '—'}</span>
                  <span>
                    <strong>{draftPatient?.name ?? `Unlinked draft #${order.id}`}</strong>
                    <small>{order.prescriptions.length} Rx{order.prescriptions.length === 1 ? '' : 's'}{order.redoContext ? ` · ${orderReference(order)}` : ''}</small>
                  </span>
                </button>
                <button type="button" className="rx-draft-tab-delete" aria-label={`Delete ${draftPatient?.name ?? `unlinked draft ${order.id}`}`} onClick={() => onRequestDelete(order.id)}><Trash2 size={13} /></button>
              </div>
            );
          })}
        </div>
        <button type="button" className="btn btn-primary rx-new-draft" onClick={onNewDraft}>
          + New patient order
        </button>
      </section>

      {confirmingDraft ? (
        <section className="rx-draft-delete-confirm card" role="alertdialog" aria-modal="true" aria-label={`Delete ${confirmingDraftLabel}`}>
          <span><Trash2 size={16} /><span><strong>Delete {confirmingDraftLabel}?</strong><small>This removes every unfinished prescription record in this draft. This cannot be undone.</small></span></span>
          <div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onCancelDelete}>Keep draft</button>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => onConfirmDelete(confirmingDraft.id)}>Delete draft</button>
          </div>
        </section>
      ) : null}
    </>
  );
}
