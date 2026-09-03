import { RefreshCw } from 'lucide-react';
import { orderReference, type PatientOrder, type UnresolvedOrderReason } from '../../context/AppContext';

type UnresolvedEntry = {
  order: PatientOrder;
  reason: UnresolvedOrderReason;
  itemCount: number;
};

type UnresolvedOrdersPanelProps = {
  entries: UnresolvedEntry[];
  selectedOrderId: number | null;
  onSelect: (orderId: number) => void;
  onApply: (orderId: number) => void;
};

export default function UnresolvedOrdersPanel({
  entries,
  selectedOrderId,
  onSelect,
  onApply,
}: UnresolvedOrdersPanelProps) {
  return (
    <details className="rx-unresolved-panel rx-unresolved-drawer card" aria-label="Unresolved archived and rejected orders">
      <summary className="rx-unresolved-panel__header">
        <span>
          <p className="section-label">Unresolved for this patient</p>
          <strong>{entries.length} archived / rejected order{entries.length === 1 ? '' : 's'}</strong>
          <small>Open to repair a previous order. A serial still inside 24 days is carried forward.</small>
        </span>
        <span className="pill pill-neutral">Review</span>
      </summary>
      <div className="rx-unresolved-drawer__body">
        <p>Select one to load its medicines into this draft. The serial and issue date are copied when they are still inside 24 days of issue. A new scan is needed only if the stored copy is gone.</p>
        <div className="rx-unresolved-list" role="listbox" aria-label="Unresolved orders">
          {entries.map(entry => {
            const selected = selectedOrderId === entry.order.id;
            const itemNames = entry.order.prescriptions.flatMap(rx => rx.items.map(item => item.name));
            return (
              <button
                type="button"
                role="option"
                aria-selected={selected}
                key={entry.order.id}
                className={`rx-unresolved-item${selected ? ' is-selected' : ''}`}
                onClick={() => onSelect(entry.order.id)}
              >
                <span className="rx-unresolved-item__meta">
                  <strong>Order {orderReference(entry.order)}</strong>
                  <small>
                    {entry.reason === 'rejected' ? 'Curaleaf rejected' : '28-day archived'}
                    {' · '}
                    {new Date(entry.order.date).toLocaleDateString('en-GB')}
                    {' · '}
                    {entry.order.payment.status === 'paid' ? 'Paid' : entry.order.payment.status}
                  </small>
                </span>
                <span className="rx-unresolved-item__items">
                  {entry.itemCount} item{entry.itemCount === 1 ? '' : 's'}
                  {itemNames.length ? ` · ${itemNames.slice(0, 2).join(', ')}${itemNames.length > 2 ? '…' : ''}` : ''}
                </span>
                <span className={`pill ${entry.reason === 'rejected' ? 'pill-red' : 'pill-neutral'}`}>{entry.reason === 'rejected' ? 'Rejected' : 'Archived'}</span>
              </button>
            );
          })}
        </div>
        <footer className="rx-unresolved-panel__actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!selectedOrderId}
            onClick={() => selectedOrderId && onApply(selectedOrderId)}
          >
            <RefreshCw size={14} />
            Use this draft as replacement
          </button>
        </footer>
      </div>
    </details>
  );
}
