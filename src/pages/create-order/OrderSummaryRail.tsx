import { AlertTriangle, CheckCircle, ChevronDown, ChevronUp, Minus, Plus, Trash2 } from 'lucide-react';
import MedicineLabel from '../../components/MedicineLabel';
import { lineCost, lineMargin, lineRevenue, money, type CRMPatient } from '../../context/AppContext';
import type { WizardProgress } from './types';
import { WIZARD_STEP_LABELS } from './types';

type BasketItem = {
  rxId: number;
  productId: string;
  name: string;
  qty: number;
  retail: number;
  cost: number | null;
};

type OrderSummaryRailProps = {
  progress: WizardProgress;
  patient: CRMPatient | null;
  focusedStep: number;
  draftBasketCount: number;
  draftBasketTotal: number;
  draftBasketWholesalePlusDelivery: number | null;
  dispensingFee: number;
  draftBasketItems: BasketItem[];
  draftBasketIssues: Array<{ tone: 'blocked' | 'warning'; label: string } | null>;
  draftBasketBlockedCount: number;
  canEditBasketItems: boolean;
  selectedRxId: number | null;
  onContinue: () => void;
  continueDisabled: boolean;
  onEditQuantity: (rxId: number, productId: string, qty: number) => void;
  onRemoveItem: (rxId: number, productId: string) => void;
};

export default function OrderSummaryRail({
  progress,
  patient,
  focusedStep,
  draftBasketCount,
  draftBasketTotal,
  draftBasketWholesalePlusDelivery,
  dispensingFee,
  draftBasketItems,
  draftBasketIssues,
  draftBasketBlockedCount,
  canEditBasketItems,
  selectedRxId,
  onContinue,
  continueDisabled,
  onEditQuantity,
  onRemoveItem,
}: OrderSummaryRailProps) {
  return (
    <aside className="rx-order-summary-rail" aria-label="Order summary">
      {patient ? (
        <div className="rx-order-summary-rail__patient">
          <p className="section-label">Patient</p>
          <strong>{patient.name}</strong>
        </div>
      ) : null}
      <ul className="rx-order-summary-rail__checklist" aria-label="Step progress">
        {([1, 2, 3, 4] as const).map(step => (
          <li key={step} className={progress.steps[step].complete ? 'is-complete' : focusedStep === step ? 'is-current' : ''}>
            {progress.steps[step].complete ? <CheckCircle size={13} aria-hidden="true" /> : <span className="rx-order-summary-rail__dot" aria-hidden="true" />}
            <span>{WIZARD_STEP_LABELS[step]}</span>
          </li>
        ))}
      </ul>
      <div className="rx-order-summary-rail__basket">
        <p className="section-label">Basket</p>
        {progress.basketIsProvisional ? (
          <p className="rx-order-summary-rail__provisional" role="status">
            <AlertTriangle size={14} aria-hidden="true" />
            {draftBasketCount} medicine{draftBasketCount === 1 ? '' : 's'} carried forward — awaiting new prescription
          </p>
        ) : !progress.basketUnlocked ? (
          <p className="rx-order-summary-rail__locked">Authenticate the prescription before prices appear here.</p>
        ) : (
          <>
            <ul className="rx-order-summary-rail__items">
              {draftBasketItems.map((item, index) => {
                const issue = draftBasketIssues[index];
                return (
                  <li key={`${item.rxId}-${item.productId}`}>
                    <MedicineLabel name={item.name} />
                    <small>{item.qty} pack{item.qty === 1 ? '' : 's'}{issue ? ` · ${issue.label}` : ''}</small>
                    <strong>{money(lineRevenue(item))}</strong>
                    {canEditBasketItems && item.rxId === selectedRxId ? (
                      <span className="rx-order-summary-rail__edit">
                        <button type="button" className="icon-button" aria-label={`Reduce packs of ${item.name}`} disabled={item.qty <= 1} onClick={() => onEditQuantity(item.rxId, item.productId, item.qty - 1)}><Minus size={14} /></button>
                        <button type="button" className="icon-button" aria-label={`Add pack of ${item.name}`} disabled={item.qty >= 100} onClick={() => onEditQuantity(item.rxId, item.productId, item.qty + 1)}><Plus size={14} /></button>
                        <button type="button" className="icon-button danger" aria-label={`Remove ${item.name}`} onClick={() => onRemoveItem(item.rxId, item.productId)}><Trash2 size={14} /></button>
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {draftBasketBlockedCount ? (
              <p className="rx-order-summary-rail__alert" role="status">
                <AlertTriangle size={14} aria-hidden="true" />
                {draftBasketBlockedCount} medicine{draftBasketBlockedCount === 1 ? ' is' : 's are'} unavailable.
              </p>
            ) : null}
            <dl className="rx-order-summary-rail__totals">
              <div><dt>Wholesale + delivery</dt><dd>{draftBasketWholesalePlusDelivery !== null ? money(draftBasketWholesalePlusDelivery) : 'Quote pending'}</dd></div>
              <div><dt>Dispensing</dt><dd>{money(dispensingFee)}</dd></div>
              <div><dt>Patient total</dt><dd>{money(draftBasketTotal)}</dd></div>
            </dl>
          </>
        )}
      </div>
      <button type="button" className="btn btn-primary rx-order-summary-rail__continue" disabled={continueDisabled} onClick={onContinue}>
        Continue
      </button>
    </aside>
  );
}
