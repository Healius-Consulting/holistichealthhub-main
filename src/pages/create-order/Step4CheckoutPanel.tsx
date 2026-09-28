import { AlertTriangle, Banknote, CheckCircle, CreditCard, RefreshCw, Send, ShieldCheck, X } from 'lucide-react';
import ProviderStatusNotice from '../../components/ProviderStatusNotice';
import {
  money,
  orderReference,
  rxRevenue,
  type PatientOrder,
} from '../../context/AppContext';
import { rxRouteLabel, rxTabStatus, rxTabStatusLabel } from './rxTabStatus';
import { patientTotalBreakdown } from '../../utils/commercial';
import { PHARMACY_DELIVERY_LABEL } from '../../utils/pricing';

type Step4CheckoutPanelProps = {
  activeOrder: PatientOrder;
  activeOrderRef: string;
  redoSourceOrder: PatientOrder | null;
  paidRedo: boolean;
  paidRedoAmountMatches: boolean;
  paidRedoAmountDifference: number;
  replacementPreview: import('../../shared/contracts').PrescriptionReplacementPreview | null;
  replacementPreviewError: string | null;
  onRetryReplacementPreview: () => void;
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
  quotedPatientTotals: { medicine: number; discount: number; total: number } | null;
  discountError: string | null;
  pricesLocked: boolean;
  onSetDiscount: (discount: { mode: 'amount' | 'percent'; amount: number } | null) => void;
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
  const label = paymentPreview || workspaceMode === 'training' ? 'Curaleaf test catalogue' : workspaceMode === 'test' ? 'Curaleaf test quote' : 'Curaleaf quote';

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
  replacementPreview,
  replacementPreviewError,
  onRetryReplacementPreview,
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
  discountError,
  pricesLocked,
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
  onSetDiscount,
  onSetPharmacyDelivery,
  onChooseAbsorbDifference,
  onCancelReplacement,
  onSetPaymentRoute,
  onSubmit,
}: Step4CheckoutPanelProps) {
  void wholesaleKnown;
  const productSubtotal = quotedPatientTotals?.medicine ?? null;
  const discount = quotedPatientTotals?.discount ?? 0;
  const patientTotal = quotedPatientTotals?.total ?? null;
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

        <div className="rx-step4-discount">
          <p className="section-label">Discount</p>
          <div className="rx-dispensing-presets" role="group" aria-label="Discount type">
            <button type="button" aria-pressed={(activeOrder.discount?.mode ?? 'amount') === 'amount'} disabled={pricesLocked} onClick={() => onSetDiscount(activeOrder.discount ? { ...activeOrder.discount, mode: 'amount' } : null)}>£</button>
            <button type="button" aria-pressed={activeOrder.discount?.mode === 'percent'} disabled={pricesLocked} onClick={() => onSetDiscount({ mode: 'percent', amount: activeOrder.discount?.amount ?? 0 })}>%</button>
          </div>
          <label className="rx-dispensing-custom">
            <span className="money-input">
              <span>{activeOrder.discount?.mode === 'percent' ? '%' : '£'}</span>
              <input
                type="number"
                min="0"
                step="0.01"
                disabled={pricesLocked}
                value={activeOrder.discount?.amount || ''}
                aria-label="Order discount"
                onChange={event => {
                  const amount = Number(event.target.value);
                  onSetDiscount(event.target.value === '' || amount <= 0 ? null : { mode: activeOrder.discount?.mode ?? 'amount', amount });
                }}
              />
            </span>
          </label>
          {discountError ? <p className="rx-dispensing-hint" role="alert">{discountError}</p> : <p className="rx-dispensing-hint">Applies to medicines only. Delivery is not discounted.</p>}
        </div>

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
          {activeOrder.pharmacyDeliveryAllowed ? (
            <div className="rx-step4-decide__fee">
              <p className="section-label">{PHARMACY_DELIVERY_LABEL}</p>
              {!pharmacyDeliveryCurrentlyEnabled ? <p className="rx-dispensing-hint" role="status">This draft can retain Pharmacy Delivery because it was created while the setting was enabled.</p> : null}
              <div className="rx-dispensing-presets" role="group" aria-label="Set delivery charge">
                {[5, 10, 15].map(amount => <button type="button" key={amount} aria-pressed={activeOrder.pharmacyDelivery === amount} disabled={paidRedo} onClick={() => onSetPharmacyDelivery(amount)}>{money(amount)}</button>)}
                <button type="button" aria-pressed={activeOrder.pharmacyDelivery === 0} disabled={paidRedo} onClick={() => onSetPharmacyDelivery(0)}>None</button>
              </div>
              <label className="rx-dispensing-custom">
                <span className="money-input"><span>£</span><input type="number" min="0" max="15" step="0.01" value={activeOrder.pharmacyDelivery || ''} disabled={paidRedo} onFocus={event => event.currentTarget.select()} onChange={event => { const amount = Number(event.target.value); onSetPharmacyDelivery(event.target.value === '' ? 0 : Math.max(0, Math.min(15, amount))); }} aria-label="Delivery charge" aria-describedby="rx-pharmacy-delivery-hint" /></span>
              </label>
              {paidRedo ? (
                <p className="rx-dispensing-hint" role="status">
                  {replacementPreview?.carriesCharges
                    ? 'Carried over from the original order with the dispensing charge.'
                    : 'Already paid on the original order and still covering its other prescription. Not charged again.'}
                </p>
              ) : null}
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
              <small>
                {replacementPreview
                  ? `Carried over from ${replacementPreview.customerReference}`
                  : `Verified payment carried by order ${orderReference(redoSourceOrder)}`}
              </small>
              <strong>{money(replacementPreview ? replacementPreview.transferPence / 100 : redoSourceOrder.payment.amount)}</strong>
            </span>
            <span>
              <small>Replacement difference</small>
              <strong>
                {paidRedoAmountDifference === 0
                  ? money(0)
                  : `${paidRedoAmountDifference > 0 ? '+' : '−'}${money(Math.abs(paidRedoAmountDifference))}`}
              </strong>
            </span>
            {replacementPreview ? (
              <ul className="rx-step4-redo__carry">
                {replacementPreview.medicines.map(line => (
                  <li key={line.orderLineId}><span>{line.label} × {line.quantity}</span><strong>{money(line.amountPence / 100)}</strong></li>
                ))}
                <li>
                  <span>
                    {replacementPreview.carriesCharges
                      ? 'Dispensing and delivery, carried with the last prescription to leave the order'
                      : `Dispensing ${money(replacementPreview.charges.dispensing.remainingPence / 100)} and delivery ${money(replacementPreview.charges.delivery.remainingPence / 100)} stay on ${orderReference(redoSourceOrder)} — still covering ${replacementPreview.siblings.filter(sibling => sibling.state === 'live').map(sibling => sibling.customerReference).join(', ') || 'its other prescription'}`}
                  </span>
                  <strong>{money(replacementPreview.carriedChargesPence / 100)}</strong>
                </li>
              </ul>
            ) : replacementPreviewError ? (
              <p className="order-refund-composer__error" role="alert">
                {replacementPreviewError}{' '}
                <button type="button" className="btn btn-secondary btn-sm" onClick={onRetryReplacementPreview}>Retry</button>
              </p>
            ) : null}
            <p>
              {paidRedoAmountMatches
                ? 'Amounts match. The carried value may be applied after authentication.'
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

        <details className="rx-mobile-summary">
          <summary>Order summary</summary>
          <ul>
            {activeOrder.prescriptions.flatMap(rx => rx.items).map(item => (
              <li key={item.productId}><span>{item.name}</span><strong>{money(item.retail * item.qty)}</strong></li>
            ))}
          </ul>
        </details>
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
                  ? 'Add a medicine to price this order'
                  : patientTotalBreakdown(productSubtotal, discount, activeOrder.pharmacyDelivery || 0)}
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
