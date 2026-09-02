import { AlertTriangle, Banknote, CheckCircle, CreditCard, RefreshCw, Send, ShieldCheck, X } from 'lucide-react';
import ProviderStatusNotice from '../../components/ProviderStatusNotice';
import {
  formatMargin,
  marginToneClass,
  money,
  orderCost,
  orderReference,
  rxRevenue,
  type PatientOrder,
} from '../../context/AppContext';
import { rxRouteLabel, rxTabStatus, rxTabStatusLabel } from './rxTabStatus';
import { CURALEAF_DELIVERY_LABEL, MEDICINE_COST_LABEL, PATIENT_TOTAL_LABEL, PHARMACY_DELIVERY_LABEL, PHARMACY_TOTAL_LABEL, WHOLESALE_COST_LABEL, marginPercent } from '../../utils/pricing';

type Step4CheckoutPanelProps = {
  activeOrder: PatientOrder;
  activeOrderRef: string;
  redoSourceOrder: PatientOrder | null;
  paidRedo: boolean;
  paidRedoAmountMatches: boolean;
  paidRedoAmountDifference: number;
  wholesaleKnown: boolean;
  pharmacyDeliveryCurrentlyEnabled: boolean;
  workspaceMode: string;
  paymentPreview?: boolean;
  quoteAvailable: boolean;
  quoteBusy: boolean;
  quoteCurrent: boolean;
  quoteError: { title: string; detail: string } | null;
  quoteCheckedAt: string | null;
  quoteSummary: { shippingPrice: number } | null;
  quotedPatientTotals: { medicine: number; total: number } | null;
  currentQuoteItemsCount: number;
  draftBasketBlockedCount: number;
  draftBasketWarningCount: number;
  selectedPaymentRoute: 'worldpay' | 'manual';
  canUseWorldpay: boolean;
  worldpayStatusReady: boolean;
  readyForPayment: boolean;
  outstandingPaymentGates: Array<{ label: string; complete: boolean }>;
  checkoutBusy: boolean;
  onRefreshQuote: () => void;
  onSetDispensingFee: (amount: number) => void;
  onSetPharmacyDelivery: (amount: number) => void;
  onChooseAbsorbDifference: () => void;
  onCancelReplacement: () => void;
  onSetPaymentRoute: (route: 'worldpay' | 'manual') => void;
  onSubmit: () => void;
};

function quoteStatusLine(input: {
  workspaceMode: string;
  paymentPreview: boolean;
  quoteAvailable: boolean;
  quoteBusy: boolean;
  quoteCurrent: boolean;
  quoteError: { title: string; detail: string } | null;
  quoteCheckedAt: string | null;
  quoteSummary: { shippingPrice: number } | null;
  currentQuoteItemsCount: number;
}) {
  const {
    workspaceMode,
    paymentPreview,
    quoteAvailable,
    quoteBusy,
    quoteCurrent,
    quoteError,
    quoteCheckedAt,
    currentQuoteItemsCount,
  } = input;
  const label = paymentPreview || workspaceMode === 'training' ? 'Curaleaf test catalogue' : 'Curaleaf quote';

  if (quoteAvailable) {
    const parts = paymentPreview ? [`${label} prices`] : [`${label} verified`];
    if (quoteCheckedAt) {
      parts.push(`checked ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(quoteCheckedAt))}`);
    }
    return { tone: 'ok' as const, text: parts.join(' · ') };
  }
  if (quoteBusy) return { tone: 'busy' as const, text: `${label}: updating for this basket…` };
  if (quoteError) return { tone: 'error' as const, text: `${label} needs attention` };
  if (quoteCurrent) return { tone: 'warn' as const, text: `${label}: pricing returned · stock unavailable` };
  if (currentQuoteItemsCount) return { tone: 'pending' as const, text: `${label}: waiting to refresh` };
  return { tone: 'pending' as const, text: 'Add a medicine to generate a quote' };
}

export default function Step4CheckoutPanel({
  activeOrder,
  activeOrderRef,
  redoSourceOrder,
  paidRedo,
  paidRedoAmountMatches,
  paidRedoAmountDifference,
  wholesaleKnown,
  pharmacyDeliveryCurrentlyEnabled,
  workspaceMode,
  paymentPreview = false,
  quoteAvailable,
  quoteBusy,
  quoteCurrent,
  quoteError,
  quoteCheckedAt,
  quoteSummary,
  quotedPatientTotals,
  currentQuoteItemsCount,
  draftBasketBlockedCount,
  draftBasketWarningCount,
  selectedPaymentRoute,
  canUseWorldpay,
  worldpayStatusReady,
  readyForPayment,
  outstandingPaymentGates,
  checkoutBusy,
  onRefreshQuote,
  onSetDispensingFee,
  onSetPharmacyDelivery,
  onChooseAbsorbDifference,
  onCancelReplacement,
  onSetPaymentRoute,
  onSubmit,
}: Step4CheckoutPanelProps) {
  const productSubtotal = quotedPatientTotals?.medicine ?? null;
  const patientTotal = quotedPatientTotals?.total ?? null;
  const curaleafDelivery = quoteSummary?.shippingPrice ?? 0;
  const pharmacyTotal = wholesaleKnown && quoteSummary ? orderCost(activeOrder) + curaleafDelivery : null;
  const grossMargin = pharmacyTotal == null || patientTotal == null ? null : patientTotal - pharmacyTotal;
  const quoteStatus = quoteStatusLine({
    workspaceMode,
    paymentPreview,
    quoteAvailable,
    quoteBusy,
    quoteCurrent,
    quoteError,
    quoteCheckedAt,
    quoteSummary,
    currentQuoteItemsCount,
  });
  const issueCount = draftBasketBlockedCount + draftBasketWarningCount;
  const submitLabel = checkoutBusy
    ? 'Saving order…'
    : paidRedo
      ? 'Save replacement order'
      : selectedPaymentRoute === 'worldpay'
        ? 'Send payment link'
        : 'Continue with manual payment';

  return (
    <section id="rx-order-review" className="rx-surface card rx-create-step rx-step4-panel">
      <header className="rx-surface__header">
        <div className="section-heading" style={{ margin: 0 }}>
          <div>
            <p className="section-label">Step 4 · Payment · {activeOrderRef}</p>
            <h3>
              <Banknote size={17} />
              {paidRedo ? 'Carry over payment' : 'Request payment'}
            </h3>
          </div>
        </div>
      </header>

      <div className="rx-step4-panel__body">
        <div className={`rx-step4-status${quoteError ? ' has-error' : ''}${quoteAvailable ? ' is-ok' : ''}`}>
          <p className="rx-step4-status__line" role="status">
            {quoteAvailable ? <CheckCircle size={15} aria-hidden="true" /> : null}
            {quoteBusy ? <RefreshCw size={15} className="spin" aria-hidden="true" /> : null}
            {!quoteAvailable && !quoteBusy ? <span className="rx-step4-status__dot" aria-hidden="true" /> : null}
            <span>{quoteStatus.text}</span>
          </p>
          {quoteAvailable ? (
            <p className="rx-step4-status__note">
              {paymentPreview
                ? 'Prices come from the Curaleaf test catalogue on this workspace. They are a preview until Curaleaf is live.'
                : 'Quotes refresh when medicines or pack quantities change.'}
            </p>
          ) : null}
          {quoteError ? (
            <div className="rx-step4-status__error">
              <ProviderStatusNotice title={quoteError.title} detail={quoteError.detail} />
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={quoteBusy || !currentQuoteItemsCount}
                onClick={onRefreshQuote}
              >
                <RefreshCw size={13} className={quoteBusy ? 'spin' : ''} />
                {quoteBusy ? 'Retrying quote…' : 'Retry quote now'}
              </button>
            </div>
          ) : null}
        </div>

        {activeOrder.prescriptions.length > 1 ? (
          <ul className="rx-step4-rx-list" aria-label="Prescriptions on this order">
            {activeOrder.prescriptions.map((rx, index) => {
              const status = rxTabStatus(rx);
              const packCount = rx.items.reduce((sum, item) => sum + item.qty, 0);
              return (
                <li key={rx.id}>
                  <span>
                    <strong>Prescription {index + 1} · {rxRouteLabel(rx)}</strong>
                    <small>
                      {status === 'ready'
                        ? `${rx.copyFileName || rx.clinicScanId ? 'copy attached' : ''} · ${packCount} pack${packCount === 1 ? '' : 's'}`
                        : rxTabStatusLabel(status)}
                    </small>
                  </span>
                  <strong>{quotedPatientTotals ? money(rxRevenue(rx)) : 'Quote pending'}</strong>
                </li>
              );
            })}
          </ul>
        ) : null}

        <dl className="rx-step4-ledger" aria-label="Order commercial summary">
          <div className="rx-step4-ledger__section">
            <dt>Pharmacy Cost</dt>
            <dd />
          </div>
          <div>
            <dt>{WHOLESALE_COST_LABEL}</dt>
            <dd>{wholesaleKnown ? money(orderCost(activeOrder)) : workspaceMode === 'training' ? 'Not supplied' : 'Quote required'}</dd>
          </div>
          {curaleafDelivery > 0 ? <div><dt>{CURALEAF_DELIVERY_LABEL}</dt><dd>{money(curaleafDelivery)}</dd></div> : null}
          <div className="is-total">
            <dt>{PHARMACY_TOTAL_LABEL}</dt>
            <dd>{pharmacyTotal == null ? 'Quote required' : money(pharmacyTotal)}</dd>
          </div>
          <div className="rx-step4-ledger__section is-ruled">
            <dt>Patient Cost</dt>
            <dd />
          </div>
          <div>
            <dt>{MEDICINE_COST_LABEL}</dt>
            <dd>{productSubtotal == null ? 'Quote pending' : money(productSubtotal)}</dd>
          </div>
          {activeOrder.dispensingFee > 0 ? <div><dt>Dispensing Charge</dt><dd>{money(activeOrder.dispensingFee)}</dd></div> : null}
          {activeOrder.pharmacyDelivery > 0 ? <div><dt>Delivery Charge</dt><dd>{money(activeOrder.pharmacyDelivery)}</dd></div> : null}
          <div className="is-total">
            <dt>{PATIENT_TOTAL_LABEL}</dt>
            <dd>{patientTotal == null ? 'Quote pending' : money(patientTotal)}</dd>
          </div>
          <div className="rx-step4-ledger__margin">
            <dt>Gross Margin</dt>
            <dd className={marginToneClass(marginPercent(grossMargin, patientTotal ?? 0))}>
              {formatMargin(grossMargin, patientTotal ?? 0)}
            </dd>
          </div>
        </dl>

        {issueCount > 0 ? (
          <p className={`rx-step4-basket-alert${draftBasketBlockedCount ? ' is-blocked' : ' is-warning'}`} role="status">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>
              {draftBasketBlockedCount
                ? `${draftBasketBlockedCount} medicine${draftBasketBlockedCount === 1 ? ' is' : 's are'} unavailable.`
                : `${draftBasketWarningCount} medicine${draftBasketWarningCount === 1 ? ' has' : 's have'} a stock warning.`}
              {' '}Review the basket in the summary rail or go back to medicines.
            </span>
          </p>
        ) : null}

        <div className={`rx-step4-decide${activeOrder.pharmacyDeliveryAllowed ? ' rx-step4-decide--with-delivery' : ''}`}>
          <div className="rx-step4-decide__fee">
            <p className="section-label">Dispensing charge</p>
            <div className="rx-dispensing-presets" role="group" aria-label="Set dispensing charge">
              {[5, 10, 15].map(amount => (
                <button
                  type="button"
                  key={amount}
                  aria-pressed={activeOrder.dispensingFee === amount}
                  onClick={() => onSetDispensingFee(amount)}
                >
                  {money(amount)}
                </button>
              ))}
              <button type="button" aria-pressed={activeOrder.dispensingFee === 0} onClick={() => onSetDispensingFee(0)}>
                None
              </button>
            </div>
            <label className="rx-dispensing-custom">
              <span className="money-input">
                <span>£</span>
                <input
                  type="number"
                  min="0"
                  max="15"
                  step="0.01"
                  value={activeOrder.dispensingFee || ''}
                  onFocus={event => event.currentTarget.select()}
                  onChange={event => {
                    const amount = Number(event.target.value);
                    onSetDispensingFee(event.target.value === '' ? 0 : Math.max(0, Math.min(15, amount)));
                  }}
                  aria-label="Custom dispensing charge"
                  aria-describedby="rx-dispensing-custom-hint"
                />
              </span>
            </label>
            <p className="rx-dispensing-hint" id="rx-dispensing-custom-hint">Any amount from £0 to £15. Presets above are shortcuts.</p>
          </div>

          {activeOrder.pharmacyDeliveryAllowed ? (
            <div className="rx-step4-decide__fee">
              <p className="section-label">{PHARMACY_DELIVERY_LABEL}</p>
              {!pharmacyDeliveryCurrentlyEnabled ? <p className="rx-dispensing-hint" role="status">This draft can retain Pharmacy Delivery because it was created while the setting was enabled.</p> : null}
              <div className="rx-dispensing-presets" role="group" aria-label="Set delivery charge">
                {[5, 10, 15].map(amount => <button type="button" key={amount} aria-pressed={activeOrder.pharmacyDelivery === amount} onClick={() => onSetPharmacyDelivery(amount)}>{money(amount)}</button>)}
                <button type="button" aria-pressed={activeOrder.pharmacyDelivery === 0} onClick={() => onSetPharmacyDelivery(0)}>None</button>
              </div>
              <label className="rx-dispensing-custom">
                <span className="money-input"><span>£</span><input type="number" min="0" max="15" step="0.01" value={activeOrder.pharmacyDelivery || ''} onFocus={event => event.currentTarget.select()} onChange={event => { const amount = Number(event.target.value); onSetPharmacyDelivery(event.target.value === '' ? 0 : Math.max(0, Math.min(15, amount))); }} aria-label="Delivery charge" aria-describedby="rx-pharmacy-delivery-hint" /></span>
              </label>
              <p className="rx-dispensing-hint" id="rx-pharmacy-delivery-hint">Any amount from £0 to £15. Presets above are shortcuts.</p>
            </div>
          ) : null}

          <div className="rx-step4-decide__route">
            <p className="section-label">Payment route</p>
            {paidRedo ? (
              <div className="rx-payment-route-toggle">
                <div className="is-selected">
                  <ShieldCheck size={17} />
                  <span>
                    <strong>Verified payment carry-over</strong>
                    <small>
                      {activeOrder.redoContext?.priceResolution === 'absorb'
                        ? 'Original payment retained · pharmacy absorbs difference'
                        : 'No second charge to the patient'}
                    </small>
                  </span>
                  <CheckCircle size={14} />
                </div>
              </div>
            ) : (
              <div className="rx-payment-route-toggle rx-payment-route-toggle--choices" role="radiogroup" aria-label="Pharmacy payment route">
                <button
                  type="button"
                  role="radio"
                  aria-checked={selectedPaymentRoute === 'worldpay'}
                  disabled={!canUseWorldpay}
                  className={selectedPaymentRoute === 'worldpay' ? 'is-selected' : ''}
                  onClick={() => onSetPaymentRoute('worldpay')}
                >
                  <CreditCard size={17} />
                  <span>
                    <strong>Worldpay</strong>
                    <small>
                      {!worldpayStatusReady
                        ? 'Checking merchant connection…'
                        : canUseWorldpay
                          ? 'Fresh hosted checkout'
                          : 'Not configured'}
                    </small>
                  </span>
                  {selectedPaymentRoute === 'worldpay' ? <CheckCircle size={14} /> : null}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={selectedPaymentRoute === 'manual'}
                  className={selectedPaymentRoute === 'manual' ? 'is-selected' : ''}
                  onClick={() => onSetPaymentRoute('manual')}
                >
                  <Banknote size={17} />
                  <span>
                    <strong>Manual payment</strong>
                    <small>EPOS, cash or transfer</small>
                  </span>
                  {selectedPaymentRoute === 'manual' ? <CheckCircle size={14} /> : null}
                </button>
              </div>
            )}
          </div>
        </div>

        {activeOrder.redoContext?.isPaidRedo && redoSourceOrder ? (
          <div className={`rx-step4-redo${paidRedoAmountMatches ? ' is-matched' : ' is-different'}`}>
            <span>
              <small>Verified payment carried by order {orderReference(redoSourceOrder)}</small>
              <strong>{money(redoSourceOrder.payment.amount)}</strong>
            </span>
            <span>
              <small>Replacement difference</small>
              <strong>
                {paidRedoAmountDifference === 0
                  ? money(0)
                  : `${paidRedoAmountDifference > 0 ? '+' : '−'}${money(Math.abs(paidRedoAmountDifference))}`}
              </strong>
            </span>
            <p>
              {paidRedoAmountMatches
                ? 'Amounts match. The original verified payment may be carried over after authentication.'
                : activeOrder.redoContext.priceResolution === 'absorb'
                  ? `The pharmacy will contribute ${money(paidRedoAmountDifference)}; the patient is not charged again.`
                  : `The pharmacy absorbs the ${money(Math.abs(paidRedoAmountDifference))} ${paidRedoAmountDifference > 0 ? 'increase' : 'decrease'}; the patient payment remains unchanged.`}
            </p>
            {!paidRedoAmountMatches ? (
              <div className="rx-step4-redo__choices">
                <button
                  type="button"
                  className={`btn btn-sm ${activeOrder.redoContext.priceResolution === 'absorb' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={onChooseAbsorbDifference}
                >
                  <Banknote size={12} /> Accept
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={onCancelReplacement}>
                  <X size={12} /> Cancel replacement
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="rx-step4-commit">
          {paymentPreview ? (
            <p id="rx-checkout-lock-tip" className="rx-step4-commit__lock" role="status">
              <AlertTriangle size={14} aria-hidden="true" />
              <span>
                <strong>Payment is a preview</strong>
                Worldpay, ePOS and Curaleaf placement stay locked until Curaleaf is live. You can still choose a route to see how checkout looks.
              </span>
            </p>
          ) : !readyForPayment ? (
            <p id="rx-checkout-lock-tip" className="rx-step4-commit__lock" role="status">
              <AlertTriangle size={14} aria-hidden="true" />
              <span>
                <strong>Payment remains locked</strong>
                {' '}
                {outstandingPaymentGates.slice(0, 2).map(item => item.label).join(' · ')}
                {outstandingPaymentGates.length > 2 ? ` · +${outstandingPaymentGates.length - 2} more` : ''}
              </span>
            </p>
          ) : null}
          <div className="rx-step4-commit__row">
            <div className="rx-step4-commit__total">
              <small>Patient total</small>
              <strong>{patientTotal == null ? 'Quote pending' : money(patientTotal)}</strong>
              <em>
                {productSubtotal == null
                  ? 'Waiting for a Curaleaf quote'
                  : `${money(productSubtotal)} medicine${activeOrder.dispensingFee ? ` + ${money(activeOrder.dispensingFee)} dispensing` : ''}${activeOrder.pharmacyDelivery ? ` + ${money(activeOrder.pharmacyDelivery)} delivery` : ''}`}
              </em>
            </div>
            <button
              type="button"
              className="btn btn-primary rx-create-payment"
              disabled={checkoutBusy || paymentPreview || !readyForPayment || (selectedPaymentRoute === 'worldpay' && !canUseWorldpay)}
              aria-describedby={paymentPreview || !readyForPayment ? 'rx-checkout-lock-tip' : undefined}
              onClick={onSubmit}
            >
              <Send size={15} />
              {submitLabel}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
