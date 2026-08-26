import { AlertTriangle, CheckCircle, Minus, Plus, Trash2 } from 'lucide-react';
import MedicineLabel from '../../components/MedicineLabel';
import { lineCost, lineMargin, lineRevenue, money, type CRMPatient } from '../../context/AppContext';
import type { WizardProgress, WizardStep } from './types';
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
  /** Null until a current Curaleaf quote supplies wholesale cost, delivery and tax. */
  draftBasketCosts: { wholesale: number; delivery: number; tax: number } | null;
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

function continueLabel(focusedStep: number): string {
  if (focusedStep <= 1) return 'Continue to prescription';
  if (focusedStep === 2) return 'Continue to medicines';
  if (focusedStep === 3) return 'Continue to payment';
  return 'Continue';
}

export default function OrderSummaryRail({
  progress,
  patient,
  focusedStep,
  draftBasketCount,
  draftBasketTotal,
  draftBasketCosts,
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
  const showContinue = focusedStep < 4;

  return (
    <aside className="rx-order-summary-rail" aria-label="Order summary">
      {patient ? (
        <div className="rx-order-summary-rail__patient">
          <p className="section-label">Patient</p>
          <strong>{patient.name}</strong>
        </div>
      ) : null}

      <div className="rx-order-summary-rail__section">
        <p className="section-label">Progress</p>
        <ul className="rx-order-summary-rail__checklist" aria-label="Step progress">
          {([1, 2, 3, 4] as WizardStep[]).map(step => {
            const complete = progress.steps[step].complete;
            const current = focusedStep === step;
            return (
              <li
                key={step}
                className={complete ? 'is-complete' : current ? 'is-current' : ''}
                aria-current={current ? 'step' : undefined}
              >
                {complete
                  ? <CheckCircle size={14} aria-hidden="true" />
                  : <span className="rx-order-summary-rail__dot" aria-hidden="true" />}
                <span>{WIZARD_STEP_LABELS[step]}</span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="rx-order-summary-rail__section rx-order-summary-rail__basket">
        <div className="rx-order-summary-rail__basket-head">
          <p className="section-label">Basket</p>
          {progress.basketUnlocked || progress.basketIsProvisional ? (
            <span className="rx-order-summary-rail__count">
              {draftBasketCount} item{draftBasketCount === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>

        {progress.basketIsProvisional ? (
          <p className="rx-order-summary-rail__provisional" role="status">
            <AlertTriangle size={14} aria-hidden="true" />
            {draftBasketCount} medicine{draftBasketCount === 1 ? '' : 's'} carried forward — awaiting new prescription
          </p>
        ) : !progress.basketUnlocked ? (
          <p className="rx-order-summary-rail__locked">Authenticate the prescription before prices appear here.</p>
        ) : draftBasketCount === 0 ? (
          <p className="rx-order-summary-rail__locked">No medicines added yet.</p>
        ) : (
          <>
            <ul className="rx-order-summary-rail__items">
              {draftBasketItems.map((item, index) => {
                const issue = draftBasketIssues[index];
                return (
                  <li key={`${item.rxId}-${item.productId}`} className={issue ? `is-${issue.tone}` : undefined}>
                    <div className="rx-order-summary-rail__product">
                      <MedicineLabel name={item.name} />
                      <small>
                        {item.qty} pack{item.qty === 1 ? '' : 's'}
                        {issue ? ` · ${issue.label}` : ''}
                      </small>
                    </div>
                    <div className="rx-order-summary-rail__line">
                      <strong>{money(lineRevenue(item))}</strong>
                      <small>
                        {item.cost !== null ? `${money(lineCost(item))} wholesale` : 'Wholesale pending'}
                        {lineMargin(item) !== null ? ` · ${lineMargin(item)}% margin` : ''}
                      </small>
                    </div>
                    {canEditBasketItems && item.rxId === selectedRxId ? (
                      <div className="rx-order-summary-rail__edit">
                        <button type="button" className="icon-button" aria-label={`Reduce packs of ${item.name}`} disabled={item.qty <= 1} onClick={() => onEditQuantity(item.rxId, item.productId, item.qty - 1)}><Minus size={14} /></button>
                        <button type="button" className="icon-button" aria-label={`Add pack of ${item.name}`} disabled={item.qty >= 100} onClick={() => onEditQuantity(item.rxId, item.productId, item.qty + 1)}><Plus size={14} /></button>
                        <button type="button" className="icon-button danger" aria-label={`Remove ${item.name}`} onClick={() => onRemoveItem(item.rxId, item.productId)}><Trash2 size={14} /></button>
                      </div>
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
              <div>
                <dt>Wholesale</dt>
                <dd>{draftBasketCosts ? money(draftBasketCosts.wholesale) : 'Quote pending'}</dd>
              </div>
              <div>
                <dt>Delivery</dt>
                <dd>{draftBasketCosts ? money(draftBasketCosts.delivery) : 'Quote pending'}</dd>
              </div>
              <div>
                <dt>Tax <small>on wholesale</small></dt>
                <dd>{draftBasketCosts ? money(draftBasketCosts.tax) : 'Quote pending'}</dd>
              </div>
              <div>
                <dt>Dispensing</dt>
                <dd>{money(dispensingFee)}</dd>
              </div>
              <div className="is-total">
                <dt>Patient total</dt>
                <dd>{money(draftBasketTotal)}</dd>
              </div>
            </dl>
          </>
        )}
      </div>

      {showContinue ? (
        <button
          type="button"
          className={`btn btn-primary rx-order-summary-rail__continue${continueDisabled ? '' : ' is-ready'}`}
          disabled={continueDisabled}
          onClick={onContinue}
        >
          {continueLabel(focusedStep)}
        </button>
      ) : null}
    </aside>
  );
}
