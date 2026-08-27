import { AlertTriangle, Banknote, CheckCircle, CreditCard, RefreshCw, Send, ShieldCheck, X } from 'lucide-react';
import ProviderStatusNotice from '../../components/ProviderStatusNotice';
import {
  PATIENT_PRICE_LABEL,
  WHOLESALE_LABEL,
  formatMargin,
  money,
  orderContribution,
  orderCost,
  orderReference,
  orderRevenue,
  type PatientOrder,
} from '../../context/AppContext';

type Step4CheckoutPanelProps = {
  activeOrder: PatientOrder;
  activeOrderRef: string;
  redoSourceOrder: PatientOrder | null;
  paidRedo: boolean;
  paidRedoAmountMatches: boolean;
  paidRedoAmountDifference: number;
  wholesaleKnown: boolean;
  orderMargin: number | null;
  workspaceMode: string;
  quoteAvailable: boolean;
  quoteBusy: boolean;
  quoteCurrent: boolean;
  quoteError: { title: string; detail: string } | null;
  quoteCheckedAt: string | null;
  quoteSummary: { shippingPrice: number } | null;
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
  onChooseAbsorbDifference: () => void;
  onCancelReplacement: () => void;
  onSetPaymentRoute: (route: 'worldpay' | 'manual') => void;
  onSubmit: () => void;
};

function quoteStatusLine(input: {
  workspaceMode: string;
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
    quoteAvailable,
    quoteBusy,
    quoteCurrent,
    quoteError,
    quoteCheckedAt,
    quoteSummary,
    currentQuoteItemsCount,
  } = input;
  const label = workspaceMode === 'training' ? 'Curaleaf test quote' : 'Curaleaf quote';

  if (quoteAvailable) {
    const parts = [`${label} verified`];
    if (quoteSummary) parts.push(`shipping ${money(quoteSummary.shippingPrice)}`);
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
  orderMargin,
  workspaceMode,
  quoteAvailable,
  quoteBusy,
  quoteCurrent,
  quoteError,
  quoteCheckedAt,
  quoteSummary,
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
  onChooseAbsorbDifference,
  onCancelReplacement,
  onSetPaymentRoute,
  onSubmit,
}: Step4CheckoutPanelProps) {
  const productSubtotal = orderRevenue(activeOrder) - activeOrder.dispensingFee;
  const patientTotal = orderRevenue(activeOrder);
  const quoteStatus = quoteStatusLine({
    workspaceMode,
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
            <p className="rx-step4-status__note">Quotes refresh when medicines or pack quantities change.</p>
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

        <dl className="rx-step4-ledger" aria-label="Order commercial summary">
          <div>
            <dt>{WHOLESALE_LABEL}</dt>
            <dd>{wholesaleKnown ? money(orderCost(activeOrder)) : workspaceMode === 'training' ? 'Not supplied' : 'Quote required'}</dd>
          </div>
          <div className="is-ruled">
            <dt>Delivery</dt>
            <dd>{quoteSummary ? money(quoteSummary.shippingPrice) : 'Quote required'}</dd>
          </div>
          <div>
            <dt>Dispensing</dt>
            <dd>{money(activeOrder.dispensingFee)}</dd>
          </div>
          <div>
            <dt>{PATIENT_PRICE_LABEL}</dt>
            <dd>{money(productSubtotal)}</dd>
          </div>
          <div className="is-total">
            <dt>Patient total</dt>
            <dd>{money(patientTotal)}</dd>
          </div>
          <div className="rx-step4-ledger__margin">
            <dt>Gross margin</dt>
            <dd className={orderMargin === null ? '' : orderMargin >= 25 ? 'is-good' : 'is-warn'}>
              {/* Every line's contribution plus the dispensing charge the pharmacy keeps. */}
              {wholesaleKnown ? formatMargin(orderContribution(activeOrder), patientTotal) : 'Pending'}
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

        <div className="rx-step4-decide">
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
                No charge
              </button>
            </div>
            <label className="rx-dispensing-custom">
              <span>Custom</span>
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
              <div className="rx-payment-route-toggle" role="radiogroup" aria-label="Pharmacy payment route">
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
          {!readyForPayment ? (
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
              <strong>{money(patientTotal)}</strong>
              <em>{money(productSubtotal)} products + {money(activeOrder.dispensingFee)} dispensing</em>
            </div>
            <button
              type="button"
              className="btn btn-primary rx-create-payment"
              disabled={checkoutBusy || !readyForPayment || (selectedPaymentRoute === 'worldpay' && !canUseWorldpay)}
              aria-describedby={!readyForPayment ? 'rx-checkout-lock-tip' : undefined}
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
