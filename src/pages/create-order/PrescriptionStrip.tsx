import { useEffect, useRef } from 'react';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import type { Prescription } from '../../context/AppContext';
import { rxHasCopy, rxRouteLabel, rxTabStatus, rxTabStatusLabel } from './rxTabStatus';

type PrescriptionStripProps = {
  prescriptions: Prescription[];
  selectedRxId: number | null;
  canAdd: boolean;
  canRemove: boolean;
  confirmingRemoveRxId: number | null;
  removingBusy?: boolean;
  onSelect: (rxId: number) => void;
  onAdd: () => void;
  onRequestRemove: (rxId: number) => void;
  onConfirmRemove: () => void;
  onCancelRemove: () => void;
};

export default function PrescriptionStrip({
  prescriptions,
  selectedRxId,
  canAdd,
  canRemove,
  confirmingRemoveRxId,
  removingBusy = false,
  onSelect,
  onAdd,
  onRequestRemove,
  onConfirmRemove,
  onCancelRemove,
}: PrescriptionStripProps) {
  const confirmKeepRef = useRef<HTMLButtonElement>(null);
  const confirmingRx = confirmingRemoveRxId == null
    ? null
    : prescriptions.find(rx => rx.id === confirmingRemoveRxId) ?? null;
  const confirmingIndex = confirmingRx
    ? prescriptions.findIndex(rx => rx.id === confirmingRx.id)
    : -1;
  const confirmingLabel = confirmingIndex >= 0 ? `Prescription ${confirmingIndex + 1}` : 'this prescription';

  useEffect(() => {
    if (!confirmingRx) return;
    confirmKeepRef.current?.focus();
    confirmKeepRef.current?.closest('#rx-strip-remove-confirm')?.scrollIntoView({ block: 'nearest' });
  }, [confirmingRx]);

  if (!prescriptions.length) return null;

  return (
    <div className="rx-prescription-strip">
      <div className="rx-prescription-strip__row">
        <div className="rx-prescription-strip__tabs" role="tablist" aria-label="Prescriptions on this order">
          {prescriptions.map((rx, index) => {
            const selected = rx.id === selectedRxId;
            const status = rxTabStatus(rx);
            const label = `Prescription ${index + 1}`;
            const confirming = confirmingRemoveRxId === rx.id;
            return (
              <div
                key={rx.id}
                className={`rx-prescription-strip__item${selected ? ' is-selected' : ''}${status === 'ready' ? ' is-ready' : ''}${confirming ? ' is-confirming' : ''}`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className="rx-prescription-strip__tab"
                  onClick={() => onSelect(rx.id)}
                >
                  <span className="rx-prescription-strip__name">{label}</span>
                  <span className="rx-prescription-strip__meta">
                    {rxRouteLabel(rx)}
                    {' · '}
                    {rxTabStatusLabel(status)}
                  </span>
                </button>
                {canRemove ? (
                  <button
                    type="button"
                    className="icon-button danger rx-prescription-strip__remove"
                    aria-label={`Remove ${label}`}
                    aria-expanded={confirming}
                    aria-controls={confirming ? 'rx-strip-remove-confirm' : undefined}
                    aria-busy={removingBusy && confirming}
                    disabled={removingBusy}
                    onClick={() => onRequestRemove(rx.id)}
                  >
                    <Trash2 size={15} aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
        {canAdd ? (
          <button type="button" className="btn btn-secondary btn-sm rx-prescription-strip__add" onClick={onAdd}>
            <Plus size={14} aria-hidden="true" />
            Add prescription
          </button>
        ) : null}
      </div>
      {confirmingRx && rxHasCopy(confirmingRx) ? (
        <div
          id="rx-strip-remove-confirm"
          className="rx-prescription-cancel-confirm rx-prescription-strip__confirm"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="rx-strip-remove-title"
        >
          <AlertTriangle size={16} aria-hidden="true" />
          <span>
            <strong id="rx-strip-remove-title">Remove {confirmingLabel}?</strong>
            <small>This prescription has an uploaded copy. Removing it deletes the copy from this order and from stored files.</small>
          </span>
          <div>
            <button type="button" className="btn btn-secondary btn-sm" ref={confirmKeepRef} disabled={removingBusy} onClick={onCancelRemove}>
              Keep
            </button>
            <button type="button" className="btn btn-sm btn-danger" disabled={removingBusy} onClick={onConfirmRemove}>
              <Trash2 size={13} aria-hidden="true" />
              {removingBusy ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
