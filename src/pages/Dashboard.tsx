import { Activity, ArrowRight, ListTodo, History, FileText } from 'lucide-react';
import { orderRevenue, useApp } from '../context/AppContext';
import SummaryTiles from '../components/SummaryTiles';
import { compactPatientName } from '../utils/patientName';
import { orderAwaitingCuraleafCancel, orderCancellationResolution } from '../utils/orderStage';

export default function Dashboard() {
  const { state, dispatch } = useApp();
  const organisationId = state.currentOrganisationId;
  const tenantOrders = state.orders.filter(order => order.organisationId === organisationId);
  const tenantPatients = state.crm.filter(patient => patient.organisationId === organisationId);
  const curaleafIntegration = state.platformIntegrations.find(integration => integration.id === 'curaleaf');

  /* ── Computed stats ── */
  const awaitingPaymentOrders = tenantOrders.filter(order =>
    order.lifecycleStatus !== 'cancelled'
    && !order.cancellation
    && order.payment.status === 'sent'
  );
  const awaitingPayment = awaitingPaymentOrders.length;
  const activeWorldpayLinks = awaitingPaymentOrders.filter(order => order.payment.route === 'worldpay').length;

  const inFulfilment = tenantOrders.filter(o =>
    o.lifecycleStatus !== 'cancelled' &&
    !o.cancellation &&
    o.payment.status === 'paid' &&
    o.prescriptions.some(rx => !['ready', 'collected'].includes(rx.status))
  ).length;

  const readyForCollection = tenantOrders.filter(o =>
    o.lifecycleStatus !== 'cancelled' &&
    !o.cancellation &&
    o.payment.status === 'paid' &&
    o.prescriptions.length > 0 &&
    o.prescriptions.every(rx => rx.status === 'ready')
  ).length;

  // 1. Uncollected warnings (10+ days)
  const uncollectedAlerts = tenantOrders.flatMap(o => {
    if (o.lifecycleStatus === 'cancelled' || o.cancellation) return [];
    const pName = tenantPatients.find(p => p.id === o.patientId)?.name ?? 'Unknown';
    const pMobile = tenantPatients.find(p => p.id === o.patientId)?.mobile ?? '';
    return o.prescriptions
      .filter(rx => rx.status === 'ready' && rx.readyAt && (Date.now() - new Date(rx.readyAt).getTime()) >= 10 * 24 * 60 * 60 * 1000)
      .map(rx => ({
        type: 'uncollected' as const,
        id: `uncollected-${o.id}-${rx.id}`,
        patientName: pName,
        patientMobile: pMobile,
        patientId: o.patientId ?? '',
        orderId: o.id,
        rxId: rx.id,
        days: Math.floor((Date.now() - new Date(rx.readyAt!).getTime()) / (1000 * 60 * 60 * 24)),
      }));
  });

  // 2. Overdue payments (3+ days)
  const overduePaymentAlerts = awaitingPaymentOrders
    .filter(o => o.payment.sentAt && (Date.now() - new Date(o.payment.sentAt).getTime()) >= 3 * 24 * 60 * 60 * 1000)
    .map(o => {
      const pName = tenantPatients.find(p => p.id === o.patientId)?.name ?? 'Unknown';
      const pEmail = tenantPatients.find(p => p.id === o.patientId)?.email ?? '';
      const amount = orderRevenue(o);
      return {
        type: 'payment' as const,
        id: `payment-${o.id}`,
        patientName: pName,
        patientEmail: pEmail,
        patientId: o.patientId ?? '',
        orderId: o.id,
        amount,
        days: Math.floor((Date.now() - new Date(o.payment.sentAt!).getTime()) / (1000 * 60 * 60 * 24)),
      };
    });

  // 3. Repeat overdue (30+ days)
  const repeatAlerts = tenantPatients.map(p => {
    const pOrders = tenantOrders.filter(o => o.patientId === p.id && orderCancellationResolution(o) === 'none');
    if (pOrders.length === 0) return null;
    const latestOrder = [...pOrders].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0];
    const daysSince = Math.floor((Date.now() - new Date(latestOrder.date).getTime()) / (1000 * 60 * 60 * 24));
    if (daysSince >= 30) {
      return {
        type: 'repeat' as const,
        id: `repeat-${p.id}`,
        patientName: p.name,
        patientId: p.id,
        days: daysSince,
      };
    }
    return null;
  }).filter((x): x is NonNullable<typeof x> => x !== null);

  const cancellationAlerts = tenantOrders
    .filter(order => orderCancellationResolution(order) === 'needs-action')
    .map(order => ({
      id: `cancellation-${order.id}`,
      orderId: order.id,
      patientName: tenantPatients.find(patient => patient.id === order.patientId)?.name ?? 'Unknown patient',
      step: orderAwaitingCuraleafCancel(order) || order.curaleafCancellation?.status === 'contact_required'
        ? 'Call Curaleaf Customer Service before refunding or reordering.'
        : order.curaleafCancellation?.status === 'awaiting_confirmation'
          ? 'Waiting for Curaleaf cancellation confirmation.'
          : `Refund ${order.payment.ref ?? 'the recorded payment'} and confirm the reference.`,
    }));

  const totalUrgent = uncollectedAlerts.length + overduePaymentAlerts.length + repeatAlerts.length + cancellationAlerts.length;

  /* ── Recent orders (last 5) ── */
  const recentOrders = tenantOrders
    .filter(order => orderCancellationResolution(order) === 'none')
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 5);

  const patientName = (patientId: string | null) => {
    if (!patientId) return 'Unassigned';
    return tenantPatients.find(p => p.id === patientId)?.name ?? 'Unknown';
  };

  const paymentPill = (order: (typeof tenantOrders)[number]) => {
    if (orderAwaitingCuraleafCancel(order)) return <span className="pill pill-red">Call Curaleaf</span>;
    if (order.refund?.status === 'completed') return <span className="pill pill-neutral">Refunded</span>;
    if (order.cancellation?.status === 'refund_required') return <span className="pill pill-red">Refund due</span>;
    if (order.lifecycleStatus === 'cancelled' || order.payment.status === 'cancelled') return <span className="pill pill-neutral">Cancelled</span>;
    switch (order.payment.status) {
      case 'paid': return <span className="pill pill-green">Paid</span>;
      case 'sent': return <span className="pill pill-amber">Awaiting</span>;
      default:     return <span className="pill pill-neutral">Draft</span>;
    }
  };

  return (
    <div className="page-body operations-dashboard">
      {/* Pipeline counts, not headline metrics. The first thing on this page is the
          work that needs a person; how many patients exist is context, and it moved
          below the queue rather than above it. */}
      <div className="page-grid-main">
        <div className="page-stack">

          {totalUrgent > 0 && (
            <section className="card card-urgent priority-queue">
              {/* The count lives in this heading. A separate "N urgent items require
                  attention today" strip repeated it one line above the list that
                  already shows every item. */}
              <div className="section-heading"><div><p className="section-label">Needs you</p><h3><Activity size={17} /> {totalUrgent} item{totalUrgent === 1 ? '' : 's'} need attention</h3></div></div>
              <div className="alert-list">
                {cancellationAlerts.map(alert => (
                  <div key={alert.id} className="alert-item alert-item--danger">
                    <div className="alert-item__copy">
                      <span className="alert-item__category">Order cancellation</span>
                      <span className="alert-item__title">{alert.patientName}</span>
                      <span className="alert-item__desc">{alert.step}</span>
                    </div>
                    <button className="priority-action" onClick={() => { dispatch({ type: 'SET_NAVIGATION_TARGET', target: { kind: 'order', key: String(alert.orderId) } }); dispatch({ type: 'SET_SCREEN', screen: 'orders' }); }}>
                      Open order <ArrowRight size={14} />
                    </button>
                  </div>
                ))}

                {uncollectedAlerts.map(alert => (
                  <div key={alert.id} className="alert-item alert-item--danger">
                    <div className="alert-item__copy">
                      <span className="alert-item__category">Collection follow-up</span>
                      <span className="alert-item__title">{alert.patientName}</span>
                      <span className="alert-item__desc">
                        Ready for collection for <strong className="text-red">{alert.days} days</strong>. Contact: {alert.patientMobile}
                      </span>
                    </div>
                    <button
                      className="priority-action"
                      onClick={() => {
                        dispatch({ type: 'ADD_TOAST', message: `SMS reminder resent to ${alert.patientName} (${alert.patientMobile}).`, toastType: 'success' });
                        dispatch({ type: 'LOG_INTERACTION', patientId: alert.patientId, interactionType: 'SMS Reminder', detail: `Resent counter pickup notification SMS to ${alert.patientMobile}.` });
                      }}
                    >
                      Send reminder <ArrowRight size={14} />
                    </button>
                  </div>
                ))}

                {overduePaymentAlerts.map(alert => (
                  <div key={alert.id} className="alert-item alert-item--warning">
                    <div className="alert-item__copy">
                      <span className="alert-item__category">Overdue payment</span>
                      <span className="alert-item__title">{alert.patientName}</span>
                      <span className="alert-item__desc">
                        <strong className="text-primary">£{alert.amount.toFixed(2)}</strong> outstanding for{' '}
                        <strong className="text-amber">{alert.days} days</strong>. {alert.patientEmail}
                      </span>
                    </div>
                    <button
                      className="priority-action"
                      onClick={() => {
                        dispatch({ type: 'ADD_TOAST', message: `Worldpay billing link resent to ${alert.patientName} at ${alert.patientEmail}.`, toastType: 'info' });
                        dispatch({ type: 'LOG_INTERACTION', patientId: alert.patientId, interactionType: 'Payment Link Resent', detail: `Resent Worldpay invoice link for £${alert.amount.toFixed(2)} to ${alert.patientEmail}.` });
                      }}
                    >
                      Resend link <ArrowRight size={14} />
                    </button>
                  </div>
                ))}

                {repeatAlerts.map(alert => (
                  <div key={alert.id} className="alert-item alert-item--info">
                    <div className="alert-item__copy">
                      <span className="alert-item__category">Repeat prescription</span>
                      <span className="alert-item__title">{alert.patientName}</span>
                      <span className="alert-item__desc">
                        Last order <strong className="text-info">{alert.days} days ago</strong>. Treatment gap exceeds guidelines.
                      </span>
                    </div>
                    <div className="priority-action-group">
                      <button
                        className="priority-action priority-action--quiet"
                        onClick={() => {
                          dispatch({ type: 'ADD_TOAST', message: `Follow-up logged for ${alert.patientName}.`, toastType: 'success' });
                          dispatch({ type: 'LOG_INTERACTION', patientId: alert.patientId, interactionType: 'Callback Scheduled', detail: 'Scheduled repeat prescription assessment call.' });
                        }}
                      >
                        Log follow-up
                      </button>
                      <button
                        className="priority-action"
                        onClick={() => {
                          dispatch({ type: 'LOG_INTERACTION', patientId: alert.patientId, interactionType: 'Repeat Rx Initiated', detail: 'Created new repeat prescription order session from dashboard.' });
                          dispatch({ type: 'NEW_ORDER', patientId: alert.patientId });
                          dispatch({ type: 'SET_SCREEN', screen: 'create' });
                        }}
                      >
                        Create repeat <ArrowRight size={14} />
                      </button>
                    </div>
                  </div>
                ))}

              </div>
            </section>
          )}

          <section className="operations-brief" aria-label="Pipeline">
            <SummaryTiles className="summary-tiles--compact" label="Pipeline" items={[
              { label: 'Awaiting payment', value: awaitingPayment, detail: 'with the patient', onClick: () => dispatch({ type: 'SET_SCREEN', screen: 'orders' }) },
              { label: 'With Curaleaf', value: inFulfilment, detail: 'placement to goods-in', onClick: () => dispatch({ type: 'SET_SCREEN', screen: 'orders' }) },
              { label: 'Ready to collect', value: readyForCollection, detail: 'waiting for the patient', onClick: () => dispatch({ type: 'SET_SCREEN', screen: 'orders' }) },
              { label: 'Patients', value: tenantPatients.length, detail: 'activated by HHH', onClick: () => dispatch({ type: 'SET_SCREEN', screen: 'patients' }) },
            ]} />
          </section>

          {/* Recent Pharmacy Sessions */}
          <section className="card card-flush activity-ledger">
            <div className="section-heading section-heading--padded"><div><p className="section-label">Activity ledger</p><h3><History size={16} /> Recent pharmacy sessions</h3><p>Continue active work or review the latest completed sessions.</p></div><span>{recentOrders.length} latest</span></div>
            {recentOrders.length === 0 ? (
              <div className="empty-state">No active sessions or order history.</div>
            ) : (
              <div className="session-ledger">
                <div className="session-ledger__head" aria-hidden="true"><span>Date</span><span>Patient</span><span>Payment</span><span>Action</span></div>
                <div role="list">
                {recentOrders.map(order => {
                  const sessionDate = new Date(order.date);
                  const openSession = () => {
                    if (order.payment.status === 'none') {
                      dispatch({ type: 'SET_ACTIVE_ORDER', orderId: order.id });
                      dispatch({ type: 'SET_SCREEN', screen: 'create' });
                      return;
                    }
                    dispatch({ type: 'SET_NAVIGATION_TARGET', target: { kind: 'order', key: `${order.id}-${order.prescriptions[0]?.id ?? 0}` } });
                    dispatch({ type: 'SET_SCREEN', screen: 'orders' });
                  };
                  return (
                    <div className="session-ledger__row" role="listitem" key={order.id}>
                      <time className="session-ledger__date" dateTime={sessionDate.toISOString()}>
                        <strong>{sessionDate.toLocaleDateString('en-GB', { day: '2-digit' })}</strong>
                        <span>{sessionDate.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}</span>
                      </time>
                      <div className="session-ledger__patient">
                        <button type="button" onClick={openSession} title={patientName(order.patientId)}>{compactPatientName(patientName(order.patientId))}</button>
                        <span>{order.prescriptions.length} prescription{order.prescriptions.length === 1 ? '' : 's'} · {sessionDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      <div className="session-ledger__status"><small>Status</small>{paymentPill(order)}</div>
                      <button type="button" className="session-ledger__open" onClick={openSession} aria-label={`Open ${patientName(order.patientId)} prescription session`}>
                        {order.payment.status === 'none' ? 'Continue' : 'Review'} <ArrowRight size={14} aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
                </div>
              </div>
            )}
          </section>

        </div>

        {/* RIGHT COLUMN: Operational Checklist */}
        <aside className="card card-surface duty-sidebar">
          <div className="section-heading"><div><p className="section-label">Shift handover</p><h3><ListTodo size={16} /> Pharmacist duties</h3></div></div>

          <div className="duty-list">
            <div className="duty-item">
              <input type="checkbox" checked readOnly aria-label="Patient access is HHH controlled" />
              <div>
                <span className="font-semibold" style={{ display: 'block' }}>HHH-controlled activation</span>
                <span className="text-muted text-xs">Only patients referred and activated by HHH appear in this workspace.</span>
              </div>
            </div>
            <div className="duty-item">
              <input type="checkbox" checked={awaitingPayment === 0} readOnly aria-label="Outstanding billing links cleared" />
              <div>
                <span className="font-semibold" style={{ display: 'block' }}>Outstanding Billing Links</span>
                <span className="text-muted text-xs">{activeWorldpayLinks} active Worldpay payment link{activeWorldpayLinks === 1 ? '' : 's'}.</span>
              </div>
            </div>
            <div className="duty-item">
              <input type="checkbox" checked={inFulfilment === 0} readOnly aria-label="Supply chain review complete" />
              <div>
                <span className="font-semibold" style={{ display: 'block' }}>Supply Chain Review</span>
                <span className="text-muted text-xs">{inFulfilment} orders processing with Curaleaf.</span>
              </div>
            </div>
          </div>

          <div className="divider" style={{ margin: '4px 0' }} />

          <div className="integration-note">
            <h4><FileText size={12} /> Curaleaf Integration</h4>
            <p>{curaleafIntegration?.status === 'connected' ? 'Connected to Curaleaf. Supplier orders and shipment events are available.' : 'Curaleaf is managed by HHH administration. Wait and retry later, or contact your HHH administrator if access remains unavailable.'}</p>
          </div>
        </aside>

      </div>
    </div>
  );
}
