import { AlertTriangle, CheckCircle, Minus, Plus, Trash2 } from 'lucide-react';
import MedicineLabel from '../../components/MedicineLabel';
import {
  WHOLESALE_LABEL,
  WHOLESALE_LABEL_SHORT,
  formatMargin,
  lineContribution,
  lineCost,
  lineRevenue,
  marginPercent,
  marginToneClass,
  money,
  type CRMPatient,
} from '../../context/AppContext';
import { CURALEAF_DELIVERY_LABEL, PATIENT_TOTAL_LABEL, PHARMACY_TOTAL_LABEL, WHOLESALE_COST_LABEL } from '../../utils/pricing';
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
  /** Null until a current Curaleaf quote supplies wholesale cost and delivery. */
  draftBasketCosts: { wholesale: number; delivery: number } | null;
  dispensingFee: number;
  pharmacyDelivery: number;
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
  pharmacyDelivery,
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
  // The patient pays for medicines plus optional dispensing and pharmacy delivery;
  // medicine price alone is what staff compare with the wholesale product line.
  const patientPrice = draftBasketTotal - dispensingFee - pharmacyDelivery;
  // Gross margin keeps both optional pharmacy charges, so it is the whole patient
  // total less supplier product and Curaleaf delivery costs.
  const pharmacyTotal = draftBasketCosts ? draftBasketCosts.wholesale + draftBasketCosts.delivery : null;
  const grossMargin = pharmacyTotal == null ? null : draftBasketTotal - pharmacyTotal;

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
                const packLabel = `${item.qty} pack${item.qty === 1 ? '' : 's'}`;
                // When the quantity is editable the pack count belongs next to the
                // −/+ that change it, not stranded opposite the price.
                const editable = canEditBasketItems && item.rxId === selectedRxId;
                return (
                  <li key={`${item.rxId}-${item.productId}`} className={issue ? `is-${issue.tone}` : undefined}>
                    {/* The name gets the full rail width so its marquee frame has room to read. */}
                    <div className="rx-order-summary-rail__product">
                      <MedicineLabel name={item.name} />
                    </div>
                    <div className="rx-order-summary-rail__headline">
                      {editable ? null : <span>{packLabel}</span>}
                      <strong>{money(lineRevenue(item))}</strong>
                    </div>
                    {issue ? (
                      <p className="rx-order-summary-rail__issue">
                        <AlertTriangle size={12} aria-hidden="true" />
                        {issue.label}
                      </p>
                    ) : null}
                    <dl className="rx-order-summary-rail__economics">
                      <div>
                        <dt title={WHOLESALE_LABEL}>{WHOLESALE_LABEL_SHORT}</dt>
                        <dd>{item.cost !== null ? money(lineCost(item)) : 'Pending'}</dd>
                      </div>
                      <div>
                        <dt>Margin</dt>
                        <dd>{formatMargin(lineContribution(item), lineRevenue(item))}</dd>
                      </div>
                    </dl>
                    {editable ? (
                      <div className="rx-order-summary-rail__edit">
                        <button type="button" className="icon-button" aria-label={`Reduce packs of ${item.name}`} disabled={item.qty <= 1} onClick={() => onEditQuantity(item.rxId, item.productId, item.qty - 1)}><Minus size={14} /></button>
                        <button type="button" className="icon-button" aria-label={`Add pack of ${item.name}`} disabled={item.qty >= 100} onClick={() => onEditQuantity(item.rxId, item.productId, item.qty + 1)}><Plus size={14} /></button>
                        {/* Reads out the new count after −/+ without a second live region. */}
                        <span className="rx-order-summary-rail__edit-qty" aria-live="polite">{packLabel}</span>
                        <button type="button" className="icon-button danger rx-order-summary-rail__edit-remove" aria-label={`Remove ${item.name}`} onClick={() => onRemoveItem(item.rxId, item.productId)}><Trash2 size={14} /></button>
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
              <div className="rx-order-summary-rail__totals-heading">
                <dt>Pharmacy Cost</dt>
                <dd />
              </div>
              <div>
                <dt>{WHOLESALE_COST_LABEL}</dt>
                <dd>{draftBasketCosts ? money(draftBasketCosts.wholesale) : 'Quote pending'}</dd>
              </div>
              {draftBasketCosts?.delivery ? <div><dt>{CURALEAF_DELIVERY_LABEL}</dt><dd>{money(draftBasketCosts.delivery)}</dd></div> : null}
              <div className="is-total">
                <dt>{PHARMACY_TOTAL_LABEL}</dt>
                <dd>{pharmacyTotal == null ? 'Quote pending' : money(pharmacyTotal)}</dd>
              </div>
              <div className="rx-order-summary-rail__totals-heading is-ruled">
                <dt>Patient Cost</dt>
                <dd />
              </div>
              <div>
                <dt>Curaleaf PX Cost</dt>
                <dd>{money(patientPrice)}</dd>
              </div>
              {dispensingFee > 0 ? <div><dt>Dispensing Charge</dt><dd>{money(dispensingFee)}</dd></div> : null}
              {pharmacyDelivery > 0 ? <div><dt>Delivery Charge</dt><dd>{money(pharmacyDelivery)}</dd></div> : null}
              <div className="rx-order-summary-rail__margin">
                <dt>Gross Margin</dt>
                <dd className={marginToneClass(marginPercent(grossMargin, draftBasketTotal))}>
                  {formatMargin(grossMargin, draftBasketTotal)}
                </dd>
              </div>
              <div className="is-total">
                <dt>{PATIENT_TOTAL_LABEL}</dt>
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
