import { useEffect, useState, useRef } from 'react';
import { CheckCircle2, Clock, XCircle, RefreshCw, ShieldCheck, ArrowRight, Package, FileCheck } from 'lucide-react';
import HhhBrandMark from '../components/HhhBrandMark';
import { getPublicPaymentStatus, type PublicPaymentStatusResponse } from '../shared/api';

export type PaymentReturnStatus = 'complete' | 'cancelled';

type ClearanceState = 'checking' | 'cleared' | 'declined' | 'timeout';

export default function PaymentReturn({ status }: { status: PaymentReturnStatus }) {
  const isDirectCancelled = status === 'cancelled';
  const [clearanceState, setClearanceState] = useState<ClearanceState>(isDirectCancelled ? 'declined' : 'checking');
  const [paymentData, setPaymentData] = useState<PublicPaymentStatusResponse | null>(null);
  const [pollCount, setPollCount] = useState(0);
  const [statusMessage, setStatusMessage] = useState('Connecting to Worldpay & your pharmacy…');
  
  // Extract reference parameters from query string
  const urlParams = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const reference = urlParams.get('ref') || urlParams.get('transactionReference') || urlParams.get('orderCode') || urlParams.get('receipt') || urlParams.get('order') || urlParams.get('paid') || '';
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Progressive wait status copy
  useEffect(() => {
    if (clearanceState !== 'checking') return;

    if (pollCount === 0) {
      setStatusMessage('Contacting payment gateway…');
    } else if (pollCount === 1) {
      setStatusMessage('Verifying payment clearance with your bank…');
    } else if (pollCount === 2) {
      setStatusMessage('Syncing authorization with your pharmacy…');
    } else if (pollCount >= 3) {
      setStatusMessage('Finalising prescription order records…');
    }
  }, [pollCount, clearanceState]);

  // Polling function
  const checkStatus = async () => {
    if (!reference) {
      setClearanceState(status === 'complete' ? 'timeout' : 'declined');
      return;
    }

    try {
      const res = await getPublicPaymentStatus({
        ref: reference,
        receipt: reference,
        success: status === 'complete',
      });

      if (res.status === 'paid') {
        setPaymentData(res);
        // Small 1.2s delay for satisfying spinner transition
        setTimeout(() => setClearanceState('cleared'), 1200);
        return;
      } else if (res.status === 'failed' || res.status === 'cancelled') {
        setPaymentData(res);
        setClearanceState('declined');
        return;
      }

      // If still pending, poll a couple times
      setPollCount(count => {
        if (count >= 3) {
          setClearanceState('timeout');
          return count;
        }
        return count + 1;
      });
    } catch {
      setPollCount(count => {
        if (count >= 2) setClearanceState('timeout');
        return count + 1;
      });
    }
  };

  useEffect(() => {
    if (isDirectCancelled) {
      setClearanceState('declined');
      return;
    }

    // Initial check
    void checkStatus();

    // Setup poll interval
    pollTimerRef.current = setInterval(() => {
      if (clearanceState === 'checking') {
        void checkStatus();
      }
    }, 2200);

    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [reference, isDirectCancelled, clearanceState]);

  useEffect(() => {
    if (clearanceState === 'cleared') {
      document.title = 'Payment Confirmed — Holistic Health Hub';
    } else if (clearanceState === 'declined') {
      document.title = 'Payment Cancelled — Holistic Health Hub';
    } else {
      document.title = 'Verifying Payment — Holistic Health Hub';
    }
  }, [clearanceState]);

  const formattedAmount = paymentData?.amountPence ? `£${(paymentData.amountPence / 100).toFixed(2)}` : null;

  return (
    <main className="payment-return-page">
      <section className="payment-return-card payment-return-card--enhanced" aria-live="polite">
        <header className="payment-return-brand" aria-label="Holistic Health Hub">
          <HhhBrandMark />
          <span>Holistic Health Hub</span>
        </header>

        {clearanceState === 'checking' && (
          <div className="payment-return-wait-gate">
            <div className="payment-return-spinner-wrap">
              <svg className="payment-return-spinner-ring" viewBox="0 0 80 80">
                <circle className="payment-return-spinner-bg" cx="40" cy="40" r="34" />
                <circle className="payment-return-spinner-fg" cx="40" cy="40" r="34" />
              </svg>
              <div className="payment-return-spinner-icon">
                <Clock size={28} className="payment-return-spinner-clock" />
              </div>
            </div>
            <h2>Verifying payment…</h2>
            <p className="payment-return-wait-status">{statusMessage}</p>
            {reference && <small className="payment-return-reference-chip">Ref: {reference}</small>}
          </div>
        )}

        {clearanceState === 'cleared' && (
          <div className="payment-return-result payment-return-result--success">
            <div className="payment-return-icon payment-return-icon--complete">
              <CheckCircle2 size={40} />
            </div>
            <h2>Payment Confirmed</h2>
            <p className="payment-return-summary">
              Thank you. Your payment has cleared and your prescription has been placed with your pharmacy for dispensing.
            </p>

            <div className="payment-return-receipt-card">
              <div className="receipt-card-row">
                <span>Status</span>
                <strong className="receipt-badge receipt-badge--paid"><ShieldCheck size={13} /> Paid & Cleared</strong>
              </div>
              {reference && (
                <div className="receipt-card-row">
                  <span>Reference</span>
                  <code className="receipt-ref">{reference}</code>
                </div>
              )}
              {formattedAmount && (
                <div className="receipt-card-row">
                  <span>Amount Paid</span>
                  <strong>{formattedAmount}</strong>
                </div>
              )}
              <div className="receipt-card-row">
                <span>Date</span>
                <span>{new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            </div>

            <div className="payment-return-lifecycle">
              <h4>What happens next?</h4>
              <ol className="payment-lifecycle-steps">
                <li className="lifecycle-step lifecycle-step--done">
                  <div className="lifecycle-step-marker"><FileCheck size={14} /></div>
                  <div className="lifecycle-step-body">
                    <strong>Prescription Approved</strong>
                    <small>Clinical eligibility and prescriber authorization complete.</small>
                  </div>
                </li>
                <li className="lifecycle-step lifecycle-step--done">
                  <div className="lifecycle-step-marker"><CheckCircle2 size={14} /></div>
                  <div className="lifecycle-step-body">
                    <strong>Payment Cleared</strong>
                    <small>Authorized via secure Worldpay gateway.</small>
                  </div>
                </li>
                <li className="lifecycle-step lifecycle-step--active">
                  <div className="lifecycle-step-marker"><Package size={14} /></div>
                  <div className="lifecycle-step-body">
                    <strong>Dispensing & Packaging</strong>
                    <small>Your pharmacy is preparing your medication.</small>
                  </div>
                </li>
                <li className="lifecycle-step lifecycle-step--next">
                  <div className="lifecycle-step-marker"><ArrowRight size={14} /></div>
                  <div className="lifecycle-step-body">
                    <strong>Tracked Delivery</strong>
                    <small>Tracking updates will be sent via SMS / email upon dispatch.</small>
                  </div>
                </li>
              </ol>
            </div>

            <div className="payment-return-help">
              <small>Need help with this order? Contact your dispensing pharmacy directly quoting reference <strong>{reference || 'above'}</strong>.</small>
            </div>
          </div>
        )}

        {(clearanceState === 'declined' || clearanceState === 'timeout') && (
          <div className="payment-return-result payment-return-result--cancelled">
            <div className="payment-return-icon payment-return-icon--cancelled">
              <XCircle size={40} />
            </div>
            <h2>{clearanceState === 'timeout' ? 'Payment status pending' : 'Payment not completed'}</h2>
            <p className="payment-return-summary">
              {clearanceState === 'timeout'
                ? 'We could not confirm payment clearance immediately. If funds were debited, your order will update shortly.'
                : 'No funds have been debited. Your prescription order remains saved with your pharmacy.'}
            </p>

            {reference && (
              <div className="payment-return-receipt-card">
                <div className="receipt-card-row">
                  <span>Reference</span>
                  <code className="receipt-ref">{reference}</code>
                </div>
                <div className="receipt-card-row">
                  <span>Status</span>
                  <span className="receipt-badge receipt-badge--failed">
                    {clearanceState === 'timeout' ? 'Pending Clearance' : 'Cancelled / Refused'}
                  </span>
                </div>
              </div>
            )}

            <div className="payment-return-actions">
              <button
                type="button"
                className="btn btn-primary payment-retry-btn"
                onClick={() => {
                  setClearanceState('checking');
                  setPollCount(0);
                  void checkStatus();
                }}
              >
                <RefreshCw size={14} /> Check status again
              </button>
            </div>

            <div className="payment-return-help">
              <small>To complete your order, please use the link provided in your pharmacy email or contact your pharmacy team.</small>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

