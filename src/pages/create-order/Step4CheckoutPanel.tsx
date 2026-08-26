import { AlertTriangle, Banknote, CheckCircle, CreditCard, RefreshCw, Send, ShieldCheck, X } from 'lucide-react';
import MedicineLabel from '../../components/MedicineLabel';
import ProviderStatusNotice from '../../components/ProviderStatusNotice';
import { lineCost, lineMargin, lineRevenue, money, orderCost, orderReference, orderRevenue, type CRMPatient, type PatientOrder } from '../../context/AppContext';

type BasketItem = {
  rxId: number;
  productId: string;
  name: string;
  qty: number;
  retail: number;
  cost: number | null;
};

type Step4CheckoutPanelProps = {
  activeOrder: PatientOrder;
  activeOrderRef: string;
  patient: CRMPatient | null;
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
  quoteSummary: { shippingPrice: number; taxRate: number } | null;
  currentQuoteItemsCount: number;
  draftBasketCount: number;
  draftBasketTotal: number;
  draftBasketItems: BasketItem[];
  draftBasketIssues: Array<{ tone: 'blocked' | 'warning'; label: string } | null>;
  selectedPaymentRoute: 'worldpay' | 'manual';
  canUseWorldpay: boolean;
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

export default function Step4CheckoutPanel({
  activeOrder,
  activeOrderRef,
  patient,
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
  draftBasketCount,
  draftBasketTotal,
  draftBasketItems,
  draftBasketIssues,
  selectedPaymentRoute,
  canUseWorldpay,
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
  return (
    <section className="rx-checkout-panel card rx-checkout-panel--guided rx-create-step" id="rx-order-review">
      <header>
        <p className="section-label">Step 4 · Order {activeOrderRef}</p>
        <strong>{paidRedo ? 'Review and carry over payment' : 'Review and request payment'}</strong>
        <small>{patient?.name ?? 'Patient not linked'} · {activeOrder.prescriptions.length} prescription record{activeOrder.prescriptions.length === 1 ? '' : 's'}</small>
      </header>
      <dl className="rx-order-totals">
        <div><dt>Prescription records</dt><dd>{activeOrder.prescriptions.length}</dd></div>
        <div><dt>Wholesale total (excl VAT)</dt><dd>{wholesaleKnown ? money(orderCost(activeOrder)) : workspaceMode === 'training' ? 'Not supplied' : 'Quote required'}</dd></div>
        <div><dt>Patient-price subtotal</dt><dd>{money(orderRevenue(activeOrder) - activeOrder.dispensingFee)}</dd></div>
        <div><dt>Gross margin</dt><dd className={orderMargin === null ? '' : orderMargin >= 25 ? 'text-green' : 'text-amber'}>{orderMargin === null ? 'Pending' : `${money(orderRevenue(activeOrder) - orderCost(activeOrder))} · ${orderMargin}%`}</dd></div>
      </dl>
      <div className={`rx-checkout-readiness${quoteError ? ' has-error' : ''}`}>
        <span className="section-label">{workspaceMode === 'training' ? 'Curaleaf test quote' : 'Live Curaleaf quote'}</span>
        <span className={quoteAvailable ? 'complete' : ''}>{quoteAvailable ? <CheckCircle size={13} /> : quoteBusy ? <RefreshCw size={13} className="spin" /> : <span className="rx-readiness-dot" />}{quoteAvailable ? 'Wholesale and stock verified' : quoteBusy ? 'Updating automatically for this basket…' : quoteError ? 'Automatic quote needs attention' : quoteCurrent ? 'Pricing returned · stock unavailable' : currentQuoteItemsCount ? 'Automatic quote waiting to refresh' : 'Add a medicine to generate a quote'}</span>
        {quoteAvailable && quoteCheckedAt ? (
          <span className="complete">
            <CheckCircle size={13} /> Checked {new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(new Date(quoteCheckedAt))} · saved with the payment request
          </span>
        ) : null}
        {quoteSummary && quoteCurrent ? <span className={quoteAvailable ? 'complete' : ''}>{quoteAvailable ? <CheckCircle size={13} /> : <span className="rx-readiness-dot" />} Shipping {money(quoteSummary.shippingPrice)} · tax {quoteSummary.taxRate}%</span> : null}
        <small className="rx-auto-quote-note">Quotes refresh after a medicine or pack quantity changes.</small>
        {quoteError ? <>
          <ProviderStatusNotice title={quoteError.title} detail={quoteError.detail} />
          <button type="button" className="btn btn-secondary btn-sm" disabled={quoteBusy || !currentQuoteItemsCount} onClick={onRefreshQuote}><RefreshCw size={13} className={quoteBusy ? 'spin' : ''} /> {quoteBusy ? 'Retrying quote…' : 'Retry quote now'}</button>
        </> : null}
      </div>
      {draftBasketCount ? (
        <section className="rx-checkout-basket" aria-label="Draft medicines in this order">
          <header className="rx-checkout-basket__head">
            <span className="section-label">Draft basket</span>
            <strong>{draftBasketCount} medicine{draftBasketCount === 1 ? '' : 's'} · {money(draftBasketTotal)}</strong>
          </header>
          <ul className="rx-checkout-basket__list">
            {draftBasketItems.map((item, index) => {
              const margin = lineMargin(item);
              const issue = draftBasketIssues[index];
              return (
                <li key={`${item.rxId}-${item.productId}`} className={issue ? `is-${issue.tone}` : undefined}>
                  <span className="rx-checkout-basket__product">
                    <MedicineLabel name={item.name} />
                    <small>
                      {item.qty} {item.qty === 1 ? 'pack' : 'packs'} · {money(item.retail)} each
                      {issue ? <span className="rx-basket-drawer__issue"> · {issue.label}</span> : null}
                    </small>
                  </span>
                  <span className="rx-checkout-basket__line">
                    <strong>{money(lineRevenue(item))}</strong>
                    <small>{item.cost === null || margin === null ? 'Quote pending' : `${margin}% · ${money(lineCost(item))}`}</small>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      <div className="rx-checkout-panel__settle">
        <div className="rx-checkout-panel__review">
          <div className="rx-dispensing-charge">
            <span><strong>Dispensing charge</strong></span>
            <div className="rx-dispensing-presets" role="group" aria-label="Set dispensing charge">
              {[5, 10, 15].map(amount => <button type="button" key={amount} aria-pressed={activeOrder.dispensingFee === amount} onClick={() => onSetDispensingFee(amount)}>{money(amount)}</button>)}
              <button type="button" aria-pressed={activeOrder.dispensingFee === 0} onClick={() => onSetDispensingFee(0)}>No charge</button>
            </div>
            <label className="rx-dispensing-custom"><span>Custom</span><span className="money-input"><span>£</span><input type="number" min="5" max="15" step="0.01" value={activeOrder.dispensingFee || ''} onFocus={event => event.currentTarget.select()} onChange={event => { const amount = Number(event.target.value); onSetDispensingFee(event.target.value === '' ? 0 : Math.max(5, Math.min(15, amount))); }} aria-label="Custom dispensing charge" /></span></label>
            {activeOrder.redoContext?.isPaidRedo && redoSourceOrder ? (
              <div className={`rx-redo-balance${paidRedoAmountMatches ? ' is-matched' : ' is-different'}`}>
                <span><small>Verified payment carried by order {orderReference(redoSourceOrder)}</small><strong>{money(redoSourceOrder.payment.amount)}</strong></span>
                <span><small>Replacement difference</small><strong>{paidRedoAmountDifference === 0 ? money(0) : `${paidRedoAmountDifference > 0 ? '+' : '−'}${money(Math.abs(paidRedoAmountDifference))}`}</strong></span>
                <p>{paidRedoAmountMatches
                  ? 'Amounts match. The original verified payment may be carried over after authentication.'
                  : activeOrder.redoContext.priceResolution === 'absorb'
                    ? `The pharmacy will contribute ${money(paidRedoAmountDifference)}; the patient is not charged again.`
                    : `The pharmacy absorbs the ${money(Math.abs(paidRedoAmountDifference))} ${paidRedoAmountDifference > 0 ? 'increase' : 'decrease'}; the patient payment remains unchanged.`}</p>
                {!paidRedoAmountMatches ? <div className="rx-redo-balance__choices">
                  <button type="button" className={`btn btn-sm ${activeOrder.redoContext.priceResolution === 'absorb' ? 'btn-primary' : 'btn-secondary'}`} onClick={onChooseAbsorbDifference}><Banknote size={12} /> Absorb {money(Math.abs(paidRedoAmountDifference))}</button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={onCancelReplacement}><X size={12} /> Cancel replacement</button>
                </div> : null}
              </div>
            ) : null}
            <div className="rx-patient-total"><span><small>Patient total</small><em>{money(orderRevenue(activeOrder) - activeOrder.dispensingFee)} products + {money(activeOrder.dispensingFee)} dispensing</em></span><strong>{money(orderRevenue(activeOrder))}</strong></div>
          </div>
        </div>
        <div className="rx-checkout-panel__pay">
          <div className="rx-payment-actions">
            <span className="section-label">Payment route</span>
            {paidRedo ? (
              <div className="rx-payment-route-toggle"><div className="is-selected"><ShieldCheck size={17} /><span><strong>Verified payment carry-over</strong><small>{activeOrder.redoContext?.priceResolution === 'absorb' ? 'Original payment retained · pharmacy absorbs difference' : 'No second charge to the patient'}</small></span><CheckCircle size={14} /></div></div>
            ) : (
              <div className="rx-payment-route-toggle" role="radiogroup" aria-label="Pharmacy payment route">
                <button type="button" role="radio" aria-checked={selectedPaymentRoute === 'worldpay'} disabled={!canUseWorldpay} className={selectedPaymentRoute === 'worldpay' ? 'is-selected' : ''} onClick={() => onSetPaymentRoute('worldpay')}><CreditCard size={17} /><span><strong>Worldpay</strong><small>{canUseWorldpay ? 'Fresh hosted checkout' : 'Not configured'}</small></span>{selectedPaymentRoute === 'worldpay' ? <CheckCircle size={14} /> : null}</button>
                <button type="button" role="radio" aria-checked={selectedPaymentRoute === 'manual'} className={selectedPaymentRoute === 'manual' ? 'is-selected' : ''} onClick={() => onSetPaymentRoute('manual')}><Banknote size={17} /><span><strong>Manual payment</strong><small>EPOS, cash or transfer</small></span>{selectedPaymentRoute === 'manual' ? <CheckCircle size={14} /> : null}</button>
              </div>
            )}
            <footer className="rx-checkout-panel__submit">
              {!readyForPayment ? (
                <p id="rx-checkout-lock-tip" className="rx-checkout-blocker" role="status">
                  <AlertTriangle size={14} aria-hidden="true" />
                  <span>
                    <strong>Payment remains locked</strong>
                    {outstandingPaymentGates.slice(0, 2).map(item => item.label).join(' · ')}
                    {outstandingPaymentGates.length > 2 ? ` · +${outstandingPaymentGates.length - 2} more` : ''}
                  </span>
                </p>
              ) : null}
              <button type="button" className="btn btn-primary rx-create-payment" disabled={checkoutBusy || !readyForPayment || (selectedPaymentRoute === 'worldpay' && !canUseWorldpay)} aria-describedby={!readyForPayment ? 'rx-checkout-lock-tip' : undefined} onClick={onSubmit}><Send size={15} />{checkoutBusy ? 'Saving order…' : paidRedo ? 'Save replacement order' : selectedPaymentRoute === 'worldpay' ? 'send payment link' : 'Continue with manual payment'}</button>
            </footer>
          </div>
        </div>
      </div>
    </section>
  );
}
