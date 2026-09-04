import { useEffect, useState } from 'react';
import { CheckCircle2, Clock, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import HhhBrandMark from '../components/HhhBrandMark';
import { ApiRequestError, getPublicPaymentReceipt, type PublicPaymentReceiptResponse } from '../shared/api';
import { parsePublicReceiptHash } from '../utils/publicReceiptHash';

type ReceiptLoadState = 'loading' | 'ready' | 'missing' | 'error';

function money(amountPence: number, currency = 'GBP') {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(amountPence / 100);
  } catch {
    return `£${(amountPence / 100).toFixed(2)}`;
  }
}

function formatWhen(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function receiptPresentation(receipt: PublicPaymentReceiptResponse) {
  const status = String(receipt.status || '').toLowerCase();
  const refunded = Number(receipt.refundedAmountPence || 0);
  const partial = Boolean(receipt.partial) || (refunded > 0 && refunded < receipt.amountPence);
  if (status === 'refunded' || (refunded > 0 && !partial)) {
    return {
      tone: 'refunded' as const,
      title: 'Payment refunded',
      summary: 'A refund has been completed for this payment. It can take a few working days to appear on the original payment method.',
      badge: 'Refunded',
    };
  }
  if (partial) {
    return {
      tone: 'partial' as const,
      title: 'Partially refunded',
      summary: 'Part of this payment has been refunded. Any remaining balance stays with the original payment.',
      badge: 'Partially refunded',
    };
  }
  if (status === 'paid') {
    return {
      tone: 'paid' as const,
      title: 'Payment receipt',
      summary: 'Your payment has cleared. Your pharmacy can continue preparing the prescription.',
      badge: 'Paid & cleared',
    };
  }
  if (status === 'failed' || status === 'cancelled' || status === 'expired') {
    return {
      tone: 'failed' as const,
      title: 'Payment not completed',
      summary: 'This payment was not completed. If you were charged, contact your dispensing pharmacy with the receipt reference.',
      badge: status === 'expired' ? 'Expired' : 'Not completed',
    };
  }
  return {
    tone: 'pending' as const,
    title: 'Payment pending',
    summary: 'This payment is still being confirmed. Check again shortly, or contact your pharmacy if you need help.',
    badge: 'Pending',
  };
}

export default function PaymentReceipt() {
  const hash = typeof window !== 'undefined' ? parsePublicReceiptHash(window.location.pathname) : null;
  const [loadState, setLoadState] = useState<ReceiptLoadState>(hash ? 'loading' : 'missing');
  const [receipt, setReceipt] = useState<PublicPaymentReceiptResponse | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (!hash) {
      setLoadState('missing');
      return;
    }
    let cancelled = false;
    setLoadState('loading');
    void getPublicPaymentReceipt(hash)
      .then(payload => {
        if (cancelled) return;
        setReceipt(payload);
        setLoadState('ready');
      })
      .catch(error => {
        if (cancelled) return;
        setReceipt(null);
        setLoadState(error instanceof ApiRequestError && error.status === 404 ? 'missing' : 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [hash, retryNonce]);

  useEffect(() => {
    if (loadState === 'ready' && receipt) {
      document.title = `${receiptPresentation(receipt).title} — Holistic Health Hub`;
      return;
    }
    if (loadState === 'missing') {
      document.title = 'Receipt not found — Holistic Health Hub';
      return;
    }
    document.title = 'Payment receipt — Holistic Health Hub';
  }, [loadState, receipt]);

  const presentation = receipt ? receiptPresentation(receipt) : null;
  const breakdown = receipt?.breakdown?.length ? receipt.breakdown : null;
  const paidLabel = receipt ? money(receipt.amountPence, receipt.currency) : null;
  const refundedLabel = receipt?.refundedAmountPence != null && receipt.refundedAmountPence > 0
    ? money(receipt.refundedAmountPence, receipt.currency)
    : null;
  const when = formatWhen(receipt?.updatedAt || receipt?.createdAt);

  return (
    <main className="payment-return-page">
      <section className="payment-return-card payment-return-card--enhanced" aria-live="polite">
        <header className="payment-return-brand" aria-label="Holistic Health Hub">
          <HhhBrandMark />
          <span>Holistic Health Hub</span>
        </header>

        {loadState === 'loading' ? (
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
            <h2>Loading receipt…</h2>
            <p className="payment-return-wait-status">Checking the payment record.</p>
          </div>
        ) : null}

        {loadState === 'ready' && receipt && presentation ? (
          <div className={`payment-return-result payment-return-result--${presentation.tone === 'failed' ? 'failed' : 'success'}`}>
            <div className={`payment-return-icon payment-return-icon--${presentation.tone === 'failed' ? 'failed' : 'complete'}`}>
              {presentation.tone === 'failed' ? <XCircle size={40} /> : <CheckCircle2 size={40} />}
            </div>
            <h2>{presentation.title}</h2>
            <p className="payment-return-summary">{presentation.summary}</p>

            <div className="payment-return-receipt-card">
              <div className="receipt-card-row">
                <span>Status</span>
                <strong className={`receipt-badge receipt-badge--${presentation.tone}`}>
                  {presentation.tone === 'paid' ? <ShieldCheck size={13} /> : null}
                  {presentation.badge}
                </strong>
              </div>
              {receipt.orderNumber ? (
                <div className="receipt-card-row">
                  <span>Order reference</span>
                  <code className="receipt-ref">{receipt.orderNumber}</code>
                </div>
              ) : null}
              {breakdown ? breakdown.map(line => (
                <div className="receipt-card-row receipt-card-row--line" key={line.key}>
                  <span>{line.label}</span>
                  <span>{money(line.amountPence, receipt.currency)}</span>
                </div>
              )) : null}
              {paidLabel ? (
                <div className={`receipt-card-row${breakdown ? ' receipt-card-row--total' : ''}`}>
                  <span>{breakdown ? 'Total' : 'Original amount'}</span>
                  <strong>{paidLabel}</strong>
                </div>
              ) : null}
              {refundedLabel ? (
                <div className="receipt-card-row">
                  <span>Refunded</span>
                  <strong>{refundedLabel}</strong>
                </div>
              ) : null}
              {when ? (
                <div className="receipt-card-row">
                  <span>Date</span>
                  <span>{when}</span>
                </div>
              ) : null}
            </div>

            <div className="payment-return-help">
              <small>Need help with this payment? Contact your dispensing pharmacy{receipt.orderNumber ? <> quoting order <strong>{receipt.orderNumber}</strong></> : null}.</small>
            </div>
          </div>
        ) : null}

        {(loadState === 'missing' || loadState === 'error') ? (
          <div className="payment-return-result payment-return-result--failed">
            <div className="payment-return-icon payment-return-icon--failed">
              <XCircle size={40} />
            </div>
            <h2>{loadState === 'missing' ? 'Receipt not found' : 'Receipt unavailable'}</h2>
            <p className="payment-return-summary">
              {loadState === 'missing'
                ? 'This receipt link is invalid or no longer available. Check the link in your email, or contact your pharmacy.'
                : 'We could not load this receipt right now. Try again in a moment.'}
            </p>
            {loadState === 'error' ? (
              <div className="payment-return-actions">
                <button type="button" className="btn btn-primary payment-retry-btn" onClick={() => setRetryNonce(current => current + 1)}>
                  <RefreshCw size={14} /> Try again
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}
