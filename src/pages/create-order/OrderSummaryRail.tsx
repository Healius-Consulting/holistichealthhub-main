import { AlertTriangle, Banknote, FilePenLine, Minus, Pill, Plus, Trash2, User } from 'lucide-react';
import MedicineLabel from '../../components/MedicineLabel';
import {
  WHOLESALE_LABEL,
  WHOLESALE_LABEL_SHORT,
  lineContribution,
  lineCost,
  lineRevenue,
  marginPercent,
  money,
  type CRMPatient,
} from '../../context/AppContext';
import { basketMarginTone, formatGlanceMargin, linePriceError, nudgePatientPricePence } from '../../utils/commercial';
import { PATIENT_TOTAL_LABEL, WHOLESALE_COST_LABEL } from '../../utils/pricing';
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
  quotedPatientTotals: { medicine: number; discount: number; total: number } | null;
  pricesLocked: boolean;
  rrpFor: (productId: string) => number | null;
  onSetLinePrice: (rxId: number, productId: string, retail: number) => void;
  /** Null until a current Curaleaf quote supplies wholesale cost and delivery. */
  draftBasketCosts: { wholesale: number; delivery: number } | null;
  pharmacyDelivery: number;
  draftBasketItems: BasketItem[];
  draftBasketIssues: Array<{ tone: 'blocked' | 'warning'; label: string } | null>;
  draftBasketBlockedCount: number;
  canEditBasketItems: boolean;
  selectedRxId: number | null;
  prescriptions: Array<{ id: number; entryMode: 'clinic' | 'manual' }>;
  onStepClick: (step: WizardStep) => void;
  onContinue: () => void;
  continueDisabled: boolean;
  onEditQuantity: (rxId: number, productId: string, qty: number) => void;
  onRemoveItem: (rxId: number, productId: string) => void;
};

const STEP_ICONS = {
  1: User,
  2: FilePenLine,
  3: Pill,
  4: Banknote,
} as const;

const PRICE_NUDGE_POUNDS = [-10, -5, -1, 1, 5, 10] as const;

function nudgedPatientPrice(retail: number, deltaPounds: number, rrp: number, wholesale: number | null) {
  const currentPence = Math.round(retail * 100);
  const rrpPence = Math.round(rrp * 100);
  const wholesalePence = wholesale == null ? 0 : Math.round(wholesale * 100);
  const nextPence = nudgePatientPricePence(currentPence, deltaPounds, rrpPence, wholesalePence);
  return {
    pounds: nextPence / 100,
    reason: nextPence === currentPence ? linePriceError(currentPence + deltaPounds * 100, rrpPence, wholesalePence) : null,
  };
}

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
  quotedPatientTotals,
  draftBasketCosts,
  pricesLocked,
  rrpFor,
  pharmacyDelivery,
  draftBasketItems,
  draftBasketIssues,
  draftBasketBlockedCount,
  canEditBasketItems,
  selectedRxId,
  prescriptions,
  onStepClick,
  onContinue,
  continueDisabled,
  onEditQuantity,
  onRemoveItem,
  onSetLinePrice,
}: OrderSummaryRailProps) {
  const showContinue = focusedStep < 4;
  const pendingQuote = 'Quote pending';
  const patientPrice = quotedPatientTotals?.medicine ?? null;
  const discount = quotedPatientTotals?.discount ?? 0;
  const patientTotal = quotedPatientTotals?.total ?? null;
  const medicineAfterDiscount = patientPrice == null ? null : patientPrice - discount;
  const grossMargin = draftBasketCosts == null || medicineAfterDiscount == null ? null : medicineAfterDiscount - draftBasketCosts.wholesale;

  return (
    <aside className="rx-order-summary-rail" aria-label="Order summary">
      {patient ? (
        <div className="rx-order-summary-rail__patient">
          <p className="section-label">Patient</p>
          <strong>{patient.name}</strong>
        </div>
      ) : null}

      <nav className="rx-order-summary-rail__steps" aria-label="Create order progress">
        {([1, 2, 3, 4] as WizardStep[]).map(step => {
          const complete = progress.steps[step].complete;
          const current = focusedStep === step;
          const unlocked = step <= progress.furthestUnlocked;
          const locked = !unlocked && !complete;
          const label = WIZARD_STEP_LABELS[step];
          const Icon = STEP_ICONS[step];
          return (
            <button
              key={step}
              type="button"
              className={`rx-order-summary-rail__step${complete ? ' is-complete' : ''}${current ? ' is-current' : ''}${locked ? ' is-locked' : ''}`}
              data-label={label}
              aria-label={label}
              aria-current={current ? 'step' : undefined}
              aria-disabled={locked}
              disabled={locked}
              onClick={() => onStepClick(step)}
            >
              <Icon size={16} aria-hidden="true" />
              <span className="rx-order-summary-rail__step-name">{label}</span>
            </button>
          );
        })}
      </nav>

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
              {(prescriptions.length > 1 ? prescriptions : [{ id: selectedRxId ?? -1, entryMode: 'clinic' as const }]).flatMap((rx, rxIndex) => {
                const grouped = draftBasketItems
                  .map((item, index) => ({ item, index }))
                  .filter(entry => prescriptions.length > 1 ? entry.item.rxId === rx.id : true);
                if (!grouped.length) return [];
                const heading = prescriptions.length > 1 ? (
                  <li key={`rx-head-${rx.id}`} className="rx-order-summary-rail__rx-head">
                    {`Prescription ${rxIndex + 1} · ${rx.entryMode === 'manual' ? 'Manual' : 'Clinic'}`}
                  </li>
                ) : null;
                const rows = grouped.map(({ item, index }) => {
                const issue = draftBasketIssues[index];
                const packLabel = `${item.qty} pack${item.qty === 1 ? '' : 's'}`;
                const editable = canEditBasketItems && item.rxId === selectedRxId;
                return (
                  <li key={`${item.rxId}-${item.productId}`} className={issue ? `is-${issue.tone}` : undefined}>
                    <div className="rx-order-summary-rail__product">
                      <MedicineLabel name={item.name} />
                    </div>
                    <div className="rx-order-summary-rail__headline">
                      {editable ? null : <span>{packLabel}</span>}
                      {pricesLocked || !quotedPatientTotals ? (
                        <strong>{quotedPatientTotals ? money(lineRevenue(item)) : pendingQuote}</strong>
                      ) : (
                        <div className="rx-line-price-nudges" role="group" aria-label={`Adjust patient price for ${item.name}`}>
                          {PRICE_NUDGE_POUNDS.filter(delta => delta < 0).map(delta => {
                            const nudge = nudgedPatientPrice(item.retail, delta, rrpFor(item.productId) ?? item.retail, item.cost);
                            const label = `Decrease patient price for ${item.name} by £${Math.abs(delta)}`;
                            return (
                              <button key={delta} type="button" className="rx-line-price-nudge" aria-label={label} title={nudge.reason ?? label} disabled={nudge.reason != null} onClick={() => onSetLinePrice(item.rxId, item.productId, nudge.pounds)}>−{Math.abs(delta)}</button>
                            );
                          })}
                          <label className="rx-line-price">
                            <span className="sr-only">Patient price for {item.name}</span>
                            <span>£</span>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={item.retail}
                              onChange={event => onSetLinePrice(item.rxId, item.productId, Number(event.target.value))}
                            />
                          </label>
                          {PRICE_NUDGE_POUNDS.filter(delta => delta > 0).map(delta => {
                            const nudge = nudgedPatientPrice(item.retail, delta, rrpFor(item.productId) ?? item.retail, item.cost);
                            const label = `Increase patient price for ${item.name} by £${delta}`;
                            return (
                              <button key={delta} type="button" className="rx-line-price-nudge" aria-label={label} title={nudge.reason ?? label} disabled={nudge.reason != null} onClick={() => onSetLinePrice(item.rxId, item.productId, nudge.pounds)}>+{delta}</button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    {(() => {
                      const rrp = rrpFor(item.productId);
                      if (rrp == null || Math.abs(rrp - item.retail) < 0.005) return null;
                      return <p className="rx-line-price__rrp">RRP {money(rrp)}</p>;
                    })()}
                    {(() => {
                      if (item.cost == null) return null;
                      const message = linePriceError(Math.round(item.retail * 100), Math.round((rrpFor(item.productId) ?? item.retail) * 100), Math.round(item.cost * 100));
                      return message ? <p className="rx-order-summary-rail__issue" role="alert">{message}</p> : null;
                    })()}
                    {issue ? (
                      <p className="rx-order-summary-rail__issue">
                        <AlertTriangle size={12} aria-hidden="true" />
                        {issue.label}
                      </p>
                    ) : null}
                    <dl className="rx-order-summary-rail__economics">
                      <div>
                        <dt title={WHOLESALE_LABEL}>{WHOLESALE_LABEL_SHORT}</dt>
                        <dd>{quotedPatientTotals && item.cost !== null ? money(lineCost(item)) : 'Pending'}</dd>
                      </div>
                      <div>
                        <dt>Margin</dt>
                        <dd className={basketMarginTone(marginPercent(lineContribution(item), lineRevenue(item)))}>{quotedPatientTotals && lineContribution(item) != null ? formatGlanceMargin(lineContribution(item) ?? 0, lineRevenue(item)) : 'Pending'}</dd>
                      </div>
                    </dl>
                    {editable ? (
                      <div className="rx-order-summary-rail__edit">
                        <button type="button" className="icon-button" aria-label={`Reduce packs of ${item.name}`} disabled={item.qty <= 1} onClick={() => onEditQuantity(item.rxId, item.productId, item.qty - 1)}><Minus size={14} /></button>
                        <button type="button" className="icon-button" aria-label={`Add pack of ${item.name}`} disabled={item.qty >= 100} onClick={() => onEditQuantity(item.rxId, item.productId, item.qty + 1)}><Plus size={14} /></button>
                        <span className="rx-order-summary-rail__edit-qty" aria-live="polite">{packLabel}</span>
                        <button type="button" className="icon-button danger rx-order-summary-rail__edit-remove" aria-label={`Remove ${item.name}`} onClick={() => onRemoveItem(item.rxId, item.productId)}><Trash2 size={14} /></button>
                      </div>
                    ) : null}
                  </li>
                );
                });
                return heading ? [heading, ...rows] : rows;
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
                <dt>{WHOLESALE_COST_LABEL}</dt>
                <dd>{draftBasketCosts ? money(draftBasketCosts.wholesale) : 'Quote pending'}</dd>
              </div>
              <div>
                <dt>Medicines subtotal</dt>
                <dd>{patientPrice == null ? pendingQuote : money(patientPrice)}</dd>
              </div>
              {discount > 0 ? <div><dt>Discount</dt><dd>−{money(discount)}</dd></div> : null}
              {pharmacyDelivery > 0 ? <div><dt>Delivery charge</dt><dd>{money(pharmacyDelivery)}</dd></div> : null}
              <div className="is-total">
                <dt>{PATIENT_TOTAL_LABEL}</dt>
                <dd>{patientTotal == null ? pendingQuote : money(patientTotal)}</dd>
              </div>
              <div className="rx-order-summary-rail__margin">
                <dt>Gross profit</dt>
                <dd className={basketMarginTone(marginPercent(grossMargin, medicineAfterDiscount ?? 0))}>
                  {grossMargin == null || medicineAfterDiscount == null ? 'Pending' : formatGlanceMargin(grossMargin, medicineAfterDiscount)}
                </dd>
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
