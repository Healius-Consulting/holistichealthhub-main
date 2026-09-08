import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Banknote, CheckCircle2, Clock, X } from 'lucide-react';
import { money, useApp, type PatientOrder, type Prescription } from '../../context/AppContext';
import { useModalFocus } from '../../accessibility/useModalFocus';
import { ApiRequestError, getPrescriptionRefundPreview, createPrescriptionRefund, confirmPrescriptionRefund } from '../../shared/api';
import type { PrescriptionRefundPreview, PrescriptionRefundRequest } from '../../shared/contracts';
import { prescriptionReference } from '../../utils/orderReference';

const REFUND_PERCENT_OPTIONS = [0, 25, 50, 75, 100] as const;

const refundIsSettled = (status: string) => status.toLowerCase() === 'completed';

function refundStatusLabel(status: string) {
  switch (status.toLowerCase()) {
    case 'completed': return 'Refund completed';
    case 'verifying': case 'verification_pending': return 'Awaiting provider confirmation';
    case 'reconciliation_required': return 'Needs reconciliation';
    default: return 'Awaiting confirmation';
  }
}

export function PrescriptionRefundPanel({ order, prescription, index, onReplace, canReplace }: {
  order: PatientOrder;
  prescription: Prescription;
  index: number;
  onReplace: () => void;
  canReplace: boolean;
}) {
  const [open, setOpen] = useState(false);
  const refunds = order.prescriptionRefunds ?? [];
  const mine = refunds.filter(row => row.prescriptionId === prescription.backendId);
  const unresolved = refunds.some(row => !refundIsSettled(row.status));
  const label = `Rx${index + 1}`;
  return (
    <section className="order-resolution">
      <header>
        <span>
          <small>Prescription resolution</small>
          <strong>Choose replacement or refund</strong>
        </span>
      </header>
      <div className="order-resolution__choices">
        {canReplace && !mine.length && !unresolved ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={onReplace}>Replace using paid balance</button>
        ) : null}
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>
          <Banknote size={13} /> {mine.length ? `Refund history · ${label}` : `Refund ${label}`}
        </button>
        <small>
          Only {label}’s cancelled, unfulfilled medicines are refunded. Shared dispensing and delivery charges are
          retained unless you choose to refund a share.
        </small>
      </div>
      {mine.map(row => (
        <div key={row.id} className={`order-resolution__completed${refundIsSettled(row.status) ? '' : ' order-resolution__completed--pending'}`}>
          {refundIsSettled(row.status) ? <CheckCircle2 size={16} /> : <Clock size={16} />}
          <span>
            <strong>{money(row.amountPence / 100)} · {refundStatusLabel(row.status)}</strong>
            <small>{row.externalReference ? `Reference ${row.externalReference}` : `Reserved against this order’s payment for ${label}`}</small>
          </span>
        </div>
      ))}
      {open ? (
        <PrescriptionRefundDialog order={order} prescription={prescription} index={index} onClose={() => setOpen(false)} />
      ) : null}
    </section>
  );
}

function ChargeControl({ label, charge, percent, disabled, onChange }: {
  label: string;
  charge: { originalPence: number; remainingPence: number };
  percent: number;
  disabled: boolean;
  onChange: (percent: number) => void;
}) {
  return (
    <div className="order-refund-composer__charge">
      <div className="order-refund-composer__line-copy">
        <strong>{label}</strong>
        <small>
          Charged {money(charge.originalPence / 100)} · {money(charge.remainingPence / 100)} still refundable ·
          {' '}refund {money(Math.round((charge.originalPence * percent) / 100) / 100)}
        </small>
      </div>
      <div className="order-refund-composer__percents" role="radiogroup" aria-label={`${label} refund percent`}>
        {REFUND_PERCENT_OPTIONS.map(option => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={percent === option}
            className={percent === option ? 'is-selected' : ''}
            disabled={disabled || Math.round((charge.originalPence * option) / 100) > charge.remainingPence}
            onClick={() => onChange(option)}
          >
            {option}%
          </button>
        ))}
      </div>
    </div>
  );
}

export function PrescriptionRefundDialog({ order, prescription, index, onClose }: {
  order: PatientOrder;
  prescription: Prescription;
  index: number;
  onClose: () => void;
}) {
  const { dispatch } = useApp();
  const [preview, setPreview] = useState<PrescriptionRefundPreview | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [dispensing, setDispensing] = useState(0);
  const [delivery, setDelivery] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pendingRequest, setPendingRequest] = useState<PrescriptionRefundRequest | null>(null);
  const [references, setReferences] = useState<Record<string, string>>({});
  const [refresh, setRefresh] = useState(0);
  const backdropRef = useModalFocus<HTMLDivElement>(true, () => { if (!busy) onClose(); });
  const orderId = order.backendId!;
  const prescriptionId = prescription.backendId!;
  const label = `Rx${index + 1}`;

  useEffect(() => {
    let current = true;
    setLoading(true);
    getPrescriptionRefundPreview(orderId, prescriptionId)
      .then(value => {
        if (!current) return;
        setPreview(value);
        setQuantities(Object.fromEntries(value.medicines.map(line => [line.orderLineId, line.quantity])));
        setDispensing(0);
        setDelivery(0);
      })
      .catch(err => { if (current) setError(err instanceof Error ? err.message : 'Could not load the refund breakdown.'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [orderId, prescriptionId, refresh]);

  const reserved = Boolean(preview?.pendingRefundId);
  const locked = busy || reserved || Boolean(pendingRequest);
  const total = preview
    ? preview.medicines.reduce((sum, line) => sum + (quantities[line.orderLineId] || 0) * line.unitPricePence, 0)
      + Math.round((preview.dispensing.originalPence * dispensing) / 100)
      + Math.round((preview.delivery.originalPence * delivery) / 100)
    : 0;

  async function submit() {
    if (!preview || busy) return;
    const input: PrescriptionRefundRequest = pendingRequest ?? {
      requestId: crypto.randomUUID(),
      previewVersion: preview.previewVersion,
      medicines: preview.medicines
        .filter(line => (quantities[line.orderLineId] || 0) > 0)
        .map(line => ({ orderLineId: line.orderLineId, quantity: quantities[line.orderLineId]! })),
      dispensingPercent: dispensing,
      deliveryPercent: delivery,
    };
    // The same request id is reused on retry, so a repeat never becomes a second refund.
    setPendingRequest(input);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const refund = await createPrescriptionRefund(orderId, prescriptionId, input);
      dispatch({ type: 'SET_ORDER_REFUND', orderId: order.id, refund });
      setPendingRequest(null);
      setNotice(`${money(refund.amountPence / 100)} reserved against this payment for ${label}.`);
      setRefresh(value => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit the refund.');
      if (err instanceof ApiRequestError && err.status === 409) {
        // The balance moved underneath this preview. Start again from the refreshed one.
        setPendingRequest(null);
        setRefresh(value => value + 1);
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirm(id: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const refund = await confirmPrescriptionRefund(orderId, prescriptionId, id, (references[id] || '').trim());
      dispatch({ type: 'SET_ORDER_REFUND', orderId: order.id, refund });
      setNotice('The refund is confirmed and the remaining balance is updated.');
      setRefresh(value => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not confirm the refund.');
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      ref={backdropRef}
      className="order-handout-backdrop"
      role="presentation"
      onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}
    >
      <section className="curaleaf-call-modal order-refund-dialog" role="dialog" aria-modal="true" aria-labelledby="prescription-refund-title">
        <header className="curaleaf-call-modal__header">
          <div className="curaleaf-call-modal__header-left">
            <span className="curaleaf-call-modal__icon-pill"><Banknote size={20} /></span>
            <div className="curaleaf-call-modal__header-titles">
              <span className="curaleaf-call-modal__eyebrow">Prescription refund</span>
              <h2 id="prescription-refund-title" className="curaleaf-call-modal__title">
                Refund {prescriptionReference(order, index)}
              </h2>
            </div>
          </div>
          <button type="button" className="curaleaf-call-modal__close" aria-label="Close refund" disabled={busy} onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="order-refund-composer">
          {error ? <p className="order-refund-composer__error" role="alert">{error}</p> : null}
          {notice ? <p className="order-refund-composer__empty" role="status">{notice}</p> : null}

          {loading ? (
            <p className="order-refund-composer__empty" role="status">Loading refundable medicines and charges…</p>
          ) : !preview ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRefresh(value => value + 1)}>Retry</button>
          ) : (
            <>
              <dl className="order-refund-balance">
                <div><dt>Balance available</dt><dd>{money(preview.availablePence / 100)}</dd></div>
                <div><dt>Already refunded</dt><dd>{money(preview.completedPence / 100)}</dd></div>
                <div><dt>Reserved</dt><dd>{money(preview.reservedPence / 100)}</dd></div>
              </dl>

              {reserved ? (
                <p className="order-refund-composer__empty" role="status">
                  A refund on this payment is awaiting confirmation. Its amount stays reserved and cannot be resubmitted
                  as a new refund — confirm or reconcile it below first.
                </p>
              ) : null}

              <p className="order-refund-composer__section-label" id="prescription-refund-medicines">
                {label} · cancelled, unfulfilled medicines
              </p>
              {preview.medicines.length ? (
                <ul className="order-refund-composer__medicines" aria-labelledby="prescription-refund-medicines">
                  {preview.medicines.map(line => (
                    <li key={line.orderLineId}>
                      <label className="order-refund-composer__medicine order-refund-composer__medicine--quantity">
                        <span>
                          <strong>{line.label}</strong>
                          <small>{money(line.unitPricePence / 100)} per pack · {line.quantity} refundable</small>
                        </span>
                        <input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          max={line.quantity}
                          step={1}
                          disabled={locked || line.quantity === 0}
                          aria-label={`Refund quantity for ${line.label}`}
                          value={quantities[line.orderLineId] ?? 0}
                          onChange={event => setQuantities(values => ({
                            ...values,
                            [line.orderLineId]: Math.max(0, Math.min(line.quantity, Math.trunc(Number(event.target.value) || 0))),
                          }))}
                        />
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="order-refund-composer__empty" role="status">No medicine on {label} is still refundable.</p>
              )}

              <p className="order-refund-composer__section-label">Shared pharmacy charges</p>
              <ChargeControl label="Dispensing charge" charge={preview.dispensing} percent={dispensing} disabled={locked} onChange={setDispensing} />
              <ChargeControl label="Delivery charge" charge={preview.delivery} percent={delivery} disabled={locked} onChange={setDelivery} />

              {total > preview.availablePence ? (
                <p className="order-refund-composer__error" role="alert">
                  This selection is {money((total - preview.availablePence) / 100)} more than the {money(preview.availablePence / 100)}
                  {' '}still available on the payment. Reduce a quantity or a charge share before refunding.
                </p>
              ) : null}

              <div className="order-refund-composer__footer">
                <span>
                  <small>Refund total</small>
                  <strong>{money(total / 100)}</strong>
                </span>
                <span>
                  <small>Balance after refund</small>
                  <strong>{money(Math.max(0, preview.availablePence - total) / 100)}</strong>
                </span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy || reserved || total <= 0 || total > preview.availablePence}
                  onClick={() => void submit()}
                >
                  {busy ? 'Saving…' : pendingRequest ? 'Retry the same refund request' : `Refund ${label}`}
                </button>
              </div>
              <p className="order-refund-composer__empty">
                {order.payment.route === 'worldpay'
                  ? 'Confirming requests a Worldpay refund. An uncertain response stays reserved until it is verified.'
                  : 'This creates an ePOS refund task. Complete the refund in ePOS, then record its reference below.'}
              </p>

              <p className="order-refund-composer__section-label">Refund history for this payment</p>
              {preview.history.length === 0 ? (
                <p className="order-refund-composer__empty">No refunds recorded against this payment.</p>
              ) : (
                <ul className="order-refund-history">
                  {preview.history.map(row => {
                    const isThisPrescription = row.prescriptionId === prescriptionId;
                    const settled = refundIsSettled(row.status);
                    return (
                      <li key={row.id}>
                        <div className="order-refund-history__head">
                          <strong>{isThisPrescription ? label : 'Another prescription'}</strong>
                          <span>{money(row.amountPence / 100)}</span>
                          <small>{refundStatusLabel(row.status)}</small>
                        </div>
                        <ul className="order-refund-history__lines">
                          {row.breakdown.medicines.map(line => (
                            <li key={line.orderLineId}>{line.label} × {line.quantity} · {money(line.amountPence / 100)}</li>
                          ))}
                          <li>
                            Dispensing {money(row.breakdown.dispensingFeePence / 100)} · delivery {money(row.breakdown.deliveryFeePence / 100)}
                          </li>
                        </ul>
                        {isThisPrescription && !settled ? (
                          <div className="order-refund-history__confirm">
                            <label>
                              Refund reference
                              <input
                                value={references[row.id] || ''}
                                disabled={busy}
                                onChange={event => setReferences(values => ({ ...values, [row.id]: event.target.value }))}
                              />
                            </label>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              disabled={busy || (references[row.id] || '').trim().length < 3}
                              onClick={() => void confirm(row.id)}
                            >
                              Verify completed refund
                            </button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}

              <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setRefresh(value => value + 1)}>
                Refresh refund status
              </button>
            </>
          )}
        </div>
      </section>
    </div>,
    document.body,
  );
}
