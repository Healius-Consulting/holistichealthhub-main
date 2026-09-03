import { useMemo, useState } from 'react';
import { Banknote } from 'lucide-react';
import { money, type PatientOrder } from '../../context/AppContext';
import { catalogFromPatientOrder, REFUND_PERCENT_OPTIONS, type RefundRequestInput } from '../../utils/orderRefundCatalog';
import { composeRefund, defaultRefundDraft, refundCompositionError, type RefundChargePercent, type RefundDraft } from '../../utils/refundComposition';

function ChargePercentControl({
  label,
  chargedPence,
  percent,
  onChange,
}: {
  label: string;
  chargedPence: number;
  percent: RefundChargePercent;
  onChange: (percent: RefundChargePercent) => void;
}) {
  const refundPence = Math.round((chargedPence * percent) / 100);
  return (
    <div className="order-refund-composer__charge">
      <div className="order-refund-composer__line-copy">
        <strong>{label}</strong>
        <small>Charged {money(chargedPence / 100)} · refund {money(refundPence / 100)}</small>
      </div>
      <div className="order-refund-composer__percents" role="radiogroup" aria-label={`${label} refund percent`}>
        {REFUND_PERCENT_OPTIONS.map(option => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={percent === option}
            className={percent === option ? 'is-selected' : ''}
            onClick={() => onChange(option)}
          >
            {option}%
          </button>
        ))}
      </div>
    </div>
  );
}

export function OrderRefundComposer({
  order,
  busy,
  onSubmit,
}: {
  order: PatientOrder;
  busy: boolean;
  onSubmit: (input: RefundRequestInput) => void;
}) {
  const catalog = useMemo(() => catalogFromPatientOrder(order), [order]);
  const [draft, setDraft] = useState<RefundDraft>(() => defaultRefundDraft(catalog));
  const composition = composeRefund(catalog, draft);
  const error = refundCompositionError(catalog, draft);
  const patch = (next: Partial<RefundDraft>) => setDraft(current => ({ ...current, ...next }));

  const toggleMedicine = (id: string) => {
    patch({
      includedMedicineIds: draft.includedMedicineIds.includes(id)
        ? draft.includedMedicineIds.filter(item => item !== id)
        : [...draft.includedMedicineIds, id],
    });
  };

  return (
    <div className="order-refund-composer">
      <div className="order-refund-composer__modes" role="radiogroup" aria-label="Refund type">
        <button type="button" role="radio" aria-checked={draft.scope === 'full'} className={draft.scope === 'full' ? 'is-selected' : ''} onClick={() => patch({ scope: 'full' })}>
          <strong>Full refund</strong>
          <small>Return every paid item and charge</small>
        </button>
        <button type="button" role="radio" aria-checked={draft.scope === 'partial'} className={draft.scope === 'partial' ? 'is-selected' : ''} onClick={() => patch({ scope: 'partial' })}>
          <strong>Partial refund</strong>
          <small>Choose medicines and a share of pharmacy charges</small>
        </button>
      </div>

      {draft.scope === 'full' ? (
        <ul className="order-refund-composer__breakdown">
          {composition.lines.map(line => (
            <li key={line.key}>
              <span>{line.label}</span>
              <strong>{money(line.amountPence / 100)}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <div className="order-refund-composer__partial">
          <p className="order-refund-composer__section-label" id="order-refund-medicines-label">Medicines</p>
          {catalog.medicines.length ? (
            <ul className="order-refund-composer__medicines" aria-labelledby="order-refund-medicines-label">
              {catalog.medicines.map(item => {
                const checked = draft.includedMedicineIds.includes(item.id);
                return (
                  <li key={item.id}>
                    <label className="order-refund-composer__medicine">
                      <input type="checkbox" checked={checked} onChange={() => toggleMedicine(item.id)} />
                      <span>
                        <strong>{item.label}</strong>
                        <small>{checked ? `Refund ${money(item.amountPence / 100)}` : 'Keep on the original payment'}</small>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="order-refund-composer__empty" role="status">No medicine lines are stored on this order.</p>
          )}
          {catalog.dispensingFeePence > 0 || catalog.deliveryFeePence > 0 ? (
            <p className="order-refund-composer__section-label">Pharmacy charges</p>
          ) : null}
          {catalog.dispensingFeePence > 0 ? (
            <ChargePercentControl
              label="Dispensing charge"
              chargedPence={catalog.dispensingFeePence}
              percent={draft.dispensingPercent}
              onChange={dispensingPercent => patch({ dispensingPercent })}
            />
          ) : null}
          {catalog.deliveryFeePence > 0 ? (
            <ChargePercentControl
              label="Delivery charge"
              chargedPence={catalog.deliveryFeePence}
              percent={draft.deliveryPercent}
              onChange={deliveryPercent => patch({ deliveryPercent })}
            />
          ) : null}
        </div>
      )}

      <div className="order-refund-composer__footer">
        <span>
          <small>{draft.scope === 'full' ? 'Total to refund' : 'Selected refund'}</small>
          <strong>{money(composition.amountPence / 100)}</strong>
        </span>
        {error ? <p className="order-refund-composer__error" role="alert">{error}</p> : null}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busy || Boolean(error)}
          onClick={() => onSubmit({ ...draft, amountPence: composition.amountPence })}
        >
          <Banknote size={13} /> {busy
            ? order.payment.route === 'worldpay' ? 'Sending to Worldpay…' : 'Preparing refund…'
            : draft.scope === 'full' ? 'Refund full payment' : 'Refund selected amount'}
        </button>
      </div>
    </div>
  );
}
