import { createPortal } from 'react-dom';
import { Banknote, X } from 'lucide-react';
import { useModalFocus } from '../../accessibility/useModalFocus';
import { type PatientOrder } from '../../context/AppContext';
import type { RefundRequestInput } from '../../utils/orderRefundCatalog';
import { OrderRefundComposer } from './OrderRefundComposer';

export function OrderRefundDialog({
  order,
  busy,
  onClose,
  onSubmit,
}: {
  order: PatientOrder;
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: RefundRequestInput) => void | Promise<boolean | void>;
}) {
  const backdropRef = useModalFocus<HTMLDivElement>(true, onClose);
  return createPortal(
    <div
      ref={backdropRef}
      className="order-handout-backdrop"
      role="presentation"
      onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}
    >
      <section className="curaleaf-call-modal order-refund-dialog" role="dialog" aria-modal="true" aria-labelledby="order-refund-title">
        <header className="curaleaf-call-modal__header">
          <div className="curaleaf-call-modal__header-left">
            <span className="curaleaf-call-modal__icon-pill"><Banknote size={20} /></span>
            <div className="curaleaf-call-modal__header-titles">
              <span className="curaleaf-call-modal__eyebrow">Patient refund</span>
              <h2 id="order-refund-title" className="curaleaf-call-modal__title">Refund</h2>
            </div>
          </div>
          <button type="button" className="curaleaf-call-modal__close" onClick={onClose} disabled={busy} aria-label="Close refund">
            <X size={18} />
          </button>
        </header>
        <OrderRefundComposer order={order} busy={busy} onSubmit={onSubmit} />
      </section>
    </div>,
    document.body,
  );
}
