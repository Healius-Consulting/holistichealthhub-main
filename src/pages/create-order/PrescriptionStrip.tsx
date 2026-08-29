import { Plus, Trash2 } from 'lucide-react';
import type { Prescription } from '../../context/AppContext';
import { rxRouteLabel, rxTabStatus, rxTabStatusLabel } from './rxTabStatus';

type PrescriptionStripProps = {
  prescriptions: Prescription[];
  selectedRxId: number | null;
  canAdd: boolean;
  canRemove: boolean;
  confirmingRemove: boolean;
  onSelect: (rxId: number) => void;
  onAdd: () => void;
  onRequestRemove: () => void;
  onConfirmRemove: () => void;
  onCancelRemove: () => void;
};

export default function PrescriptionStrip({
  prescriptions,
  selectedRxId,
  canAdd,
  canRemove,
  confirmingRemove,
  onSelect,
  onAdd,
  onRequestRemove,
  onConfirmRemove,
  onCancelRemove,
}: PrescriptionStripProps) {
  if (!prescriptions.length) return null;

  return (
    <div className="rx-prescription-strip">
      <div className="rx-prescription-strip__tabs" role="tablist" aria-label="Prescriptions on this order">
        {prescriptions.map((rx, index) => {
          const selected = rx.id === selectedRxId;
          const status = rxTabStatus(rx);
          const label = `Prescription ${index + 1}`;
          return (
            <button
              key={rx.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={`rx-prescription-strip__tab${selected ? ' is-selected' : ''}${status === 'ready' ? ' is-ready' : ''}`}
              onClick={() => onSelect(rx.id)}
            >
              <span className="rx-prescription-strip__name">{label}</span>
              <span className="rx-prescription-strip__meta">
                {rxRouteLabel(rx)}
                {' · '}
                {rxTabStatusLabel(status)}
              </span>
            </button>
          );
        })}
      </div>
      <div className="rx-prescription-strip__actions">
        {canAdd ? (
          <button type="button" className="btn btn-secondary btn-sm rx-prescription-strip__add" onClick={onAdd}>
            <Plus size={14} aria-hidden="true" />
            Add prescription
          </button>
        ) : null}
        {canRemove && selectedRxId !== null ? (
          confirmingRemove ? (
            <div className="rx-prescription-strip__confirm" role="group" aria-label="Remove this prescription">
              <span>Remove this prescription from the order?</span>
              <button type="button" className="btn btn-secondary btn-sm" onClick={onCancelRemove}>Keep</button>
              <button type="button" className="btn btn-sm btn-danger" onClick={onConfirmRemove}>
                <Trash2 size={13} aria-hidden="true" />
                Remove
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onRequestRemove}
              aria-label="Remove this prescription"
            >
              <Trash2 size={13} aria-hidden="true" />
              Remove
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}
