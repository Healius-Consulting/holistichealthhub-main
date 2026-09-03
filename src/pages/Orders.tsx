import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { curaleafDeliveryGuidance } from '@hhh/domain/delivery';
import { collectionEmailNotice } from '@hhh/domain/collection-window';
import {
  AlertTriangle,
  Archive,
  Banknote,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleDot,
  Clock3,
  Copy,
  CreditCard,
  FileText,
  Info,
  Layers2,
  ListFilter,
  Mail,
  Package,
  PackageCheck,
  Phone,
  RefreshCw,
  Search,
  ShieldAlert,
  Truck,
  User,
  X,
  XCircle,
  PhoneCall,
  type LucideIcon,
} from 'lucide-react';
import {
  lineRevenue,
  money,
  orderReference,
  rxRevenue,
  useApp,
  type CRMPatient,
  type LineItem,
  type ManualTender,
  type PatientOrder,
  type PaymentStatus,
  type Prescription,
} from '../context/AppContext';
import { isLocalPortalPreview } from '../dev/localPortalPreview';
import { isOpenPharmacyWorkspace } from '../training/workspace';
import { ApiRequestError, confirmPortalOrderRefund, createPortalOrderRefund, getPrescriptionFileDownloadUrl, handoutPortalOrder, placePrescriptionManually, recordPortalGoodsReceipt, recordPortalManualPayment, requestPortalOrderCancellation, resolvePortalQuoteReview, resendWorldpayPaymentLink } from '../shared/api';
import { isPersistedPrescriptionFileId, orderPrescriptionCopyViewable } from '../utils/prescriptionFile';
import { compactPatientName } from '../utils/patientName';
import {
  orderAwaitingSupplierShipmentProductNames,
  orderCancellationResolution,
  orderHasInTransitPacks,
  orderHasPartialCollection,
  orderHasPartialCuraleafDispense,
  orderHasUncollectedReceivedPacks,
  orderIsSplitFulfilment,
  orderFulfilmentHeadline,
  orderPaymentAllowsManualCancellation,
  orderRequiresCuraleafCancel,
  orderAwaitingCuraleafCancel,
  orderSplitPackSnapshot,
  orderStage,
  orderSupplyIncomplete,
  orderUncollectedReadyPacks,
  prescriptionIsCancelled,
  prescriptionSupplyIncomplete,
  prescriptionUncollectedReadyPacks,
  prescriptionStatusLabel,
  prescriptionStatusChipTone,
  stageMatchesFilter,
  unpaidCancellationConfirmation,
  type OrderStage,
  type StageFilter,
} from '../utils/orderStage';
import {
  ORDER_BOARD_LANES,
  orderBoardLane,
  orderCardStageLabel,
  orderBoardSection,
  orderBoardSlug,
  orderCardTagLabel,
  orderLaneRank,
  orderSplitCardDescription,
  orderSplitCardLabel,
  quoteReviewIsOpen,
  type OrderBoardLane,
} from '../utils/orderBoardLanes';
import { buildOrderTimelineEvents, buildPrescriptionStageRail, type OrderStageStep } from '../utils/orderTimeline';
import { visiblePaymentGateCheck } from '../utils/quoteGate';
import RecordDialog from '../components/RecordDialog';
import {
  collectOrderConsignments,
  consignmentStatusLabel,
  orderCourierLabel,
  orderDeliveryDestination,
  shortConsignmentId,
} from '../utils/orderDetailsLedger';
import {
  buildPrescriptionWorkItems,
  prescriptionWorkItemIsLive,
  prescriptionWorkItemLabel,
  type PrescriptionWorkItem,
} from '../utils/prescriptionWorkItems';
type ManualPaymentForm = { tender: ManualTender; reference: string; notes: string; confirmed: boolean };
type GoodsReceiptDraft = { quantities: Record<string, number>; batches: Record<string, string>; expiries: Record<string, string>; note: string };

function openTrainingPrescriptionPreview() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="794" height="1123" viewBox="0 0 794 1123">
    <rect width="100%" height="100%" fill="#f7f4ef"/>
    <rect x="48" y="48" width="698" height="1027" fill="#fffdf8" stroke="#8a8175" stroke-width="2"/>
    <text x="397" y="220" text-anchor="middle" font-family="Georgia, serif" font-size="28" fill="#3f3a34">Training prescription copy</text>
    <text x="397" y="268" text-anchor="middle" font-family="system-ui, sans-serif" font-size="16" fill="#6b645c">Local preview only. Nothing is stored.</text>
  </svg>`;
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return Boolean(opened);
}

/**
 * Field-scoped search. One fuzzy match across every field makes a PO reference
 * search hit patient names too; scoping says which field is being searched.
 */
const ORDER_SEARCH_SCOPES = [
  { key: 'all', label: 'All' },
  { key: 'patient', label: 'Patient' },
  { key: 'order', label: 'Order' },
  { key: 'prescription', label: 'Rx / PO' },
] as const;

type OrderSearchScope = (typeof ORDER_SEARCH_SCOPES)[number]['key'];

interface OrderRecord {
  order: PatientOrder;
  patient: CRMPatient | null;
  stage: OrderStage;
  unresolvedReason: ReturnType<typeof orderStage>['unresolvedReason'];
}

const DEFAULT_MANUAL_FORM: ManualPaymentForm = { tender: 'epos-card', reference: '', notes: '', confirmed: false };

const STAGE_META: Record<OrderStage, { label: string; description: string; tone: string; icon: LucideIcon }> = {
  'awaiting-payment': { label: 'Awaiting Payment', description: 'Payment link active with patient', tone: 'warning', icon: Clock3 },
  paid: { label: 'Awaiting Placement', description: 'Payment cleared; ready for Curaleaf placement', tone: 'paid', icon: CreditCard },
  'curaleaf-pending': { label: 'Curaleaf Review', description: 'Prescription in pharmacist validation queue', tone: 'curaleaf-review', icon: CircleDot },
  'curaleaf-approved': { label: 'Curaleaf Dispensing', description: 'Order approved; Curaleaf dispensary technicians allocating packs', tone: 'curaleaf-picking', icon: Package },
  dispatched: { label: 'In Transit', description: 'Dispatched with courier to the pharmacy', tone: 'dispatched', icon: Truck },
  delivered: { label: 'Checked In', description: 'Checked in at pharmacy; not yet ready to collect', tone: 'delivered', icon: PackageCheck },
  ready: { label: 'Ready to Collect', description: 'Verified by pharmacy; patient notified', tone: 'ready', icon: Package },
  collected: { label: 'Collected', description: 'Medicine collected by the patient', tone: 'collected', icon: Check },
  rejected: { label: 'Curaleaf Exception', description: 'Order requires prescription or recipe fix', tone: 'danger', icon: ShieldAlert },
  archived: { label: 'Archived', description: 'Prescription 28-day window expired', tone: 'neutral', icon: Archive },
  cancelled: { label: 'Cancelled', description: 'Cancellation recorded for audit', tone: 'danger', icon: XCircle },
};

const FILTER_GROUPS: Array<{ label: string; filters: Array<{ key: StageFilter; label: string }> }> = [
  {
    label: 'Live Queue',
    filters: [
      { key: 'current', label: 'Current' },
      { key: 'awaiting-payment', label: 'Awaiting Payment' },
      { key: 'awaiting-fulfilment', label: 'Awaiting Fulfilment' },
      { key: 'ready', label: 'Ready to Collect' },
    ],
  },
  {
    label: 'Exceptions',
    filters: [
      { key: 'cancelled', label: 'Cancellations' },
      { key: 'rejected', label: 'Rejected' },
    ],
  },
  {
    label: 'History',
    filters: [
      { key: 'archived', label: 'Archived' },
      { key: 'completed', label: 'Completed' },
      { key: 'all', label: 'All History' },
    ],
  },
];

const FILTER_LABELS: Record<StageFilter, string> = Object.fromEntries(
  FILTER_GROUPS.flatMap(group => group.filters.map(filter => [filter.key, filter.label])),
) as Record<StageFilter, string>;

function supplierCancelledAfterCall(order: PatientOrder) {
  return order.prescriptions.some(prescription => prescription.purchaseOrderState === 'CANCELLED' || prescription.status === 'cancelled')
    || order.curaleafCancellation?.status === 'confirmed'
    || order.unresolvedReason === 'cancelled';
}

function orderRecordPriority(record: OrderRecord) {
  const cancellationResolution = orderCancellationResolution(record.order);
  if (cancellationResolution === 'needs-action') return 0;
  if (quoteReviewIsOpen(record.order)) return 1;
  if (record.stage === 'rejected') return 2;
  if (record.stage === 'awaiting-payment') return 2;
  if (record.stage === 'ready') return 10;
  if (record.stage === 'delivered') return 20;

  const isDeliveryOrPartial = record.stage === 'dispatched' || record.order.prescriptions.some(rx =>
    rx.status === 'partially-received' || rx.dispatchStatus === 'partial' || rx.status === 'dispatched' || rx.shipmentIds?.length
  );
  if (isDeliveryOrPartial) return 30;

  const isPicking = record.stage === 'curaleaf-approved' || record.order.prescriptions.some(rx =>
    rx.purchaseOrderState === 'PROCESSING' || rx.purchaseOrderState === 'FULLY_ALLOCATED' || (rx.supplierItems ?? []).some(si => (si.packsAllocatedCount ?? 0) > 0)
  );
  if (isPicking) return 40;

  if (record.stage === 'curaleaf-pending' || record.stage === 'paid') return 50;
  if (record.stage === 'collected') return 90;
  if (cancellationResolution !== 'none' || record.stage === 'archived' || record.stage === 'cancelled') return 99;
  return 70;
}

function recordMatchesFilter(record: OrderRecord, filter: StageFilter) {
  const cancellationResolution = orderCancellationResolution(record.order);
  if (cancellationResolution !== 'none') {
    if (filter === 'current') return cancellationResolution === 'needs-action';
    if (filter === 'cancelled' || filter === 'all') return true;
    return false;
  }
  return stageMatchesFilter(record.stage, filter);
}

function recordStageMeta(record: OrderRecord) {
  const resolution = orderCancellationResolution(record.order);
  const refundDue = record.order.refund?.status === 'pending_confirmation' || record.order.cancellation?.status === 'refund_required';
  const supplierActionOutstanding = orderAwaitingCuraleafCancel(record.order)
    || ['contact_required', 'awaiting_confirmation'].includes(record.order.curaleafCancellation?.status ?? '')
    || ['curaleaf_contact_required', 'awaiting_curaleaf_confirmation'].includes(record.order.cancellation?.status ?? '');
  if (record.stage === 'cancelled' && record.order.prescriptions.some(prescription => prescription.purchaseOrderState === 'CANCELLED' || prescription.status === 'cancelled')) {
    return {
      label: resolution === 'needs-action' && refundDue && !supplierActionOutstanding ? 'Refund Due' : 'Cancelled Purchase Order',
      description: resolution === 'needs-action'
        ? refundDue && !supplierActionOutstanding
          ? 'Patient payment is still held. Refund in Worldpay or ePOS, then confirm the reference here. HHH does not move the money automatically.'
          : 'Curaleaf cancelled the supplier purchase order. Review the pharmacy call or case notes and complete the refund follow-up.'
        : 'Curaleaf cancelled the supplier purchase order; its pharmacy call or case context remains in the audit trail.',
      tone: resolution === 'needs-action' ? 'danger' : 'neutral',
      icon: resolution === 'needs-action' && refundDue && !supplierActionOutstanding ? Banknote : XCircle,
    };
  }
  if (resolution === 'needs-action' && orderAwaitingCuraleafCancel(record.order)) {
    return {
      label: 'Cancellation Pending',
      description: 'This order stays with Curaleaf until their prescription or purchase-order cancellation is observed by the platform.',
      tone: 'danger',
      icon: Clock3,
    };
  }
  if (resolution === 'needs-action' && refundDue && !supplierActionOutstanding) {
    return { label: 'Refund Due', description: 'Patient payment is still held. Refund in Worldpay or ePOS, then confirm the reference here.', tone: 'danger', icon: Banknote };
  }
  if (resolution === 'needs-action') return { label: 'Needs Action', description: 'Cancellation requires supplier or refund follow-up', tone: 'danger', icon: AlertTriangle };
  if (quoteReviewIsOpen(record.order)) {
    const review = record.order.quoteReview;
    const quoteCheck = record.order.activeQuoteCheck;
    const delta = review?.patientDeltaPence ?? quoteCheck?.patientDeltaPence ?? 0;
    const outOfStock = review?.type === 'out_of_stock' || quoteCheck?.status === 'OUT_OF_STOCK';
    return {
      label: outOfStock ? 'Stock Hold' : quoteCheck?.status === 'RECONCILIATION_REQUIRED' ? 'Reconciliation' : 'Quote Review',
      description: outOfStock
        ? 'Curaleaf reports a line out of stock. Recheck the quote; the paid order remains held until the gate clears.'
        : delta > 0
          ? 'Patient price increased after payment. Accept the difference to continue placement.'
          : delta < 0
            ? 'Patient price dropped after payment. Accept the difference and keep the patient payment unchanged.'
            : 'The paid quote could not be compared. Refresh to continue placement.',
      tone: 'warning',
      icon: AlertTriangle,
    };
  }
  if (resolution === 'refunded') return { label: 'Refunded', description: 'Cancellation closed and patient refund completed', tone: 'refunded', icon: Banknote };
  if (resolution === 'resolved') return { label: 'Resolved', description: 'Cancellation closed with no action outstanding', tone: 'resolved', icon: CheckCircle2 };
  // One stage-aware string instead of a "Split 0/10" badge plus a stage-blind
  // "Split Dispensed" pill: the card has to answer "where is this order?" without
  // being opened.
  const splitLabel = orderSplitCardLabel(record);
  const splitDescription = orderSplitCardDescription(record.order);
  if (splitLabel && splitDescription) {
    return {
      label: splitLabel,
      description: splitDescription,
      tone: 'partial',
      icon: Layers2,
    };
  }
  return STAGE_META[record.stage];
}

/**
 * The status string a lane card shows. Also the sectioning key for the exceptions lane,
 * so a section heading and the cards under it can never disagree.
 */
function recordCardTag(record: OrderRecord) {
  const meta = recordStageMeta(record);
  return orderCardTagLabel(meta === STAGE_META[record.stage] ? orderCardStageLabel(record.stage, meta.label) : meta.label);
}

function formatDate(value: Date | string | null | undefined, includeTime = false) {
  if (!value) return 'Not recorded';
  return new Date(value).toLocaleString('en-GB', includeTime
    ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatTimelineDate(value: Date | string) {
  return new Date(value).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDeliveryDate(dateKey: string) {
  return new Date(`${dateKey}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function OrderFilterControl({
  activeFilter,
  filterCount,
  onChange,
}: {
  activeFilter: StageFilter;
  filterCount: (filter: StageFilter) => number;
  onChange: (filter: StageFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeLabel = FILTER_LABELS[activeFilter];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="order-crm-filters" ref={rootRef}>
      {activeFilter !== 'current' ? (
        <button
          type="button"
          className="order-filter-chip"
          onClick={() => onChange('current')}
          aria-label={`Clear ${activeLabel} filter and show Current orders`}
        >
          <span>{activeLabel} · {filterCount(activeFilter)}</span>
          <X size={13} aria-hidden="true" />
        </button>
      ) : null}
      <div className={`order-filter-menu${open ? ' is-open' : ''}${activeFilter !== 'current' ? ' is-filtered' : ''}`}>
        <button
          type="button"
          className="order-filter-trigger"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls="order-filter-menu"
          aria-label={activeFilter === 'current' ? 'Filter orders' : `Filter orders, ${activeLabel} selected`}
          onClick={() => setOpen(current => !current)}
        >
          <ListFilter size={15} aria-hidden="true" />
          <span>Filter</span>
        </button>
        {open ? (
          <div id="order-filter-menu" role="menu" aria-label="Filter orders">
            {FILTER_GROUPS.map(group => (
              <div key={group.label} role="group" aria-label={group.label} className="order-filter-menu__group">
                <small>{group.label}</small>
                {group.filters.map(filter => (
                  <button
                    type="button"
                    role="menuitemradio"
                    key={filter.key}
                    aria-checked={activeFilter === filter.key}
                    className={activeFilter === filter.key ? 'active' : ''}
                    onClick={() => { onChange(filter.key); setOpen(false); }}
                  >
                    <span>{filter.label}</span>
                    <strong>{filterCount(filter.key)}</strong>
                  </button>
                ))}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function searchFieldsFor(record: OrderRecord, scope: OrderSearchScope): Array<string | number | null | undefined> {
  const { order, patient } = record;
  const patientFields = [patient?.name, patient?.dob, patient?.email, patient?.mobile];
  const orderFields = [order.id, order.backendId, orderReference(order)];
  const prescriptionFields = order.prescriptions.flatMap(prescription => [prescription.purchaseOrderId, prescription.serialNumber]);
  if (scope === 'patient') return patientFields;
  if (scope === 'order') return orderFields;
  if (scope === 'prescription') return prescriptionFields;
  return [...patientFields, ...orderFields, ...prescriptionFields];
}

export default function Orders() {
  const { state, dispatch } = useApp();
  const [activeFilter, setActiveFilter] = useState<StageFilter>('current');
  const [query, setQuery] = useState('');
  const [searchScope, setSearchScope] = useState<OrderSearchScope>('all');
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [selectedPrescriptionId, setSelectedPrescriptionId] = useState<number | null>(null);
  const [manualForms, setManualForms] = useState<Record<number, ManualPaymentForm>>({});
  const [submittingOrderId, setSubmittingOrderId] = useState<number | null>(null);
  const [receiptDrafts, setReceiptDrafts] = useState<Record<number, GoodsReceiptDraft>>({});
  const [paymentLinkBusyOrderId, setPaymentLinkBusyOrderId] = useState<number | null>(null);
  const [fulfilmentBusyRxId, setFulfilmentBusyRxId] = useState<number | null>(null);
  const [refundBusyOrderId, setRefundBusyOrderId] = useState<number | null>(null);
  const [quoteReviewBusyOrderId, setQuoteReviewBusyOrderId] = useState<number | null>(null);
  const [refundReferences, setRefundReferences] = useState<Record<number, string>>({});
  const [cancelOrderId, setCancelOrderId] = useState<number | null>(null);
  const [cancelNote, setCancelNote] = useState('');
  const [cancellationBusyOrderId, setCancellationBusyOrderId] = useState<number | null>(null);
  const [callCuraleafModal, setCallCuraleafModal] = useState<{ order: PatientOrder; prescriptionId: number | null; scope: 'selected' | 'order' } | null>(null);
  const [chaseDeliveryModal, setChaseDeliveryModal] = useState<{ order: PatientOrder; prescription?: Prescription; shipmentId?: string } | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [handoutOrderId, setHandoutOrderId] = useState<number | null>(null);
  const [handoutPrescriptionId, setHandoutPrescriptionId] = useState<number | null>(null);
  const [handoutPartial, setHandoutPartial] = useState(false);
  const [handoutShipmentId, setHandoutShipmentId] = useState<string | undefined>(undefined);
  const [handoutBusy, setHandoutBusy] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [placementConfirmation, setPlacementConfirmation] = useState<{ orderId: number; message: string } | null>(null);
  const observedPlacements = useRef<Map<number, Set<number>> | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (cancelOrderId === null) return;
    const order = state.orders.find(candidate => candidate.id === cancelOrderId);
    if (order && orderPaymentAllowsManualCancellation(order)) return;
    setCancelOrderId(null);
    setCancelNote('');
  }, [cancelOrderId, state.orders]);

  useEffect(() => {
    const current = new Map(state.orders.map(order => [order.id, new Set(order.prescriptions.filter(prescription => prescription.placed).map(prescription => prescription.id))]));
    if (!observedPlacements.current) {
      observedPlacements.current = current;
      return;
    }
    for (const order of state.orders) {
      const previous = observedPlacements.current.get(order.id);
      if (!previous) continue;
      const newlyPlaced = order.prescriptions.filter(prescription => prescription.placed && !previous.has(prescription.id));
      const placement = newlyPlaced.find(prescription => prescription.placedAt)?.placedAt;
      const guidance = placement ? curaleafDeliveryGuidance(placement) : null;
      if (guidance) {
        const message = `Order placed with Curaleaf ✓ Expected at the pharmacy ${formatDeliveryDate(guidance.windowStart)} – ${formatDeliveryDate(guidance.windowEnd)}. We'll tell the patient it's ready only once your team books it in — no action needed until it arrives.`;
        setPlacementConfirmation({ orderId: order.id, message });
      }
    }
    observedPlacements.current = current;
  }, [state.orders]);

  useEffect(() => {
    if (!placementConfirmation) return;
    const timer = window.setTimeout(() => setPlacementConfirmation(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [placementConfirmation]);

  const records = useMemo<OrderRecord[]>(() => state.orders
    .filter(order => order.organisationId === state.currentOrganisationId && order.payment.status !== 'none')
    .map(order => {
      const patient = order.patientId
        ? state.crm.find(candidate => candidate.organisationId === state.currentOrganisationId && candidate.id === order.patientId) ?? null
        : null;
      const resolvedStage = orderStage(order);
      return { order, patient, ...resolvedStage };
    })
    .sort((left, right) => {
      const priorityDifference = orderRecordPriority(left) - orderRecordPriority(right);
      return priorityDifference || right.order.date.getTime() - left.order.date.getTime();
    }), [state.crm, state.currentOrganisationId, state.orders]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return records.filter(record => {
      if (!recordMatchesFilter(record, activeFilter)) return false;
      if (!needle) return true;
      return searchFieldsFor(record, searchScope).filter(Boolean).join(' ').toLowerCase().includes(needle);
    });
  }, [activeFilter, query, records, searchScope]);

  // The board is the view and the dialog is opt-in, so nothing is auto-selected;
  // a selection only clears when that order leaves the current filter.
  useEffect(() => {
    if (selectedOrderId !== null && !filtered.some(record => record.order.id === selectedOrderId)) {
      setSelectedOrderId(null);
    }
  }, [filtered, selectedOrderId]);



  useEffect(() => {
    const target = state.navigationTarget;
    if (target?.kind !== 'order') return;
    const orderId = Number(target.key.split('-')[0]);
    const targetRecord = records.find(record => record.order.id === orderId);
    if (targetRecord) {
      setActiveFilter(['resolved', 'refunded'].includes(orderCancellationResolution(targetRecord.order)) ? 'cancelled' : 'current');
      setQuery('');
      setSelectedOrderId(orderId);
      setSelectedPrescriptionId(null);
    }
    dispatch({ type: 'CLEAR_NAVIGATION_TARGET' });
  }, [dispatch, records, state.navigationTarget]);

  const closeOrderRecord = () => {
    setSelectedOrderId(null);
    setSelectedPrescriptionId(null);
  };

  const selected = selectedOrderId === null ? null : filtered.find(record => record.order.id === selectedOrderId) ?? null;
  const outstandingValue = records.filter(record => orderCancellationResolution(record.order) === 'none' && record.stage === 'awaiting-payment').reduce((sum, record) => sum + record.order.payment.amount, 0);
  // Counted over the same live set the board shows, with the same lane function the
  // columns use, so a tile can never disagree with the column it describes.
  const liveRecords = records.filter(record => recordMatchesFilter(record, 'current'));
  const liveWorkItems = liveRecords.flatMap(record => buildPrescriptionWorkItems(record)).filter(prescriptionWorkItemIsLive);
  const filteredWorkItems = filtered.flatMap(record => buildPrescriptionWorkItems(record)).filter(prescriptionWorkItemIsLive);
  const liveLaneCount = (lane: OrderBoardLane) => liveWorkItems.filter(item => orderBoardLane(item.record) === lane).length;
  const activeCount = liveRecords.length;
  const activePrescriptionCount = liveWorkItems.filter(item => item.prescription).length;

  const filterCount = (filter: StageFilter) => records.filter(record => recordMatchesFilter(record, filter)).length;
  const cancellationNeedsAction = activeFilter === 'cancelled' ? filtered.filter(record => orderCancellationResolution(record.order) === 'needs-action') : [];
  const cancellationClosed = activeFilter === 'cancelled' ? filtered.filter(record => ['resolved', 'refunded'].includes(orderCancellationResolution(record.order))) : [];

  // Payment is one order-level work item. After payment, each prescription/PO gets its
  // own work item, so mixed orders can truthfully occupy more than one operational lane.
  const boardLanes = activeFilter === 'current'
    ? ORDER_BOARD_LANES
      .map(lane => {
        const items = filteredWorkItems
          .filter(item => orderBoardLane(item.record) === lane.key)
          .sort((left, right) => (lane.key === 'needs-action'
            ? orderRecordPriority(left.record) - orderRecordPriority(right.record)
            : orderLaneRank(left.record) - orderLaneRank(right.record)));
        // Sub-sections in the lane's own sort order. A lane with one section renders
        // flat — a heading that names the column it already sits in is noise.
        const sections: Array<{ key: string; label: string; rank: number; items: PrescriptionWorkItem[] }> = [];
        for (const item of items) {
          const section = orderBoardSection(item.record, lane.key, recordCardTag(item.record));
          const existing = sections.find(entry => entry.key === section.key);
          if (existing) existing.items.push(item);
          else sections.push({ ...section, items: [item] });
        }
        // Stable by first appearance, then by the section's own rank so earlier
        // pipeline waits sit above later ones inside the same lane.
        sections.sort((left, right) => left.rank - right.rank);
        return { ...lane, items, sections };
      })
      .filter(lane => lane.items.length > 0)
    : [];

  const applyCancellationResponse = (order: PatientOrder, record: Awaited<ReturnType<typeof requestPortalOrderCancellation>>) => {
    const moneyStillHeld = Boolean(order.payment.paidAt) && record.refund?.status !== 'completed' && record.paymentStatus !== 'refunded';
    const paymentStatus: PaymentStatus = ['paid', 'refund_required', 'refunded'].includes(record.paymentStatus) || (moneyStillHeld && record.paymentStatus === 'cancelled')
      ? 'paid'
      : record.paymentStatus === 'cancelled'
        ? 'cancelled'
        : 'sent';
    if (record.cancellation) {
      dispatch({
        type: 'SET_ORDER_CANCELLATION',
        orderId: order.id,
        cancellation: record.cancellation,
        curaleafCancellation: record.curaleafCancellation,
        lifecycleStatus: record.status,
        paymentStatus,
      });
    }
    dispatch({
      type: 'SET_QUOTE_REVIEW',
      orderId: order.id,
      quoteReview: record.quoteReview,
      refund: record.refund,
    });
  };

  const requestCancellation = async (order: PatientOrder) => {
    if (cancellationBusyOrderId) return;
    setCancellationBusyOrderId(order.id);
    try {
      if (!isLocalPortalPreview && isOpenPharmacyWorkspace(state.workspaceMode) && order.backendId) {
        const result = await requestPortalOrderCancellation(order.backendId, {
          organisationId: state.currentOrganisationId,
          reason: 'other',
          note: cancelNote.trim() || undefined,
        });
        applyCancellationResponse(order, result);
      } else {
        dispatch({ type: 'REQUEST_ORDER_CANCELLATION', orderId: order.id, reason: 'other', note: cancelNote.trim() || undefined });
      }
      if (order.patientId) dispatch({ type: 'LOG_INTERACTION', patientId: order.patientId, interactionType: 'Order cancellation requested', detail: `Cancellation requested for ${orderReference(order)}. ${order.payment.status === 'paid' ? 'Paid order requires pharmacy action.' : 'No settled patient payment recorded.'}` });
      const hasCuraleafOrder = orderRequiresCuraleafCancel(order);
      dispatch({ type: 'ADD_TOAST', message: hasCuraleafOrder ? 'Cancellation opened. Contact Curaleaf and record their confirmation before refunding or reordering.' : order.payment.status === 'paid' ? 'Paid cancellation flagged for pharmacy refund action.' : unpaidCancellationConfirmation(order.payment.route), toastType: hasCuraleafOrder || order.payment.status === 'paid' ? 'warning' : 'success' });
      setCancelOrderId(null);
      setCancelNote('');
    } catch (error) {
      dispatch({ type: 'ADD_TOAST', message: error instanceof Error ? error.message : 'The cancellation could not be recorded.', toastType: 'error' });
    } finally { setCancellationBusyOrderId(null); }
  };

  const handleQuoteReviewResolve = async (order: PatientOrder, action: 'absorb' | 'refresh') => {
    if (quoteReviewBusyOrderId) return;
    const trainingLocal = isLocalPortalPreview || !isOpenPharmacyWorkspace(state.workspaceMode) || !order.backendId;
    if (trainingLocal) {
      const review = order.quoteReview;
      if (action === 'refresh') {
        dispatch({ type: 'ADD_TOAST', message: `Quote still needs review for ${orderReference(order)}.`, toastType: 'warning' });
        return;
      }
      dispatch({
        type: 'SET_QUOTE_REVIEW',
        orderId: order.id,
        quoteReview: review
          ? { ...review, status: 'approved', approvedAt: new Date().toISOString(), approvalNote: 'Pharmacy absorbed the difference; patient payment unchanged.' }
          : undefined,
        dispensingFee: order.dispensingFee,
      });
      dispatch({
        type: 'ADD_TOAST',
        message: `Price change absorbed for ${orderReference(order)}. The patient payment is unchanged and placement will continue.`,
        toastType: 'success',
      });
      return;
    }
    setQuoteReviewBusyOrderId(order.id);
    try {
      const result = await resolvePortalQuoteReview(order.backendId!, {
        organisationId: state.currentOrganisationId,
        action,
      });
      dispatch({
        type: 'SET_QUOTE_REVIEW',
        orderId: order.id,
        quoteReview: result.order.quoteReview,
        refund: result.order.refund,
        resolution: result.order.resolution ?? undefined,
        dispensingFee: result.order.dispensingFeePence / 100,
      });
      const messages: Record<typeof action, string> = {
        absorb: `Price change absorbed for ${orderReference(order)}. Placement will continue.`,
        refresh: result.order.quoteReview && ['required', 'awaiting_top_up', 'awaiting_refund'].includes(result.order.quoteReview.status)
          ? `Quote still needs review for ${orderReference(order)}.`
          : `Quote rechecked for ${orderReference(order)}. Placement can continue.`,
      };
      dispatch({ type: 'ADD_TOAST', message: messages[action], toastType: action === 'refresh' && result.order.quoteReview?.status === 'required' ? 'warning' : 'success' });
    } catch (error) {
      dispatch({ type: 'ADD_TOAST', message: error instanceof Error ? error.message : 'The quote review could not be updated.', toastType: 'error' });
    } finally {
      setQuoteReviewBusyOrderId(null);
    }
  };

  const requestRefund = async (order: PatientOrder) => {
    if (order.refund || refundBusyOrderId) return;
    setRefundBusyOrderId(order.id);
    try {
      if (!isLocalPortalPreview && isOpenPharmacyWorkspace(state.workspaceMode) && order.backendId) {
        const refund = await createPortalOrderRefund(order.backendId, { organisationId: state.currentOrganisationId, reason: 'patient_cancelled', resolution: 'cancel' });
        dispatch({ type: 'SET_ORDER_REFUND', orderId: order.id, refund });
      } else {
        dispatch({ type: 'START_ORDER_REFUND', orderId: order.id, reason: 'patient_cancelled', resolution: 'cancel' });
      }
      dispatch({ type: 'ADD_TOAST', message: `Refund task created for ${orderReference(order)}. Complete it in ${order.payment.route === 'worldpay' ? 'Worldpay' : 'the pharmacy payment system'}, then record the confirmation.`, toastType: 'warning' });
    } catch (error) {
      dispatch({ type: 'ADD_TOAST', message: error instanceof Error ? error.message : 'The refund task could not be created.', toastType: 'error' });
    } finally { setRefundBusyOrderId(null); }
  };

  const confirmRefund = async (order: PatientOrder) => {
    const externalReference = refundReferences[order.id]?.trim();
    if (!order.refund || !externalReference || refundBusyOrderId) return;
    setRefundBusyOrderId(order.id);
    try {
      let recordedStatus: NonNullable<PatientOrder['refund']>['status'] = 'completed';
      if (!isLocalPortalPreview && isOpenPharmacyWorkspace(state.workspaceMode) && order.backendId) {
        const refund = await confirmPortalOrderRefund(order.backendId, order.refund.id, { organisationId: state.currentOrganisationId, externalReference });
        recordedStatus = refund.status;
        dispatch({ type: 'SET_ORDER_REFUND', orderId: order.id, refund });
        if (order.quoteReview) {
          dispatch({
            type: 'SET_QUOTE_REVIEW',
            orderId: order.id,
            quoteReview: undefined,
            refund,
          });
        }
      } else {
        dispatch({ type: 'CONFIRM_ORDER_REFUND', orderId: order.id, externalReference });
      }
      dispatch({
        type: 'ADD_TOAST',
        message: recordedStatus === 'completed'
          ? `Refund verified for ${orderReference(order)}.`
          : recordedStatus === 'reconciliation_required'
            ? `Refund reference recorded for ${orderReference(order)}, but finance reconciliation is required.`
            : `Refund reference recorded for ${orderReference(order)} and is being verified.`,
        toastType: recordedStatus === 'completed' ? 'success' : 'warning',
      });
    } catch (error) {
      dispatch({ type: 'ADD_TOAST', message: error instanceof Error ? error.message : 'The refund could not be confirmed.', toastType: 'error' });
    } finally { setRefundBusyOrderId(null); }
  };
  const updateManualForm = (orderId: number, patch: Partial<ManualPaymentForm>) => setManualForms(current => ({
    ...current,
    [orderId]: { ...(current[orderId] ?? DEFAULT_MANUAL_FORM), ...patch },
  }));
  const receiptDraftFor = (prescription: Prescription): GoodsReceiptDraft => receiptDrafts[prescription.id] ?? {
    quantities: Object.fromEntries(prescription.items.map(item => [
      item.productId,
      prescription.receivedItems?.find(received => received.productId === item.productId)?.quantityReceived ?? 0,
    ])),
    batches: Object.fromEntries(prescription.items.map(item => [item.productId, ''])),
    expiries: Object.fromEntries(prescription.items.map(item => [item.productId, ''])),
    note: prescription.goodsInNote ?? '',
  };
  const updateReceiptDraft = (prescription: Prescription, patch: Partial<GoodsReceiptDraft>) => setReceiptDrafts(current => ({
    ...current,
    [prescription.id]: { ...receiptDraftFor(prescription), ...current[prescription.id], ...patch },
  }));

  const handleRecordManualPayment = async (order: PatientOrder) => {
    const form = manualForms[order.id] ?? DEFAULT_MANUAL_FORM;
    if (!form.confirmed) return;
    setSubmittingOrderId(order.id);
    try {
      if (!isLocalPortalPreview && isOpenPharmacyWorkspace(state.workspaceMode)) {
        if (!order.backendId) throw new Error('This order has not finished saving. Refresh and try again.');
        if (!form.reference.trim()) throw new Error('Enter the pharmacy receipt reference before recording a live payment.');
        const tender = ({ 'epos-card': 'epos', cash: 'cash', 'bank-transfer': 'bank_transfer', other: 'other' } as const)[form.tender];
        await recordPortalManualPayment(order.backendId, {
          organisationId: state.currentOrganisationId,
          amountPence: Math.round(order.payment.amount * 100),
          tender,
          reference: form.reference.trim(),
          notes: form.notes.trim() || undefined,
        });
        dispatch({ type: 'RECORD_MANUAL_PAYMENT', orderId: order.id, tender: form.tender, reference: form.reference, notes: form.notes });
        dispatch({ type: 'ADD_TOAST', message: 'Payment recorded. Order processing will continue.', toastType: 'success' });
      } else {
        dispatch({ type: 'RECORD_MANUAL_PAYMENT', orderId: order.id, tender: form.tender, reference: form.reference, notes: form.notes });
        dispatch({ type: 'ADD_TOAST', message: 'Training payment recorded locally.', toastType: 'info' });
      }
    } catch (error) {
      dispatch({ type: 'ADD_TOAST', message: error instanceof Error ? error.message : 'Payment could not be recorded.', toastType: 'error' });
    } finally {
      setSubmittingOrderId(null);
    }
  };

  const handleGoodsReceipt = async (order: PatientOrder, prescription: Prescription, complete: boolean, shipmentId?: string) => {
    const draft = receiptDraftFor(prescription);
    const selectedConsignment = (shipmentId ?? prescription.shipmentId ?? prescription.shipmentIds?.[0])
      ? prescription.shipments?.find(shipment => shipment.id === (shipmentId ?? prescription.shipmentId ?? prescription.shipmentIds?.[0]))
      : prescription.shipments?.[0];
    const consignmentPacksFor = (productId: string) => {
      const fromShipment = selectedConsignment?.items?.filter(item => item.productId === productId).reduce((sum, item) => sum + Number(item.packCount || 0), 0) ?? 0;
      if (fromShipment > 0) return fromShipment;
      return prescription.fulfilmentLines?.find(line => line.productId === productId)?.shipped ?? 0;
    };
    const lines = prescription.items.map(item => {
      const shipped = consignmentPacksFor(item.productId);
      const accepted = complete ? shipped : Math.max(0, Math.min(shipped || item.qty, Math.floor(draft.quantities[item.productId] ?? 0)));
      return {
        productId: item.productId,
        quantityReceived: accepted,
      };
    });
    const anyReceived = lines.some(line => line.quantityReceived > 0);
    const consignmentTotal = prescription.items.reduce((sum, item) => sum + consignmentPacksFor(item.productId), 0);
    const allConsignmentReceived = consignmentTotal > 0 && prescription.items.every(item =>
      (lines.find(line => line.productId === item.productId)?.quantityReceived ?? 0) >= consignmentPacksFor(item.productId),
    );
    if (!complete && !anyReceived) {
      dispatch({ type: 'ADD_TOAST', message: 'Enter at least one received pack before saving a partial delivery.', toastType: 'warning' });
      return;
    }
    if (!complete && allConsignmentReceived) {
      dispatch({ type: 'ADD_TOAST', message: 'All arriving packs are present. Use Accept Delivery instead.', toastType: 'info' });
      return;
    }
    setFulfilmentBusyRxId(prescription.id);
    try {
      if (!isLocalPortalPreview && isOpenPharmacyWorkspace(state.workspaceMode)) {
        const targetShipmentId = shipmentId ?? prescription.shipmentId ?? prescription.shipmentIds?.[0];
        if (!targetShipmentId || !order.backendId) {
          throw new Error('This consignment is not linked to the order yet. Refresh and try again.');
        }
        await recordPortalGoodsReceipt(targetShipmentId, {
          organisationId: state.currentOrganisationId,
          orderId: order.backendId,
          items: prescription.items.map(item => ({
            productId: item.productId,
            expectedQuantity: consignmentPacksFor(item.productId),
            receivedQuantity: lines.find(line => line.productId === item.productId)?.quantityReceived ?? 0,
            batchNumber: null,
            expiryDate: null,
            issue: 'none',
          })),
        });
      }
      dispatch({ type: 'RECORD_GOODS_RECEIPT', orderId: order.id, rxId: prescription.id, lines, note: draft.note });
      // Check-in is the ready-to-collect decision — there is no second button. The
      // server queues the patient email from the same goods-receipt call; this keeps
      // the training workspace, which has no server, on the identical flow.
      if (anyReceived) dispatch({ type: 'MARK_READY_FOR_COLLECTION', orderId: order.id, rxId: prescription.id, shipmentId: shipmentId ?? prescription.shipmentId ?? prescription.shipmentIds?.[0] });
      setReceiptDrafts(current => ({ ...current, [prescription.id]: { ...draft, quantities: Object.fromEntries(lines.map(line => [line.productId, line.quantityReceived])), note: draft.note } }));
      const notice = collectionEmailNotice(new Date());
      dispatch({
        type: 'ADD_TOAST',
        message: `${complete ? 'Consignment checked in' : 'Partial check-in saved'}. ${notice.summary}.`,
        toastType: 'success',
      });
    } catch (error) {
      dispatch({ type: 'ADD_TOAST', message: error instanceof Error ? error.message : 'The delivery receipt could not be saved.', toastType: 'error' });
    } finally {
      setFulfilmentBusyRxId(null);
    }
  };

  const handleOrderHandout = async (order: PatientOrder, prescriptionId: number | null, partial = false, shipmentId?: string) => {
    if (handoutBusy) return;
    const targetPrescription = prescriptionId === null ? null : order.prescriptions.find(prescription => prescription.id === prescriptionId) ?? null;
    const prescriptionScoped = Boolean(targetPrescription && order.prescriptions.length > 1);
    const effectivePartial = partial || prescriptionScoped;
    // Supply completeness and collection are separate questions: packs already on the
    // dispensary shelf must never look like stock the supplier still owes.
    const supplyIncomplete = targetPrescription ? prescriptionSupplyIncomplete(targetPrescription) : orderSupplyIncomplete(order);
    if (!effectivePartial && supplyIncomplete) {
      dispatch({ type: 'ADD_TOAST', message: 'Remaining packs are still awaiting dispatch. Use partial handover for arrived packs only.', toastType: 'warning' });
      return;
    }
    setHandoutBusy(true);
    try {
      if (!isLocalPortalPreview && isOpenPharmacyWorkspace(state.workspaceMode)) {
        if (!order.backendId) throw new Error('This order has not finished saving. Refresh and try again.');
        await handoutPortalOrder(order.backendId, {
          organisationId: state.currentOrganisationId,
          partial: effectivePartial,
          shipmentId,
          prescriptionId: targetPrescription?.backendId,
        });
      }
      dispatch({ type: 'HANDOUT_ORDER', orderId: order.id, rxId: targetPrescription?.id, partial: effectivePartial, shipmentId });
      dispatch({
        type: 'ADD_TOAST',
        message: effectivePartial
          ? `${targetPrescription ? 'Prescription handover' : 'Partial handover'} recorded. Other active prescriptions and remaining packs stay open.`
          : 'Handover recorded. The order is now completed.',
        toastType: 'success',
      });
      setHandoutOrderId(null);
      setHandoutPrescriptionId(null);
      if (!effectivePartial && !supplyIncomplete) setActiveFilter('completed');
    } catch (error) {
      dispatch({ type: 'ADD_TOAST', message: error instanceof Error ? error.message : 'The handover could not be recorded.', toastType: 'error' });
    } finally {
      setHandoutBusy(false);
    }
  };

  const handlePaymentLinkResend = async (order: PatientOrder) => {
    if (isLocalPortalPreview || !isOpenPharmacyWorkspace(state.workspaceMode) || !order.backendId || paymentLinkBusyOrderId) return;
    setPaymentLinkBusyOrderId(order.id);
    try {
      const session = await resendWorldpayPaymentLink(order.backendId, { organisationId: state.currentOrganisationId });
      const provider = session.provider as { url?: string; _links?: { redirect?: { href?: string } } };
      const paymentUrl = provider.url ?? provider._links?.redirect?.href;
      if (paymentUrl) await navigator.clipboard.writeText(paymentUrl).catch(() => undefined);
      dispatch({ type: 'ADD_TOAST', message: paymentUrl ? 'The old link was voided; the fresh 72-hour link was copied.' : 'The old link was voided and a fresh payment generation was issued.', toastType: 'success' });
    } catch (error) {
      dispatch({ type: 'ADD_TOAST', message: error instanceof Error ? error.message : 'The payment link could not be reissued.', toastType: 'error' });
    } finally { setPaymentLinkBusyOrderId(null); }
  };

  const handleManualPlace = async (order: PatientOrder, prescription: Prescription) => {
    if (isLocalPortalPreview || !isOpenPharmacyWorkspace(state.workspaceMode) || !order.backendId || !prescription.backendId) return;
    setFulfilmentBusyRxId(prescription.id);
    try {
      await placePrescriptionManually(order.backendId, prescription.backendId, state.currentOrganisationId);
      dispatch({ type: 'ADD_TOAST', message: 'Manual placement was requested and recorded in the audit trail.', toastType: 'success' });
    } catch (error) {
      dispatch({ type: 'ADD_TOAST', message: error instanceof Error ? error.message : 'The prescription could not be placed.', toastType: 'error' });
    } finally { setFulfilmentBusyRxId(null); }
  };

  // Tiles speak the lane language and only appear when they have something to report,
  // so an empty queue costs no screen space instead of showing a decorative zero.
  const tiles = [
    { key: 'needs-action', label: 'Needs action', value: String(liveLaneCount('needs-action')), icon: AlertTriangle, tone: 'warning', show: liveLaneCount('needs-action') > 0 },
    { key: 'outstanding', label: 'Awaiting payment', value: money(outstandingValue), icon: CreditCard, tone: 'warning', show: liveLaneCount('awaiting-payment') > 0 },
    { key: 'in-fulfilment', label: 'In fulfilment', value: String(liveLaneCount('curaleaf')), icon: Package, tone: 'primary', show: liveLaneCount('curaleaf') > 0 },
    { key: 'split', label: 'Split delivery', value: String(liveLaneCount('split')), icon: Layers2, tone: 'primary', show: liveLaneCount('split') > 0 },
    { key: 'ready', label: 'Ready to collect', value: String(liveLaneCount('ready')), icon: PackageCheck, tone: 'success', show: liveLaneCount('ready') > 0 },
  ].filter(tile => tile.show);
  const callModalPrescriptions = callCuraleafModal
    ? callCuraleafModal.scope === 'selected' && callCuraleafModal.prescriptionId !== null
      ? callCuraleafModal.order.prescriptions.filter(prescription => prescription.id === callCuraleafModal.prescriptionId)
      : callCuraleafModal.order.prescriptions
    : [];

  return (
    <div className="page-body order-crm" data-tour="orders-board">
      {/* One tile per lane that currently holds work, plus the money still outstanding.
          Label and number only — the lane headings below carry the explanation. */}
      <section className="order-crm-summary order-crm-summary--compact" aria-label="Order pipeline summary">
        <p className="order-crm-summary__total">
          <strong>{activeCount}</strong> live order{activeCount === 1 ? '' : 's'}
          {activePrescriptionCount ? <span> · {activePrescriptionCount} prescription work item{activePrescriptionCount === 1 ? '' : 's'}</span> : null}
        </p>
        {tiles.length ? (
          <div className="order-crm-summary__tiles">
            {tiles.map(tile => (
              <SummaryMetric key={tile.key} label={tile.label} value={tile.value} icon={tile.icon} tone={tile.tone} />
            ))}
          </div>
        ) : null}
      </section>

      <section className="order-crm-controls">
        <div className="order-crm-search">
          <Search size={15} />
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={searchScope === 'all' ? 'Search patient, order, prescription or PO reference' : `Search ${ORDER_SEARCH_SCOPES.find(scope => scope.key === searchScope)?.label.toLowerCase()}`}
            aria-label="Search orders"
          />
        </div>
        {/* The scope pills are a refinement of a search in progress, not permanent
            chrome. Searching defaults to every field, so they only appear once
            there is something to narrow. */}
        {query.trim() ? (
        <div className="order-search-scope" role="group" aria-label="Search field">
          {ORDER_SEARCH_SCOPES.map(scope => (
            <button
              type="button"
              key={scope.key}
              aria-pressed={searchScope === scope.key}
              className={searchScope === scope.key ? 'is-on' : ''}
              onClick={() => setSearchScope(scope.key)}
            >
              {scope.label}
            </button>
          ))}
        </div>
        ) : null}
        <OrderFilterControl activeFilter={activeFilter} filterCount={filterCount} onChange={setActiveFilter} />
      </section>

      {filtered.length ? (
        activeFilter === 'current' ? (
          <div className={`crm-lane-board crm-lane-board--count-${boardLanes.length}`}>
            {boardLanes.map(lane => (
              <section className={`crm-lane crm-lane--${lane.key}`} key={lane.key} aria-label={`${lane.label}, ${lane.items.length} work item${lane.items.length === 1 ? '' : 's'}`}>
                <header className="crm-lane__header" title={lane.detail}>
                  <span><strong>{lane.label}</strong></span>
                  <b>{lane.items.length}</b>
                </header>
                <div className="crm-lane__rows">
                  {lane.sections.length > 1
                    ? lane.sections.map(section => (
                      <div className="crm-lane__section" key={section.key} role="group" aria-label={`${section.label}, ${section.items.length} work item${section.items.length === 1 ? '' : 's'}`}>
                        <h3><span>{section.label}</span><b>{section.items.length}</b></h3>
                        {section.items.map(item => (
                          <OrderListRow key={item.key} item={item} selected={selectedOrderId === item.sourceOrder.id && selectedPrescriptionId === (item.prescription?.id ?? null)} now={now} laneLabel={lane.label} sectionKey={section.key} onSelect={() => { setSelectedOrderId(item.sourceOrder.id); setSelectedPrescriptionId(item.prescription?.id ?? null); }} />
                        ))}
                      </div>
                    ))
                    : lane.items.map(item => (
                      <OrderListRow key={item.key} item={item} selected={selectedOrderId === item.sourceOrder.id && selectedPrescriptionId === (item.prescription?.id ?? null)} now={now} laneLabel={lane.label} onSelect={() => { setSelectedOrderId(item.sourceOrder.id); setSelectedPrescriptionId(item.prescription?.id ?? null); }} />
                    ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <div className={`crm-lane-board${activeFilter === 'cancelled' ? '' : ' crm-lane-board--single'}`}>
            {(activeFilter === 'cancelled'
              ? [
                { key: 'needs-action', label: 'Needs action', detail: 'Supplier or refund follow-up', records: cancellationNeedsAction },
                { key: 'resolved', label: 'Resolved & refunded', detail: 'Closed order history', records: cancellationClosed },
              ].filter(lane => lane.records.length > 0)
              : [{ key: 'all', label: FILTER_LABELS[activeFilter], detail: `${filtered.length} result${filtered.length === 1 ? '' : 's'}`, records: filtered }]
            ).map(lane => (
              <section className={`crm-lane crm-lane--${lane.key}`} key={lane.key} aria-label={`${lane.label}, ${lane.records.length} order${lane.records.length === 1 ? '' : 's'}`}>
                <header className="crm-lane__header" title={lane.detail}>
                  <span><strong>{lane.label}</strong></span>
                  <b>{lane.records.length}</b>
                </header>
                <div className="crm-lane__rows">
                  {lane.records.map(record => (
                    <OrderListRow key={record.order.id} item={buildPrescriptionWorkItems(record)[0]!} selected={selectedOrderId === record.order.id} now={now} laneLabel={lane.label} onSelect={() => { setSelectedOrderId(record.order.id); setSelectedPrescriptionId(null); }} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )
      ) : <div className="order-crm-empty"><Package size={26} /><strong>No orders in this stage</strong><span>Try another filter or search term.</span></div>}

      {selected ? (
        <RecordDialog label={`Order ${orderReference(selected.order)}`} onClose={closeOrderRecord}>
          <OrderDetail
              key={selected.order.id}
              record={selected}
              selectedPrescriptionId={selectedPrescriptionId}
              onSelectPrescription={setSelectedPrescriptionId}
              now={now}
              placementConfirmation={placementConfirmation?.orderId === selected.order.id ? placementConfirmation.message : null}
              handoutBusy={handoutBusy}
              onOpenHandout={(prescription, partial, shipmentId) => {
                setHandoutPartial(partial);
                setHandoutShipmentId(shipmentId);
                setHandoutPrescriptionId(prescription.id);
                setHandoutOrderId(selected.order.id);
              }}
              manualForm={manualForms[selected.order.id] ?? DEFAULT_MANUAL_FORM}
              onManualFormChange={patch => updateManualForm(selected.order.id, patch)}
              onRecordManual={() => void handleRecordManualPayment(selected.order)}
              onRedo={() => {
                const existingDraft = state.orders.find(order => order.organisationId === state.currentOrganisationId
                  && order.payment.status === 'none'
                  && order.redoContext?.originalOrderId === selected.order.id
                  && order.redoContext?.originalPrescriptionId === (selectedPrescriptionId ?? undefined));
                dispatch({ type: 'START_REDO_ORDER', sourceOrderId: selected.order.id, prescriptionId: selectedPrescriptionId ?? undefined });
                dispatch({ type: 'ADD_TOAST', message: existingDraft ? `Opened existing replacement ${orderReference(existingDraft)}.` : `Started a replacement draft for ${orderReference(selected.order)}.`, toastType: 'info' });
              }}
              busy={submittingOrderId === selected.order.id}
              receiptDrafts={receiptDrafts}
              fulfilmentBusyRxId={fulfilmentBusyRxId}
              onReceiptDraftChange={updateReceiptDraft}
              onSavePartial={(prescription, shipmentId) => void handleGoodsReceipt(selected.order, prescription, false, shipmentId)}
              onConfirmDelivery={(prescription, shipmentId) => void handleGoodsReceipt(selected.order, prescription, true, shipmentId)}
              onCallCuraleaf={prescription => setCallCuraleafModal({ order: selected.order, prescriptionId: prescription?.id ?? null, scope: prescription ? 'selected' : 'order' })}
              onManualPlace={prescription => void handleManualPlace(selected.order, prescription)}
              onPaymentLinkResend={() => void handlePaymentLinkResend(selected.order)}
              paymentLinkBusy={paymentLinkBusyOrderId === selected.order.id}
              refundReference={refundReferences[selected.order.id] ?? ''}
              onRefundReferenceChange={value => setRefundReferences(current => ({ ...current, [selected.order.id]: value }))}
              onRequestRefund={() => void requestRefund(selected.order)}
              onConfirmRefund={() => void confirmRefund(selected.order)}
              refundBusy={refundBusyOrderId === selected.order.id}
              quoteReviewBusy={quoteReviewBusyOrderId === selected.order.id}
              onQuoteReviewResolve={action => void handleQuoteReviewResolve(selected.order, action)}
              cancellationEditorOpen={cancelOrderId === selected.order.id}
              cancellationNote={cancelNote}
              cancellationBusy={cancellationBusyOrderId === selected.order.id}
              onOpenCancellation={() => { setCancelOrderId(selected.order.id); setCancelNote(''); }}
              onCloseCancellation={() => { setCancelOrderId(null); setCancelNote(''); }}
              onCancellationNoteChange={setCancelNote}
              onRequestCancellation={() => void requestCancellation(selected.order)}
              onChaseDelivery={(prescription, shipmentId) => setChaseDeliveryModal({ order: selected.order, prescription, shipmentId })}
            />
        </RecordDialog>
      ) : null}
      {chaseDeliveryModal ? (
        <div className="order-handout-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setChaseDeliveryModal(null); }}>
          <section className="curaleaf-call-modal" role="dialog" aria-modal="true" aria-labelledby="chase-curaleaf-title">
            <header className="curaleaf-call-modal__header">
              <div className="curaleaf-call-modal__header-left">
                <span className="curaleaf-call-modal__icon-pill"><PhoneCall size={20} /></span>
                <div className="curaleaf-call-modal__header-titles">
                  <span className="curaleaf-call-modal__eyebrow">Delivery & Transit Support</span>
                  <h2 id="chase-curaleaf-title" className="curaleaf-call-modal__title">Chase Delivery / Report Issue with Curaleaf</h2>
                </div>
              </div>
              <button type="button" className="curaleaf-call-modal__close" onClick={() => setChaseDeliveryModal(null)} aria-label="Close">
                <X size={18} />
              </button>
            </header>

            <p className="curaleaf-call-modal__desc">
              Contact Curaleaf Customer Services to chase this dispatched consignment or report transit discrepancies (short shipment, damaged packaging, or missing items):
            </p>

            <div className="curaleaf-call-modal__phone-card">
              <div className="curaleaf-call-modal__phone-info">
                <span className="curaleaf-call-modal__phone-label">Curaleaf Dispatch & Pharmacy Support</span>
                <strong className="curaleaf-call-modal__phone-number">0113 873 0000</strong>
              </div>
              <a href="tel:01138730000" className="curaleaf-call-modal__call-btn">
                <Phone size={13} /> Call now
              </a>
            </div>

            <div className="curaleaf-call-modal__refs-card">
              <div className="curaleaf-call-modal__ref-item">
                <span className="curaleaf-call-modal__ref-label">PO Reference</span>
                <div className="curaleaf-call-modal__ref-value-row">
                  <code className="curaleaf-call-modal__ref-code">
                    {chaseDeliveryModal.prescription?.purchaseOrderId ?? chaseDeliveryModal.order.prescriptions.find(p => p.purchaseOrderId)?.purchaseOrderId ?? 'No Curaleaf PO created'}
                  </code>
                  <button
                    type="button"
                    className={`curaleaf-call-modal__copy-btn${copiedKey === 'chasePoRef' ? ' curaleaf-call-modal__copy-btn--copied' : ''}`}
                    disabled={!chaseDeliveryModal.prescription?.purchaseOrderId && !chaseDeliveryModal.order.prescriptions.some(p => p.purchaseOrderId)}
                    onClick={() => {
                      const ref = chaseDeliveryModal.prescription?.purchaseOrderId ?? chaseDeliveryModal.order.prescriptions.find(p => p.purchaseOrderId)?.purchaseOrderId;
                      if (!ref) return;
                      void navigator.clipboard.writeText(String(ref));
                      setCopiedKey('chasePoRef');
                      window.setTimeout(() => setCopiedKey(null), 2000);
                    }}
                  >
                    {copiedKey === 'chasePoRef' ? <Check size={11} /> : <Copy size={11} />}
                    {copiedKey === 'chasePoRef' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>

              {chaseDeliveryModal.shipmentId ? (
                <div className="curaleaf-call-modal__ref-item">
                  <span className="curaleaf-call-modal__ref-label">Consignment / Shipment ID</span>
                  <div className="curaleaf-call-modal__ref-value-row">
                    <code className="curaleaf-call-modal__ref-code">{chaseDeliveryModal.shipmentId}</code>
                    <button
                      type="button"
                      className={`curaleaf-call-modal__copy-btn${copiedKey === 'chaseShp' ? ' curaleaf-call-modal__copy-btn--copied' : ''}`}
                      onClick={() => {
                        void navigator.clipboard.writeText(chaseDeliveryModal.shipmentId || '');
                        setCopiedKey('chaseShp');
                        window.setTimeout(() => setCopiedKey(null), 2000);
                      }}
                    >
                      {copiedKey === 'chaseShp' ? <Check size={11} /> : <Copy size={11} />}
                      {copiedKey === 'chaseShp' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="curaleaf-call-modal__ref-item">
                <span className="curaleaf-call-modal__ref-label">Order Number</span>
                <div className="curaleaf-call-modal__ref-value-row">
                  <code className="curaleaf-call-modal__ref-code">{orderReference(chaseDeliveryModal.order)}</code>
                  <button
                    type="button"
                    className={`curaleaf-call-modal__copy-btn${copiedKey === 'chaseOrderNum' ? ' curaleaf-call-modal__copy-btn--copied' : ''}`}
                    onClick={() => {
                      void navigator.clipboard.writeText(orderReference(chaseDeliveryModal.order));
                      setCopiedKey('chaseOrderNum');
                      window.setTimeout(() => setCopiedKey(null), 2000);
                    }}
                  >
                    {copiedKey === 'chaseOrderNum' ? <Check size={11} /> : <Copy size={11} />}
                    {copiedKey === 'chaseOrderNum' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            </div>

            <div className="curaleaf-call-modal__guidance">
              <Info size={16} />
              <span>
                Quote the <strong>PO Reference</strong> and <strong>Consignment ID</strong> to Curaleaf Customer Services so they can instantly locate the courier manifest with Polar Speed / DX.
              </span>
            </div>

            <footer className="curaleaf-call-modal__footer">
              <button type="button" className="btn btn-primary" onClick={() => setChaseDeliveryModal(null)}>Done</button>
            </footer>
          </section>
        </div>
      ) : null}
      {callCuraleafModal ? (
        <div className="order-handout-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setCallCuraleafModal(null); }}>
          <section className="curaleaf-call-modal" role="dialog" aria-modal="true" aria-labelledby="call-curaleaf-title">
            <header className="curaleaf-call-modal__header">
              <div className="curaleaf-call-modal__header-left">
                <span className="curaleaf-call-modal__icon-pill"><PhoneCall size={20} /></span>
                <div className="curaleaf-call-modal__header-titles">
                  <span className="curaleaf-call-modal__eyebrow">Supplier cancellation</span>
                  <h2 id="call-curaleaf-title" className="curaleaf-call-modal__title">Call Curaleaf to cancel</h2>
                </div>
              </div>
              <button type="button" className="curaleaf-call-modal__close" onClick={() => setCallCuraleafModal(null)} aria-label="Close">
                <X size={18} />
              </button>
            </header>

            <p className="curaleaf-call-modal__desc">
              Contact Curaleaf Customer Services if the patient changes their mind or the pharmacy needs an active prescription or purchase order cancelled. Choose the affected scope, then quote the references below.
            </p>

            {callCuraleafModal.order.prescriptions.length > 1 ? (
              <div className="curaleaf-call-modal__scope" role="group" aria-label="Cancellation call scope">
                <button type="button" aria-pressed={callCuraleafModal.scope === 'selected'} className={callCuraleafModal.scope === 'selected' ? 'is-selected' : ''} onClick={() => setCallCuraleafModal({ ...callCuraleafModal, scope: 'selected', prescriptionId: callCuraleafModal.prescriptionId ?? callCuraleafModal.order.prescriptions[0]?.id ?? null })}>Selected prescription</button>
                <button type="button" aria-pressed={callCuraleafModal.scope === 'order'} className={callCuraleafModal.scope === 'order' ? 'is-selected' : ''} onClick={() => setCallCuraleafModal({ ...callCuraleafModal, scope: 'order' })}>Whole order</button>
              </div>
            ) : null}

            <div className="curaleaf-call-modal__phone-card">
              <div className="curaleaf-call-modal__phone-info">
                <span className="curaleaf-call-modal__phone-label">Curaleaf Customer Support</span>
                <strong className="curaleaf-call-modal__phone-number">0113 873 0000</strong>
              </div>
              <a href="tel:01138730000" className="curaleaf-call-modal__call-btn">
                <Phone size={13} /> Call now
              </a>
            </div>

            <div className="curaleaf-call-modal__refs-card">
              {callModalPrescriptions.flatMap(prescription => {
                const index = callCuraleafModal.order.prescriptions.findIndex(candidate => candidate.id === prescription.id);
                return [
                { key: `cancel-po-${prescription.id}`, label: `Prescription ${index + 1} PO`, value: prescription.purchaseOrderId, missing: 'No Curaleaf PO created' },
                { key: `cancel-serial-${prescription.id}`, label: `Prescription ${index + 1} serial`, value: prescription.serialNumber, missing: 'Not recorded' },
              ]; }).map(reference => (
                <div className="curaleaf-call-modal__ref-item" key={reference.key}>
                  <span className="curaleaf-call-modal__ref-label">{reference.label}</span>
                  <div className="curaleaf-call-modal__ref-value-row">
                    <code className="curaleaf-call-modal__ref-code">{reference.value ?? reference.missing}</code>
                    <button
                      type="button"
                      className={`curaleaf-call-modal__copy-btn${copiedKey === reference.key ? ' curaleaf-call-modal__copy-btn--copied' : ''}`}
                      disabled={!reference.value}
                      aria-label={`Copy ${reference.label}`}
                      onClick={() => {
                        if (!reference.value) return;
                        void navigator.clipboard.writeText(reference.value);
                        setCopiedKey(reference.key);
                        window.setTimeout(() => setCopiedKey(null), 2000);
                      }}
                    >
                      {copiedKey === reference.key ? <Check size={11} /> : <Copy size={11} />}
                      {copiedKey === reference.key ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="curaleaf-call-modal__guidance">
              <Info size={16} />
              <span>
                Calling does not change this HHH order. It stays in its current stage until the platform observes Curaleaf’s cancelled prescription or purchase order. It then moves to Needs action for replacement or cancellation and refund.
              </span>
            </div>

            <footer className="curaleaf-call-modal__footer">
              <button type="button" className="btn btn-primary" onClick={() => setCallCuraleafModal(null)}>Done</button>
            </footer>
          </section>
        </div>
      ) : null}
      {handoutOrderId && selected?.order.id === handoutOrderId ? createPortal(
        <div className="order-handout-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !handoutBusy) { setHandoutOrderId(null); setHandoutPrescriptionId(null); setHandoutPartial(false); setHandoutShipmentId(undefined); } }}>
          <section className="order-handout-dialog" role="alertdialog" aria-modal="true" aria-labelledby="order-handout-title" aria-describedby="order-handout-description">
            <span className="order-handout-dialog__icon"><PackageCheck size={22} /></span>
            <div>
              <small>Patient handover</small>
              <h2 id="order-handout-title">{selected.order.prescriptions.length > 1 ? `Confirm prescription ${Math.max(1, selected.order.prescriptions.findIndex(prescription => prescription.id === handoutPrescriptionId) + 1)} handover` : handoutPartial ? 'Confirm partial handover to the patient' : 'Confirm the medicine has been handed to the patient'}</h2>
              <p id="order-handout-description">
                {selected.order.prescriptions.length > 1
                  ? `This records only the selected prescription’s ready consignment for ${orderReference(selected.order)}. Other prescriptions remain in their current stages.`
                  : handoutPartial
                  ? `This records handover of arrived packs only for ${orderReference(selected.order)}. Remaining packs are still awaiting dispatch.`
                  : `This completes ${orderReference(selected.order)} and records the handover in the audit trail.`}
              </p>
            </div>
            <footer>
              <button type="button" className="btn btn-secondary" disabled={handoutBusy} onClick={() => { setHandoutOrderId(null); setHandoutPrescriptionId(null); setHandoutPartial(false); setHandoutShipmentId(undefined); }}>Cancel</button>
              <button type="button" className="btn btn-primary" disabled={handoutBusy} onClick={() => void handleOrderHandout(selected.order, handoutPrescriptionId, handoutPartial, handoutShipmentId)}>
                <Check size={14} /> {handoutBusy ? 'Recording handover…' : selected.order.prescriptions.length > 1 ? 'Confirm prescription handover' : handoutPartial ? 'Confirm partial handover' : 'Confirm handover'}
              </button>
            </footer>
          </section>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

/* Label and number only. The board underneath already explains each lane, so a third
   line of description per tile was the same sentence twice on one screen. */
function SummaryMetric({ label, value, icon: Icon, tone }: { label: string; value: string; icon: LucideIcon; tone: string }) {
  return <article className={`order-crm-metric order-crm-metric--${tone}`}><span className="order-crm-metric__icon"><Icon size={15} aria-hidden="true" /></span><span><small>{label}</small><strong>{value}</strong></span></article>;
}

function OrderListRow({ item, selected, laneLabel, sectionKey, onSelect }: { item: PrescriptionWorkItem; selected: boolean; now: Date; laneLabel?: string; sectionKey?: string; onSelect: () => void }) {
  const { record, sourceOrder, prescription } = item;
  const meta = recordStageMeta(record);
  const Icon = meta.icon;
  const patientName = record.patient?.name ?? 'Unknown patient';
  const cancellationResolution = orderCancellationResolution(record.order);
  const isCancellation = cancellationResolution !== 'none';
  // Cards speak pharmacy, not supplier: the lane header may say "with Curaleaf", the
  // card says what the pharmacy is waiting for. A split order already carries its own
  // stage-aware label from `recordStageMeta`, so it is left alone here.
  const cardLabel = recordCardTag(record);
  // A tag that repeats the heading directly above it is pure noise — five cards under a
  // "Quote review" section do not each need to say "Quote review". The status stays in
  // the accessible name, so nothing is lost for a screen reader.
  const headingKey = sectionKey ?? orderBoardSlug(laneLabel ?? '');
  const showTag = orderBoardSlug(cardLabel) !== headingKey;
  const rxCount = sourceOrder.prescriptions.length;
  const placedCount = sourceOrder.prescriptions.filter(candidate => Boolean(candidate.purchaseOrderId)).length;
  const mixedPlaced = !prescription && rxCount > 1 && placedCount > 0 && placedCount < rxCount;
  const listReference = orderReference(sourceOrder);
  const workLabel = prescriptionWorkItemLabel(item);
  const workValue = prescription ? rxRevenue(prescription) : sourceOrder.payment.amount;
  return (
    <button
      type="button"
      className={`order-crm-row order-crm-row--${meta.tone}${isCancellation ? ' order-crm-row--cancelled' : ''}${selected ? ' selected' : ''}`}
      aria-pressed={selected}
      aria-label={`${compactPatientName(patientName)}, order ${listReference}, ${workLabel}, ${cardLabel}, ${money(workValue)}, ${formatDate(sourceOrder.date)}. ${meta.description}`}
      title={meta.description}
      onClick={onSelect}
    >
      <span className={`order-crm-row__stage order-tone--${meta.tone}`}><Icon size={15} aria-hidden="true" /></span>
      <span className="order-crm-row__identity"><strong title={patientName}>{compactPatientName(patientName)}</strong><small>{sourceOrder.redoContext ? 'Replacement' : 'Order'} {listReference} · {workLabel}{mixedPlaced ? ` · ${placedCount} of ${rxCount} placed` : ''}</small></span>
      {showTag ? (
        <span className="order-crm-row__marks">
          <span className={`order-stage-pill order-tone--${meta.tone}`}>{cardLabel}</span>
        </span>
      ) : null}
      <span className="order-crm-row__position"><strong>{money(workValue)}</strong><small>{formatDate(sourceOrder.date)}</small></span>
    </button>
  );
}

function ExpiryCountdown({ order, now }: { order: PatientOrder; now: Date }) {
  if (order.payment.status === 'none') return null;
  if (order.prescriptions.every(rx => rx.status === 'collected' || rx.status === 'cancelled')) return null;
  if (order.isExpired || order.unresolvedReason === 'expired') return null;

  const entryDate = new Date(order.date);
  const expiryDate = order.cycleExpiresAt ? new Date(order.cycleExpiresAt) : (() => {
    const d = new Date(entryDate);
    d.setDate(d.getDate() + 28);
    return d;
  })();

  const msLeft = expiryDate.getTime() - now.getTime();
  const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));

  if (daysLeft > 14) return null;

  const tone = daysLeft <= 0 ? 'danger' : daysLeft <= 5 ? 'warning' : 'neutral';
  const label = daysLeft <= 0
    ? '28-Day CD window expired — Prescription re-issue required'
    : daysLeft === 1
      ? '1 day remaining on 28-day CD window'
      : `${daysLeft} days remaining on 28-day CD window`;

  return (
    <div className={`expiry-countdown-pill expiry-countdown-pill--${tone}`}>
      <Clock3 size={14} />
      <span>{label}</span>
    </div>
  );
}

function ReplacementLineage({ order, allOrders }: { order: PatientOrder; allOrders: PatientOrder[] }) {
  const { dispatch } = useApp();

  const childOrder = order.redoneByOrderId
    ? allOrders.find(o => o.backendId === order.redoneByOrderId || String(o.id) === String(order.redoneByOrderId) || o.redoContext?.originalBackendId === order.backendId)
    : allOrders.find(o => o.redoContext?.originalOrderId === order.id);

  const parentOrder = order.redoContext
    ? allOrders.find(o => o.id === order.redoContext!.originalOrderId || o.backendId === order.redoContext!.originalBackendId)
    : null;

  if (!childOrder && !parentOrder) return null;

  return (
    <>
      {childOrder ? (
        <div className="order-lineage-banner order-lineage-banner--parent" onClick={() => dispatch({ type: 'SET_ACTIVE_ORDER', orderId: childOrder.id })} role="button" tabIndex={0}>
          <RefreshCw size={14} />
          <span>Replaced by Order {orderReference(childOrder)} →</span>
        </div>
      ) : null}
      {parentOrder ? (
        <div className="order-lineage-banner order-lineage-banner--child" onClick={() => dispatch({ type: 'SET_ACTIVE_ORDER', orderId: parentOrder.id })} role="button" tabIndex={0}>
          <RefreshCw size={14} />
          <span>Replacement of Order {orderReference(parentOrder)} ({order.redoContext?.reason === 'expired' ? '28-day CD expiry' : order.redoContext?.reason ?? 'replacement'}) →</span>
        </div>
      ) : null}
    </>
  );
}

function OrderDetail({ record, selectedPrescriptionId, onSelectPrescription, now, placementConfirmation, handoutBusy, onOpenHandout, manualForm, onManualFormChange, onRecordManual, onRedo, busy, receiptDrafts, fulfilmentBusyRxId, onReceiptDraftChange, onSavePartial, onConfirmDelivery, onCallCuraleaf, onManualPlace, onPaymentLinkResend, paymentLinkBusy, refundReference, onRefundReferenceChange, onRequestRefund, onConfirmRefund, refundBusy, quoteReviewBusy, onQuoteReviewResolve, cancellationEditorOpen, cancellationNote, cancellationBusy, onOpenCancellation, onCloseCancellation, onCancellationNoteChange, onRequestCancellation, onChaseDelivery }: {
  record: OrderRecord;
  selectedPrescriptionId: number | null;
  onSelectPrescription: (prescriptionId: number) => void;
  now: Date;
  placementConfirmation: string | null;
  handoutBusy: boolean;
  onOpenHandout: (prescription: Prescription, partial: boolean, shipmentId?: string) => void;
  manualForm: ManualPaymentForm;
  onManualFormChange: (patch: Partial<ManualPaymentForm>) => void;
  onRecordManual: () => void;
  onRedo: () => void;
  busy: boolean;
  receiptDrafts: Record<number, GoodsReceiptDraft>;
  fulfilmentBusyRxId: number | null;
  onReceiptDraftChange: (prescription: Prescription, patch: Partial<GoodsReceiptDraft>) => void;
  onSavePartial: (prescription: Prescription, shipmentId?: string) => void;
  onConfirmDelivery: (prescription: Prescription, shipmentId?: string) => void;
  onCallCuraleaf: (prescription?: Prescription) => void;
  onManualPlace: (prescription: Prescription) => void;
  onPaymentLinkResend: () => void;
  paymentLinkBusy: boolean;
  refundReference: string;
  onRefundReferenceChange: (value: string) => void;
  onRequestRefund: () => void;
  onConfirmRefund: () => void;
  refundBusy: boolean;
  quoteReviewBusy: boolean;
  onQuoteReviewResolve: (action: 'absorb' | 'refresh') => void;
  cancellationEditorOpen: boolean;
  cancellationNote: string;
  cancellationBusy: boolean;
  onOpenCancellation: () => void;
  onCloseCancellation: () => void;
  onCancellationNoteChange: (note: string) => void;
  onRequestCancellation: () => void;
  onChaseDelivery?: (prescription?: Prescription, shipmentId?: string) => void;
}) {
  const [showOrderDetails, setShowOrderDetails] = useState(false);
  const [copiedDetailKey, setCopiedDetailKey] = useState<string | null>(null);
  const [viewingPrescriptionCopy, setViewingPrescriptionCopy] = useState(false);
  const { state, dispatch } = useApp();
  const { order, patient, stage } = record;
  const prescriptionWorkItems = buildPrescriptionWorkItems(record).filter(item => item.prescription);
  const defaultPrescriptionItem = [...prescriptionWorkItems].sort((left, right) => orderRecordPriority(left.record) - orderRecordPriority(right.record))[0] ?? null;
  const selectedPrescriptionItem = prescriptionWorkItems.find(item => item.prescription?.id === selectedPrescriptionId) ?? defaultPrescriptionItem;
  const selectedPrescription = selectedPrescriptionItem?.prescription ?? null;
  const selectedPrescriptionIndex = selectedPrescriptionItem?.prescriptionIndex ?? 0;
  const selectedDisplayOrder = selectedPrescriptionItem?.record.order ?? order;
  const selectedStage = selectedPrescriptionItem?.record.stage ?? stage;
  const hasUnaffectedSibling = Boolean(selectedPrescription && order.prescriptions.some(prescription =>
    prescription.id !== selectedPrescription.id && !prescriptionIsCancelled(prescription),
  ));
  const pharmacy = state.organisations.find(organisation => organisation.id === state.currentOrganisationId);
  const meta = recordStageMeta(record);
  const selectedMeta = selectedPrescriptionItem ? recordStageMeta(selectedPrescriptionItem.record) : meta;
  const fulfilmentHeadline = orderFulfilmentHeadline(order);
  const Icon = selectedMeta.icon;
  const cancellationResolution = orderCancellationResolution(order);
  const typedResolutionClosed = ['REPLACED', 'REFUNDED', 'SPLIT_RESOLVED'].includes(order.resolution?.status ?? '');
  const cancellationClosed = ['resolved', 'refunded'].includes(cancellationResolution) || typedResolutionClosed;
  const placedCount = order.prescriptions.filter(prescription => Boolean(prescription.purchaseOrderId)).length;
  const purchaseOrderReferences = [...new Set(order.prescriptions.flatMap(prescription => prescription.purchaseOrderId ? [prescription.purchaseOrderId] : []))];
  const sharesLegacyPurchaseOrder = placedCount > 1 && new Set(order.prescriptions.filter(prescription => prescription.placed && prescription.purchaseOrderId).map(prescription => prescription.purchaseOrderId)).size === 1;
  const paymentStatusLabel = order.payment.status === 'paid' ? 'paid' : order.payment.status === 'sent' ? 'awaiting payment' : order.payment.status === 'cancelled' ? 'cancelled' : 'unpaid';
  const isDraftOrder = order.payment.status === 'none';
  const hhhReference = orderReference(order).replace(/^#/, '');
  const purchaseOrderSummary = purchaseOrderReferences.length === 1
    ? `Curaleaf PO ${purchaseOrderReferences[0]}`
    : purchaseOrderReferences.length > 1
      ? `${purchaseOrderReferences.length} Curaleaf POs`
      : null;
  const headerReference = isDraftOrder
    ? `Draft order · not submitted · ${order.prescriptions.length} prescription${order.prescriptions.length === 1 ? '' : 's'}`
    : [
      purchaseOrderSummary,
      `${order.redoContext ? 'Replacement order' : 'Order'} #${hhhReference}`,
      paymentStatusLabel,
      `${order.prescriptions.length} prescription${order.prescriptions.length === 1 ? '' : 's'}`,
      order.redoContext?.originalOrderNumber ? `replaces #${order.redoContext.originalOrderNumber}` : null,
    ].filter(Boolean).join(' · ');
  const paymentFormVisible = stage === 'awaiting-payment' && order.payment.route === 'pharmacy';
  const mayCancel = orderPaymentAllowsManualCancellation(order)
    && !order.cancellation
    && !['collected', 'cancelled'].includes(stage)
    && (quoteReviewIsOpen(order) || !orderRequiresCuraleafCancel(order));
  const hasCuraleafOrder = orderRequiresCuraleafCancel(selectedDisplayOrder);
  const mayCallCuraleafToCancel = order.payment.status === 'paid'
    && hasCuraleafOrder
    && !cancellationClosed
    && !supplierCancelledAfterCall(selectedDisplayOrder)
    && !['delivered', 'ready', 'collected', 'archived', 'cancelled', 'rejected'].includes(selectedStage);
  const supplyIncomplete = selectedPrescription ? prescriptionSupplyIncomplete(selectedPrescription) : orderSupplyIncomplete(order);
  const canFullHandout = selectedStage === 'ready' && !supplyIncomplete && (selectedPrescription ? prescriptionUncollectedReadyPacks(selectedPrescription) : orderUncollectedReadyPacks(order)) > 0;
  const reviewOpen = quoteReviewIsOpen(selectedDisplayOrder) && !supplierCancelledAfterCall(selectedDisplayOrder);
  const showSupplierCancel = order.payment.status === 'paid' && supplierCancelledAfterCall(selectedDisplayOrder) && !cancellationClosed;
  const useFulfilmentHeadline = placedCount > 0 && stage !== 'awaiting-payment'
    && cancellationResolution === 'none' && !quoteReviewIsOpen(order)
    && !['rejected', 'archived', 'cancelled'].includes(stage);
  const headerStatusLabel = useFulfilmentHeadline && fulfilmentHeadline
    ? fulfilmentHeadline.label
    : selectedMeta.label;
  const headerStatusTone = headerStatusLabel === 'Split fulfilment' || headerStatusLabel === 'Split delivery'
    ? 'partial'
    : selectedMeta.tone;

  const openPatientRecord = () => {
    if (!order.patientId) return;
    // Stay on Orders: Patients is keep-alive mounted and opens a portaled dialog.
    dispatch({
      type: 'SET_NAVIGATION_TARGET',
      target: { kind: 'patient', id: order.patientId },
    });
  };

  const viewablePrescription = selectedPrescription ?? order.prescriptions[0] ?? null;
  const prescriptionCopyClosed = ['collected', 'cancelled', 'rejected', 'archived'].includes(selectedStage);
  const canViewPrescriptionCopy = orderPrescriptionCopyViewable(viewablePrescription?.fileId, prescriptionCopyClosed);

  const openPrescriptionCopy = async () => {
    const fileId = viewablePrescription?.fileId?.trim();
    if (!fileId || viewingPrescriptionCopy) return;
    setViewingPrescriptionCopy(true);
    try {
      if (!isPersistedPrescriptionFileId(fileId) || isLocalPortalPreview) {
        if (!openTrainingPrescriptionPreview()) {
          dispatch({ type: 'ADD_TOAST', message: 'Allow pop-ups to view the prescription copy.', toastType: 'warning' });
        }
        return;
      }
      const { downloadUrl } = await getPrescriptionFileDownloadUrl(fileId, state.currentOrganisationId);
      const opened = window.open(downloadUrl, '_blank', 'noopener,noreferrer');
      if (!opened) dispatch({ type: 'ADD_TOAST', message: 'Allow pop-ups to view the prescription copy.', toastType: 'warning' });
    } catch (error) {
      const missing = error instanceof ApiRequestError && (error.status === 404 || error.code === 'NOT_FOUND');
      dispatch({
        type: 'ADD_TOAST',
        message: missing ? 'The prescription copy is no longer available.' : 'The prescription copy could not be opened.',
        toastType: 'error',
      });
    } finally {
      setViewingPrescriptionCopy(false);
    }
  };

  const handleCopy = (key: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedDetailKey(key);
    window.setTimeout(() => setCopiedDetailKey(null), 2000);
  };

  const resolveProductName = (item: { name?: string; productId: string; formulaId?: string }): string => {
    const isGeneric = !item.name || ['Curaleaf prescription item', 'Curaleaf formulary product', 'Curaleaf medication', 'Curaleaf medicine', 'Prescribed product'].includes(item.name);
    if (!isGeneric) return item.name ?? 'Curaleaf medicine';
    const cat = state.catalogue.find(c => c.id === item.productId || (item.formulaId && c.formulaId === item.formulaId));
    return cat?.name ?? item.name ?? 'Curaleaf medicine';
  };

  return (
    <article className={`order-crm-record order-crm-record--${selectedMeta.tone}`}>
      <header className="order-crm-record__header">
        <div className="order-crm-record__hero">
          <div className="order-crm-record__identity">
            <span className={`order-crm-record__stage order-tone--${selectedMeta.tone}`}><Icon size={20} aria-hidden="true" /></span>
            <div className="order-crm-record__titles">
              <strong>{patient?.name ?? 'Unknown patient'}</strong>
              <span className="order-crm-record__ref">{headerReference}</span>
            </div>
          </div>
          <span className={`order-stage-pill order-tone--${headerStatusTone}`}>{headerStatusLabel}</span>
        </div>
        <div className="order-crm-record__toolbar">
          <div className="order-crm-record__value">
            <small>Patient total</small>
            <strong>{money(order.payment.amount)}</strong>
            <span className="order-crm-record__opened">Order created {formatDate(order.date)}</span>
          </div>
          <div className="order-crm-record__actions" role="group" aria-label="Order actions">
            {canFullHandout && selectedPrescription ? <button type="button" className="btn btn-primary btn-sm" disabled={handoutBusy} onClick={() => onOpenHandout(selectedPrescription, false)}><Check size={13} /> Hand over</button> : null}
            {mayCallCuraleafToCancel ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => onCallCuraleaf(selectedPrescription ?? undefined)}><PhoneCall size={13} aria-hidden="true" /> Call Curaleaf to cancel</button> : null}
            {canViewPrescriptionCopy ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={viewingPrescriptionCopy}
                aria-busy={viewingPrescriptionCopy}
                onClick={() => void openPrescriptionCopy()}
              >
                <FileText size={13} aria-hidden="true" />
                {viewingPrescriptionCopy ? 'Opening…' : 'View prescription'}
              </button>
            ) : null}
            {order.patientId ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={openPatientRecord}><User size={13} aria-hidden="true" /> Open patient</button>
            ) : null}
            {mayCancel ? <button type="button" className="btn btn-secondary btn-sm" onClick={onOpenCancellation}><XCircle size={13} /> Cancel order</button> : null}
          </div>
        </div>
      </header>

      <QuoteCheckpointSummary order={order} />

      {placementConfirmation ? <div className="order-placement-confirmation"><CheckCircle2 size={17} /><span><strong>Order placed with Curaleaf</strong><small>{placementConfirmation}</small></span></div> : null}
      {selectedStage === 'awaiting-payment' || (selectedStage === 'paid' && !selectedDisplayOrder.prescriptions.every(prescription => Boolean(prescription.purchaseOrderId))) ? (
        <PrePlacementDeliveryGuidance now={now} />
      ) : !['collected', 'cancelled', 'rejected', 'archived'].includes(selectedStage) ? (
        <FulfilmentDeliveryStatus order={selectedDisplayOrder} now={now} />
      ) : null}

      {cancellationClosed ? <CancellationClosureSummary order={order} resolution={order.resolution?.status === 'REFUNDED' || cancellationResolution === 'refunded' ? 'refunded' : 'resolved'} /> : null}

      <ExpiryCountdown order={order} now={now} />
      <ReplacementLineage order={order} allOrders={state.orders} />
      <PlacementStatusPanel order={order} />

      {order.prescriptions.length > 1 ? (
        <PrescriptionSwitcher
          items={prescriptionWorkItems}
          selectedPrescriptionId={selectedPrescription?.id ?? null}
          onSelect={onSelectPrescription}
        />
      ) : null}

      {!cancellationClosed && cancellationEditorOpen && mayCancel ? (
        <OrderCancellationPanel
          order={order}
          editorOpen={cancellationEditorOpen}
          note={cancellationNote}
          busy={cancellationBusy}
          onClose={onCloseCancellation}
          onNoteChange={onCancellationNoteChange}
          onRequest={() => {
            if (orderPaymentAllowsManualCancellation(order)) onRequestCancellation();
          }}
        />
      ) : null}

      {(selectedStage === 'rejected' || selectedStage === 'archived') ? (
        <div className={`order-crm-alert order-crm-alert--${selectedStage === 'rejected' ? 'danger' : 'neutral'}`}>
          {selectedStage === 'rejected' ? <ShieldAlert size={17} /> : <Archive size={17} />}
          <span><strong>{selectedStage === 'rejected' ? 'Selected prescription requires attention' : 'Selected prescription cycle archived'}</strong><small>{selectedStage === 'rejected' ? 'Review the supplier response, then recreate this prescription against a valid script.' : 'This prescription passed its cycle deadline and is retained for the audit trail.'}</small></span>
        </div>
      ) : null}

      {reviewOpen ? (
        <QuoteReviewPanel
          order={selectedDisplayOrder}
          busy={quoteReviewBusy || refundBusy || cancellationBusy}
          onResolve={onQuoteReviewResolve}
        />
      ) : null}

      {((order.payment.status === 'paid' || Boolean(selectedDisplayOrder.refund)) && !reviewOpen && !cancellationClosed && (selectedStage === 'rejected' || selectedStage === 'archived' || selectedStage === 'cancelled' || Boolean(selectedDisplayOrder.cancellation) || selectedDisplayOrder.prescriptions.some(rx => rx.purchaseOrderState === 'CANCELLED' || rx.status === 'cancelled'))) ? (
        <PaidExceptionResolution
          order={selectedDisplayOrder}
          canReplace={!hasCuraleafOrder}
          lockedByCuraleaf={hasCuraleafOrder}
          partialPrescription={hasUnaffectedSibling}
          busy={refundBusy}
          refundReference={refundReference}
          onRefundReferenceChange={onRefundReferenceChange}
          onReplace={onRedo}
          onRequestRefund={onRequestRefund}
          onConfirmRefund={onConfirmRefund}
        />
      ) : null}

      <div className="order-crm-record__body">
        <section className="order-crm-main">
          <div className="order-crm-section-heading"><span><small>Prescription fulfilment</small><strong>{order.prescriptions.length} prescription{order.prescriptions.length === 1 ? '' : 's'}</strong></span><FileText size={16} /></div>
          {sharesLegacyPurchaseOrder ? (
            <p className="order-crm-legacy-po" role="note">One Curaleaf purchase order covers more than one prescription on this order.</p>
          ) : null}
          <div className="order-crm-prescriptions" aria-live="polite">
            {selectedPrescription ? <PrescriptionCard
              key={selectedPrescription.id}
              order={order}
              prescription={selectedPrescription}
              index={selectedPrescriptionIndex}
              receiptDraft={receiptDrafts[selectedPrescription.id] ?? {
                quantities: Object.fromEntries(selectedPrescription.items.map(item => [item.productId, selectedPrescription.receivedItems?.find(received => received.productId === item.productId)?.quantityReceived ?? item.qty])),
                batches: Object.fromEntries(selectedPrescription.items.map(item => [item.productId, ''])),
                expiries: Object.fromEntries(selectedPrescription.items.map(item => [item.productId, ''])),
                note: selectedPrescription.goodsInNote ?? '',
              }}
              busy={fulfilmentBusyRxId === selectedPrescription.id}
              onReceiptDraftChange={patch => onReceiptDraftChange(selectedPrescription, patch)}
              onSavePartial={shipmentId => onSavePartial(selectedPrescription, shipmentId)}
              onConfirmDelivery={shipmentId => onConfirmDelivery(selectedPrescription, shipmentId)}
              onManualPlace={() => onManualPlace(selectedPrescription)}
              onChaseCuraleaf={onChaseDelivery}
              onOpenHandout={(partial, shipmentId) => onOpenHandout(selectedPrescription, partial, shipmentId)}
            /> : null}
          </div>

          {stage === 'awaiting-payment' && order.payment.route === 'worldpay' ? (
            <div className="order-crm-next-action order-crm-next-action--waiting">
              <Clock3 size={16} /><span><strong>Waiting for payment</strong><small>This order will update when the payment is confirmed.</small></span>
              <button type="button" className="btn btn-secondary btn-sm" disabled={paymentLinkBusy} onClick={onPaymentLinkResend}><RefreshCw size={13} /> {paymentLinkBusy ? 'Reissuing…' : 'Void & resend link'}</button>
            </div>
          ) : null}

          {paymentFormVisible ? (
            <section className="order-crm-manual-payment">
              <div className="order-crm-section-heading"><span><small>Pharmacy-managed payment</small><strong>Confirm funds received</strong></span><Banknote size={16} /></div>
              <div className="order-crm-manual-payment__fields">
                <label><span>Payment method</span><select className="input select" value={manualForm.tender} onChange={event => onManualFormChange({ tender: event.target.value as ManualTender })}><option value="epos-card">EPOS card</option><option value="cash">Cash</option><option value="bank-transfer">Bank transfer</option><option value="other">Other</option></select></label>
                <label><span>Receipt reference</span><input className="input" value={manualForm.reference} onChange={event => onManualFormChange({ reference: event.target.value })} placeholder="TILL-1048" /></label>
              </div>
              <label><span>Note (Optional)</span><textarea className="input" value={manualForm.notes} onChange={event => onManualFormChange({ notes: event.target.value })} /></label>
              <label className="payment-confirmation"><input type="checkbox" checked={manualForm.confirmed} onChange={event => onManualFormChange({ confirmed: event.target.checked })} /><span><strong>I confirm {money(order.payment.amount)} has been received</strong><small>This creates the pharmacy payment record.</small></span></label>
              <button type="button" className="btn btn-primary" disabled={!manualForm.confirmed || busy} onClick={onRecordManual}><CheckCircle2 size={14} /> {busy ? 'Recording…' : 'Record payment'}</button>
            </section>
          ) : null}

          <OrderDetailsDrawer
            order={order}
            selectedPrescription={selectedPrescription}
            selectedPrescriptionIndex={selectedPrescriptionIndex}
            pharmacyName={pharmacy?.tradingName || pharmacy?.name || null}
            showOrderDetails={showOrderDetails}
            onToggle={() => setShowOrderDetails(prev => !prev)}
            copiedDetailKey={copiedDetailKey}
            onCopy={handleCopy}
            resolveProductName={resolveProductName}
          />
        </section>
      </div>
    </article>
  );
}

function londonDateKey(value: Date | string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function deliveryGuidanceForOrder(order: PatientOrder) {
  const inTransitAt = order.prescriptions.map(prescription => prescription.latestShipmentAt).find(Boolean);
  const placedAt = order.prescriptions.map(prescription => prescription.placedAt).find(Boolean)
    || order.payment.paidAt
    || order.date
    || new Date();
  return curaleafDeliveryGuidance(inTransitAt || placedAt);
}

function deliveryRange(guidance: NonNullable<ReturnType<typeof curaleafDeliveryGuidance>>) {
  return `${formatDeliveryDate(guidance.windowStart)} – ${formatDeliveryDate(guidance.windowEnd)}`;
}

function countdownLabel(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!hours) return `${remainder} minute${remainder === 1 ? '' : 's'}`;
  if (!remainder) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${hours}h ${remainder}m`;
}

function PrePlacementDeliveryGuidance({ now }: { now: Date }) {
  const guidance = curaleafDeliveryGuidance(now);
  if (!guidance) return null;
  const range = deliveryRange(guidance);
  const copy = guidance.scenario === 'DT-1'
    ? `Order in the next ${countdownLabel(guidance.countdownMinutes)} for expected delivery ${formatDeliveryDate(guidance.nextDay)}–${formatDeliveryDate(guidance.windowEnd)} (1–2 working days).`
    : guidance.scenario === 'DT-2'
      ? `Today's 2:30pm cut-off has passed — your order joins tomorrow's dispatch. Expected delivery ${range} (2–4 working days).`
      : `Orders placed Friday–Sunday are processed Monday — expected delivery ${range} (2–4 working days).`;
  return (
    <div className="order-delivery-banner order-delivery-banner--pending" role="status">
      <div className="order-delivery-banner__main">
        <div className="order-delivery-banner__icon-wrap">
          <Clock3 size={17} />
        </div>
        <div className="order-delivery-banner__content">
          <div className="order-delivery-banner__eyebrow">
            <span>Pre-placement dispatch estimate</span>
          </div>
          <strong className="order-delivery-banner__title">{copy}</strong>
          {guidance.scenario === 'DT-1' ? (
            <p className="order-delivery-banner__desc">Order before 2:30pm Mon–Thu for fastest dispatch.</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function splitPackStatItems(snapshot: ReturnType<typeof orderSplitPackSnapshot>) {
  return [
    { value: snapshot.collected, label: 'packs collected' },
    { value: snapshot.atPharmacy, label: 'packs checked in' },
    { value: snapshot.inTransit, label: 'packs in transit' },
    { value: snapshot.dispensedAtCuraleaf, label: 'packs dispensed at Curaleaf' },
    { value: snapshot.awaitingDispense, label: 'packs awaiting dispense' },
  ].filter(stat => stat.value > 0);
}

function SplitOrderDeliveryBanner({
  tone,
  icon: Icon,
  eyebrow,
  title,
  desc,
  stats,
  showSingleStat = false,
}: {
  tone: 'partial' | 'overdue' | 'ready';
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  desc: string;
  stats: Array<{ value: number; label: string }>;
  showSingleStat?: boolean;
}) {
  const visibleStats = stats.filter(stat => stat.value > 0);
  const showStats = visibleStats.length > (showSingleStat ? 0 : 1);
  return (
    <div className={`order-delivery-banner order-delivery-banner--${tone}`} role="status">
      <div className="order-delivery-banner__main">
        <div className="order-delivery-banner__icon-wrap">
          <Icon size={17} />
        </div>
        <div className="order-delivery-banner__content">
          <div className="order-delivery-banner__eyebrow">
            <span>{eyebrow}</span>
          </div>
          <strong className="order-delivery-banner__title">{title}</strong>
          {showStats ? (
            <ul className="order-delivery-banner__stats" aria-label="Where packs are now">
              {visibleStats.map(stat => (
                <li key={stat.label}>
                  <strong>{stat.value}</strong>
                  <span>{stat.label}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <p className="order-delivery-banner__desc">{desc}</p>
        </div>
      </div>
    </div>
  );
}

function FulfilmentDeliveryStatus({ order, now }: { order: PatientOrder; now: Date }) {
  const guidance = deliveryGuidanceForOrder(order);
  if (!guidance) return null;
  const range = deliveryRange(guidance);
  const serviceWindow = guidance.scenario === 'DT-1' ? '1–2 working days' : '2–4 working days';
  const splitSnapshot = orderSplitPackSnapshot(order);
  const splitStats = splitPackStatItems(splitSnapshot);
  const awaitingSupplier = orderAwaitingSupplierShipmentProductNames(order);
  const hasInTransit = orderHasInTransitPacks(order);
  const hasUncollected = orderHasUncollectedReceivedPacks(order);
  const hasPartialCollection = orderHasPartialCollection(order);
  const isSplit = orderIsSplitFulfilment(order);
  const fulfilmentHeadline = orderFulfilmentHeadline(order);

  if (fulfilmentHeadline?.mixedPrescriptions) {
    return (
      <SplitOrderDeliveryBanner
        tone="partial"
        icon={Layers2}
        eyebrow="Split fulfilment"
        title="Prescriptions progressing separately"
        desc={fulfilmentHeadline.prescriptionSummaries.join(' · ')}
        stats={splitStats}
        showSingleStat
      />
    );
  }

  if (hasUncollected) {
    const packsWaiting = splitSnapshot.atPharmacy;
    if (isSplit && (splitSnapshot.inTransit > 0 || splitSnapshot.withCuraleaf > 0)) {
      return (
        <SplitOrderDeliveryBanner
          tone="partial"
          icon={PackageCheck}
          eyebrow="Ready to hand over"
          title={`${packsWaiting} pack${packsWaiting === 1 ? '' : 's'} checked in — verify and hand over to the patient`}
          desc={splitSnapshot.withCuraleaf > 0 && splitSnapshot.inTransit > 0
            ? 'Other packs are still in transit or waiting to dispatch.'
            : splitSnapshot.inTransit > 0
              ? 'Other packs from this order are still in transit.'
              : 'Other packs are waiting at Curaleaf for a later dispatch.'}
          stats={splitStats}
        />
      );
    }
    return (
      <div className="order-delivery-banner order-delivery-banner--ready" role="status">
        <div className="order-delivery-banner__main">
          <div className="order-delivery-banner__icon-wrap">
            <PackageCheck size={17} />
          </div>
          <div className="order-delivery-banner__content">
            <div className="order-delivery-banner__eyebrow">
              <span>Ready to hand over to the patient</span>
            </div>
            <strong className="order-delivery-banner__title">
              {packsWaiting} pack{packsWaiting === 1 ? '' : 's'} checked in and awaiting collection
            </strong>
            <p className="order-delivery-banner__desc">
              The goods-in check is complete and the patient notification is queued. Hand over only the ready packs when the patient arrives.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (hasPartialCollection && awaitingSupplier.length) {
    const remaining = splitSnapshot.withCuraleaf;
    return (
      <SplitOrderDeliveryBanner
        tone="partial"
        icon={Layers2}
        eyebrow="Part Collected"
        title={`${splitSnapshot.collected} of ${splitSnapshot.total} packs collected`}
        desc={`${remaining} pack${remaining === 1 ? '' : 's'} still to dispatch. No pharmacy action until they ship.`}
        stats={splitStats}
      />
    );
  }

  if (hasInTransit && splitSnapshot.inTransit > 0 && isSplit) {
    const overdue = londonDateKey(now) > guidance.windowEnd;
    const inTransit = splitSnapshot.inTransit;
    const remaining = splitSnapshot.withCuraleaf;
    return (
      <SplitOrderDeliveryBanner
        tone={overdue ? 'overdue' : 'partial'}
        icon={overdue ? AlertTriangle : Truck}
        eyebrow={overdue ? 'Delivery Overdue' : 'Part In Transit'}
        title={overdue
          ? `${inTransit} of ${splitSnapshot.total} packs overdue · expected by ${formatDeliveryDate(guidance.windowEnd)}`
          : `${inTransit} of ${splitSnapshot.total} packs in transit · expected ${range}`}
        desc={remaining > 0
          ? `Check in when the courier arrives. ${remaining} pack${remaining === 1 ? '' : 's'} still to dispatch.`
          : 'Check in packs when the courier arrives. Pharmacy goods-in verification is required.'}
        stats={splitStats}
      />
    );
  }

  if (isSplit && orderHasPartialCuraleafDispense(order) && !hasInTransit && !hasUncollected && !hasPartialCollection) {
    return (
      <SplitOrderDeliveryBanner
        tone="partial"
        icon={Layers2}
        eyebrow="Split Dispensed"
        title={`${splitSnapshot.dispensedAtCuraleaf} of ${splitSnapshot.total} packs dispensed at Curaleaf`}
        desc={`${splitSnapshot.awaitingDispense} pack${splitSnapshot.awaitingDispense === 1 ? '' : 's'} still to dispense. They will ship separately once allocated.`}
        stats={splitStats}
      />
    );
  }

  if (isSplit && awaitingSupplier.length && !hasInTransit) {
    const remaining = splitSnapshot.withCuraleaf;
    return (
      <SplitOrderDeliveryBanner
        tone="partial"
        icon={Layers2}
        eyebrow="Awaiting Next Shipment"
        title={`${remaining} pack${remaining === 1 ? '' : 's'} still to dispatch`}
        desc="The first consignment is complete. Remaining packs will ship separately."
        stats={splitStats}
      />
    );
  }

  const allRx = order.prescriptions;
  const totalOrdered = allRx.reduce((sum, rx) => sum + rx.items.reduce((s, i) => s + i.qty, 0), 0);
  const totalAllocated = allRx.reduce((sum, rx) => {
    if (rx.supplierItems?.length) {
      return sum + rx.supplierItems.reduce((s, si) => s + (si.packsAllocatedCount ?? 0), 0);
    }
    if (rx.purchaseOrderState === 'FULLY_ALLOCATED' || rx.status === 'received' || rx.status === 'ready' || rx.status === 'collected') {
      return sum + rx.items.reduce((s, i) => s + i.qty, 0);
    }
    return sum;
  }, 0);

  const hasAllocatedItems = totalAllocated > 0 || allRx.some(rx => rx.purchaseOrderState === 'PROCESSING' || rx.purchaseOrderState === 'FULLY_ALLOCATED');
  const isFullyAllocated = (totalAllocated >= totalOrdered && totalOrdered > 0) || allRx.every(rx => rx.purchaseOrderState === 'FULLY_ALLOCATED');
  const isDispatched = hasInTransit || allRx.some(rx =>
    rx.status === 'dispatched'
    && !['received', 'partially-received', 'ready', 'collected'].includes(rx.status),
  );
  const overdue = londonDateKey(now) > guidance.windowEnd;

  if (isDispatched) {
    const copy = overdue
      ? `Expected by ${formatDeliveryDate(guidance.windowEnd)} — not yet received? Check with Curaleaf customer service.`
      : `Dispatched by Curaleaf · expected by ${formatDeliveryDate(guidance.windowEnd)}`;
    return (
      <div className={`order-delivery-banner ${overdue ? 'order-delivery-banner--overdue' : 'order-delivery-banner--dispatched'}`} role="status">
        <div className="order-delivery-banner__main">
          <div className="order-delivery-banner__icon-wrap">
            {overdue ? <AlertTriangle size={17} /> : <Truck size={17} />}
          </div>
          <div className="order-delivery-banner__content">
            <div className="order-delivery-banner__eyebrow">
              <span>{overdue ? 'Delivery Overdue' : 'In Transit with Courier'}</span>
            </div>
            <strong className="order-delivery-banner__title">{copy}</strong>
            <p className="order-delivery-banner__desc">
              Expected delivery window: {range}. Pharmacy goods-in check is required upon delivery.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (isFullyAllocated) {
    return (
      <div className="order-delivery-banner order-delivery-banner--ready" role="status">
        <div className="order-delivery-banner__main">
          <div className="order-delivery-banner__icon-wrap">
            <PackageCheck size={17} />
          </div>
          <div className="order-delivery-banner__content">
            <div className="order-delivery-banner__eyebrow">
              <span>Curaleaf Dispensing Complete</span>
            </div>
            <strong className="order-delivery-banner__title">
              Expected delivery {range} ({serviceWindow})
            </strong>
            <p className="order-delivery-banner__desc">
              All {totalOrdered} packs allocated and verified by Curaleaf. Packed and awaiting courier handover.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (hasAllocatedItems) {
    return (
      <div className="order-delivery-banner order-delivery-banner--picking" role="status">
        <div className="order-delivery-banner__main">
          <div className="order-delivery-banner__icon-wrap">
            <Package size={17} />
          </div>
          <div className="order-delivery-banner__content">
            <div className="order-delivery-banner__eyebrow">
              <span>Curaleaf Dispensing in Progress</span>
            </div>
            <strong className="order-delivery-banner__title">
              Expected delivery {range} · {totalAllocated} of {totalOrdered} packs dispensed
            </strong>
            <p className="order-delivery-banner__desc">
              Curaleaf technicians are actively dispensing this order. Delivery timeline is active and tracked against live allocation.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Pre-allocation / waiting to be picked (e.g. CREATED or Curaleaf review)
  return (
    <div className="order-delivery-banner order-delivery-banner--pending" role="status">
      <div className="order-delivery-banner__main">
        <div className="order-delivery-banner__icon-wrap">
          <Clock3 size={17} />
        </div>
        <div className="order-delivery-banner__content">
          <div className="order-delivery-banner__eyebrow">
            <span>Estimated Delivery · Subject to Change</span>
          </div>
          <strong className="order-delivery-banner__title">
            Expected delivery {range} ({serviceWindow})
          </strong>
          <p className="order-delivery-banner__desc">
            Order placed with Curaleaf. The {serviceWindow} estimate is based on the real placement time; dates update when Curaleaf dispatches.
          </p>
        </div>
      </div>
    </div>
  );
}

function formatQuoteReviewValue(value: string | boolean) {
  if (typeof value === 'boolean') return value ? 'In stock' : 'Out of stock';
  if (value === 'missing') return 'Not stored';
  if (value === 'present') return 'Available';
  const pence = Number(value);
  if (Number.isFinite(pence) && String(value).trim() !== '') return money(pence / 100);
  return String(value);
}

function quoteReviewFieldLabel(field: string) {
  if (field === 'inStock') return 'Stock';
  if (field === 'patientPackPrice') return 'Patient pack price';
  if (field === 'wholesalePackPrice') return 'Wholesale pack price (excl. VAT)';
  if (field === 'shippingPrice') return 'Shipping';
  if (field === 'missingOriginalQuote') return 'Paid quote';
  return field;
}

function QuoteCheckpointSummary({ order }: { order: PatientOrder }) {
  const latest = visiblePaymentGateCheck(order.quoteChecks, order.activeQuoteCheck);
  if (!latest) return null;
  /*
   * One bar, not a history.
   *
   * The Before/After/Before-purchase-order list showed the same order re-priced
   * three or four times, which read as four things to review when it is one
   * gate with one current answer. What staff act on is the latest check and how
   * long ago it ran; the individual checks remain in the order's activity log
   * for anyone reconciling a price change after the fact.
   */
  const statusLabel = latest.status === 'CHANGED' ? 'Changed'
      : latest.status === 'OUT_OF_STOCK' ? 'Out of stock'
        : latest.status === 'ABSORBED' ? 'Difference absorbed'
          : latest.status === 'CANCELLED' ? 'Cancelled'
            : 'Reconciliation required';
  return (
    <section
      className={`order-gate-summary order-gate-summary--single is-${latest.status.toLowerCase().replaceAll('_', '-')}`}
      aria-labelledby="order-quote-checks-title"
    >
      <CheckCircle2 size={17} aria-hidden="true" />
      <span className="order-gate-summary__copy">
        <small>Payment gate</small>
        <strong id="order-quote-checks-title">Curaleaf quote {statusLabel.toLowerCase()}</strong>
      </span>
      <span className="order-gate-summary__value">
        <b>{money(latest.patientTotalPence / 100)}</b>
        <small>Last checked {formatDate(latest.checkedAt, true)}</small>
      </span>
    </section>
  );
}

function PlacementStatusPanel({ order }: { order: PatientOrder }) {
  const placement = order.curaleafPlacement;
  if (!placement || placement.stage === 'PLACED') return null;
  const content = placement.attentionReason === 'image_reupload' || placement.stage === 'UPLOAD_CORRECTION_REQUIRED'
    ? {
        title: 'Curaleaf requested a clearer prescription copy',
        detail: 'The prescription remains on the same supplier record. Upload a legible copy after the pharmacy call; do not create a replacement prescription or refund while Curaleaf is waiting for the image.',
      }
    : placement.stage === 'AWAITING_PRESCRIBER_VERIFICATION'
      ? { title: 'Awaiting Curaleaf prescriber verification', detail: 'No prescription or purchase order will be sent until Curaleaf marks the prescriber as verified.' }
      : placement.stage === 'AWAITING_PRESCRIPTION_ACTIVATION'
        ? { title: 'Awaiting Curaleaf prescription approval', detail: 'This is a normal waiting state. The paid order remains open and will continue when the prescription becomes active.' }
        : placement.stage === 'CORRECTION_REQUIRED'
          ? { title: 'Supplier details need correction', detail: 'Placement is paused. Review the recorded pharmacy task before retrying; no automatic refund has been started.' }
          : placement.stage === 'TERMINAL'
            ? { title: 'Supplier resolution required', detail: 'Placement cannot continue automatically. Review replacement and refund gates before resolving the order.' }
            : null;
  if (!content) return null;
  return (
    <section className="order-placement-wait" role="status" aria-live="polite">
      <Clock3 size={18} aria-hidden="true" />
      <span>
        <strong>{content.title}</strong>
        <small>{content.detail}</small>
        {placement.slaDueAt ? <em className={placement.slaAlert ? 'is-overdue' : undefined}>{placement.slaAlert ? 'Pharmacy follow-up is due' : 'Follow-up due'} {formatDate(placement.slaDueAt, true)}</em> : placement.nextCheckAt ? <em>Next automatic check {formatDate(placement.nextCheckAt, true)}</em> : null}
      </span>
    </section>
  );
}

function QuoteReviewPanel({ order, busy, onResolve }: {
  order: PatientOrder;
  busy: boolean;
  onResolve: (action: 'absorb' | 'refresh') => void;
}) {
  const review = order.quoteReview;
  const quoteCheck = order.activeQuoteCheck;
  const legacyOpen = Boolean(review && ['required', 'awaiting_top_up', 'awaiting_refund'].includes(review.status));
  const checkOpen = Boolean(quoteCheck && ['CHANGED', 'OUT_OF_STOCK', 'RECONCILIATION_REQUIRED'].includes(quoteCheck.status));
  if (!legacyOpen && !checkOpen) return null;
  const delta = review?.patientDeltaPence ?? quoteCheck?.patientDeltaPence ?? 0;
  const missingBaseline = quoteCheck?.status === 'RECONCILIATION_REQUIRED' || review?.differences?.some(difference => difference.field === 'missingOriginalQuote');
  const outOfStock = quoteCheck?.status === 'OUT_OF_STOCK' || review?.type === 'out_of_stock';
  const title = outOfStock
    ? 'Curaleaf reports a line out of stock'
    : missingBaseline
      ? 'Paid quote could not be compared'
      : review?.type === 'patient_price_changed' || delta !== 0
        ? delta > 0 ? 'Patient price increased after payment' : 'Patient price dropped after payment'
        : 'Supplier cost changed after payment';
  const detail = outOfStock
    ? 'Placement is held. Recheck after Curaleaf restocks; the verified payment remains attached to this order.'
    : missingBaseline
      ? 'The quote attached to payment cannot be proved. Recheck keeps placement held until reconciliation succeeds.'
      : delta !== 0
        ? `Accept the ${money(Math.abs(delta) / 100)} ${delta > 0 ? 'increase' : 'decrease'} and keep the patient payment unchanged.`
        : 'The supplier cost changed. Accept the difference and keep the patient payment unchanged.';
  return (
    <section className="quote-review-panel" aria-labelledby="quote-review-title">
      <header className="quote-review-panel__header">
        <AlertTriangle size={18} aria-hidden="true" />
        <span>
          <small>Quote Review Required</small>
          <strong id="quote-review-title">{title}</strong>
          <em>{detail}</em>
        </span>
      </header>
      {review?.differences?.length ? (
        <ul className="quote-review-panel__diffs">
          {review.differences.map((difference, index) => (
            <li key={`${difference.field}-${difference.packId ?? index}`}>
              <strong>{quoteReviewFieldLabel(difference.field)}</strong>
              <small>{formatQuoteReviewValue(difference.previous)} → {formatQuoteReviewValue(difference.latest)}</small>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="quote-review-panel__actions">
        {outOfStock || missingBaseline ? (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onResolve('refresh')}>
            <RefreshCw size={13} /> {busy ? 'Checking…' : 'Recheck quote'}
          </button>
        ) : (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onResolve('absorb')}>
            Accept
          </button>
        )}
      </div>
    </section>
  );
}

function CancellationClosureSummary({ order, resolution }: { order: PatientOrder; resolution: 'resolved' | 'refunded' }) {
  const refunded = resolution === 'refunded';
  const replaced = order.resolution?.status === 'REPLACED';
  const splitResolved = order.resolution?.status === 'SPLIT_RESOLVED';
  const closedAt = order.resolution?.archivedAt ?? order.resolution?.resolvedAt ?? (refunded ? order.refund?.confirmedAt : order.curaleafCancellation?.confirmedAt ?? order.cancellation?.requestedAt);
  const supplierCopy = order.curaleafCancellation?.status === 'confirmed'
    ? 'Curaleaf cancellation confirmed.'
    : orderRequiresCuraleafCancel(order)
      ? 'Supplier cancellation recorded.'
      : 'No supplier order required cancellation.';
  return (
    <section className={`order-cancellation-closure order-cancellation-closure--${resolution}`} aria-label="Resolved cancellation">
      <span className="order-cancellation-closure__icon">{refunded ? <Banknote size={18} /> : <CheckCircle2 size={18} />}</span>
      <span className="order-cancellation-closure__copy">
        <small>Closed order</small>
        <strong>{refunded ? `${money((order.refund?.amountPence ?? Math.round(order.payment.amount * 100)) / 100)} refunded` : replaced ? 'Replaced using paid balance' : splitResolved ? 'Split fulfilment resolved' : 'Cancellation resolved'}</strong>
        <em>{supplierCopy} {replaced ? 'The paid allocation moved to the replacement order.' : splitResolved ? 'Supplied packs and the cancelled remainder are fully accounted for.' : 'This order is retained in the archive for audit.'}</em>
      </span>
      <span className="order-cancellation-closure__status"><b>No action needed</b><small>{formatDate(closedAt, true)}</small></span>
    </section>
  );
}

function OrderCancellationPanel({ order, editorOpen, note, busy, onClose, onNoteChange, onRequest }: {
  order: PatientOrder;
  editorOpen: boolean;
  note: string;
  busy: boolean;
  onClose: () => void;
  onNoteChange: (note: string) => void;
  onRequest: () => void;
}) {
  if (!editorOpen || order.cancellation) return null;
  const unpaid = order.payment.status !== 'paid';
  return (
    <section className="order-cancellation-card order-cancellation-card--compose" aria-labelledby="order-cancel-title">
      <div className="order-cancellation-confirm">
        <span className="order-cancellation-confirm__icon" aria-hidden="true">
          <XCircle size={18} />
        </span>
        <div className="order-cancellation-confirm__copy">
          <h2 id="order-cancel-title">Cancel {orderReference(order)}?</h2>
          <p>
            {unpaid
              ? 'The payment request will be retired. This order is cancelled in HHH.'
              : 'This order will be cancelled. If payment was taken, a refund task will follow.'}
          </p>
        </div>
        <div className="order-cancellation-confirm__actions">
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onClose}>Keep order</button>
          <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={onRequest}>
            <XCircle size={13} /> {busy ? 'Cancelling…' : 'Cancel order'}
          </button>
        </div>
      </div>
      <label className="order-cancellation-note">
        <span>Cancellation note</span>
        <textarea
          className="input"
          value={note}
          onChange={event => onNoteChange(event.target.value)}
          placeholder="Why this order is being cancelled"
          rows={2}
        />
      </label>
    </section>
  );
}

function PaidExceptionResolution({ order, canReplace, lockedByCuraleaf, partialPrescription, busy, refundReference, onRefundReferenceChange, onReplace, onRequestRefund, onConfirmRefund }: {
  order: PatientOrder;
  canReplace: boolean;
  lockedByCuraleaf?: boolean;
  partialPrescription?: boolean;
  busy: boolean;
  refundReference: string;
  onRefundReferenceChange: (value: string) => void;
  onReplace: () => void;
  onRequestRefund: () => void;
  onConfirmRefund: () => void;
}) {
  const method = order.payment.route === 'worldpay' ? 'Worldpay portal' : 'ePOS';
  const reference = order.refund?.paymentReference ?? order.payment.ref ?? 'Reference unavailable';
  return (
    <section className={`order-resolution${order.refund?.status === 'completed' ? ' order-resolution--complete' : ''}`}>
      <header>
        <span><small>Paid-order resolution</small><strong>{
          lockedByCuraleaf ? 'Waiting for Curaleaf cancellation'
            : order.refund?.status === 'completed' ? 'Refund completed'
            : order.refund?.status === 'verifying' ? 'Refund reference is being verified'
            : order.refund?.status === 'reconciliation_required' ? 'Refund needs reconciliation'
            : order.refund ? 'Refund due'
            : partialPrescription ? 'Resolve cancelled prescription'
            : canReplace ? 'Choose replacement or cancel'
            : 'Refund due'
        }</strong></span>
        <span className="order-resolution__amount"><small>Order payment</small><strong>{money(order.payment.amount)}</strong></span>
      </header>
      <div className="order-resolution__reference">
        <CreditCard size={15} />
        <span><small>{method} payment ID</small><code>{reference}</code></span>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void navigator.clipboard.writeText(reference)}>Copy ID</button>
      </div>
      {lockedByCuraleaf ? (
        <div className="order-resolution__choices">
          <small>This order remains active until the platform observes Curaleaf’s cancelled prescription or purchase order. Refund and replacement stay locked until that supplier event arrives.</small>
        </div>
      ) : !order.refund ? (
        <div className="order-resolution__choices">
          {canReplace ? <button type="button" className="btn btn-primary btn-sm" onClick={onReplace}><RefreshCw size={13} /> Replace using paid balance</button> : null}
          {partialPrescription ? (
            <div className="order-resolution__locked" role="status">
              <ShieldAlert size={16} />
              <span>
                <strong>Partial refund needs a prescription allocation</strong>
                <small>This prescription can be replaced now. Cancelling it is held for finance reconciliation because the settled payment also covers an active sibling prescription; HHH will not submit a whole-order refund.</small>
              </span>
            </div>
          ) : (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onRequestRefund}><XCircle size={13} /> Cancel order</button>
          )}
          <small>{partialPrescription
            ? 'The unaffected prescription keeps its own PO and continues through fulfilment.'
            : `A replacement keeps the verified payment allocated to the new order. Cancelling opens the ${method} refund gate and the order remains actionable until its external refund reference is verified.`}</small>
        </div>
      ) : order.refund.status === 'pending_confirmation' ? (
        <div className="order-resolution__confirm">
          <ol><li>Sign in to {method}.</li><li>Find payment <code>{reference}</code> and refund {money(order.refund.amountPence / 100)}.</li><li>Enter the refund reference below and confirm. HHH records the confirmation but does not move the money.</li></ol>
          <label><span>Refund confirmation reference</span><input className="input" value={refundReference} onChange={event => onRefundReferenceChange(event.target.value)} placeholder="Worldpay refund / command ID" /></label>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || refundReference.trim().length < 3} onClick={onConfirmRefund}><CheckCircle2 size={13} /> {busy ? 'Recording…' : 'Submit reference for verification'}</button>
        </div>
      ) : order.refund.status === 'verifying' ? (
        <div className="order-resolution__locked" role="status"><RefreshCw size={16} className="spin" /><span><strong>Verifying with {order.payment.route === 'worldpay' ? 'Worldpay' : 'the payment record'}</strong><small>Reference {order.refund.externalReference ?? 'recorded'}. Keep this order open until the amount and original transaction are confirmed.</small></span></div>
      ) : order.refund.status === 'reconciliation_required' ? (
        <div className="order-resolution__locked" role="alert"><AlertTriangle size={16} /><span><strong>Do not archive this order yet</strong><small>{order.refund.verificationMessage ?? 'The refund reference or amount could not be verified against the original payment. Finance reconciliation is required.'}</small></span></div>
      ) : (
        <div className="order-resolution__completed"><CheckCircle2 size={16} /><span><strong>{money(order.refund.amountPence / 100)} refunded via {method}</strong><small>Confirmation {order.refund.externalReference ?? 'recorded'} · {formatDate(order.refund.confirmedAt, true)}</small></span></div>
      )}
    </section>
  );
}

function StageRailLane({ label, note, steps }: { label: string; note?: string | null; steps: OrderStageStep[] }) {
  return (
    <section className="order-stage-rail__lane" aria-label={`${label} progress`}>
      <p className="order-stage-rail__lane-label">
        {label}
        {note ? <span className="order-stage-rail__route">{note}</span> : null}
      </p>
      <ol className="order-stage-rail__steps">
        {steps.map((entry, index) => (
          <li key={entry.key} className={`is-${entry.state}`} aria-current={entry.state === 'active' ? 'step' : undefined}>
            <span className="order-stage-rail__marker" aria-hidden="true">
              {entry.state === 'complete' ? <Check size={11} /> : index + 1}
            </span>
            <span className="order-stage-rail__copy">
              <strong>{entry.label}</strong>
              <small>{entry.detail}</small>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Payment stays on the order header. This rail is one prescription's placement or fulfilment. */
function PrescriptionStageRail({ order, prescription }: { order: PatientOrder; prescription: Prescription }) {
  const rail = buildPrescriptionStageRail(order, prescription);
  if (rail.placement) {
    return (
      <section className="order-placement-progress order-placement-progress--rx" aria-label="Pharmacy placement">
        <div className="order-stage-rail order-stage-rail--placement">
          <StageRailLane
            label="Pharmacy placement"
            note={rail.route === 'clinic_barcode' ? 'Clinic QR' : 'Manual entry'}
            steps={rail.placement}
          />
        </div>
      </section>
    );
  }
  if (!rail.dispensing) return null;
  return (
    <div className="order-stage-rail">
      <StageRailLane label="Prescription fulfilment" steps={rail.dispensing} />
    </div>
  );
}

type FulfilmentDisplayLine = {
  productId: string;
  displayName: string;
  item: LineItem;
  orderedPacks: number;
  allocatedPacks: number;
  dispatchedPacks: number;
  consignmentPacks: number;
  receivedPacks: number;
  inTransitPacks: number;
  awaitingDispatchPacks: number;
  cancelledRemainderPacks: number;
  remainingExpectedPacks: number;
  isDeliveredOrCheckedIn: boolean;
  isSplit: boolean;
  percentReceived: number;
  percentAllocated: number;
  percentInTransit: number;
  quantityMismatch?: boolean;
  supplierReportedOrdered?: number;
};

type FulfilmentProgressSnapshot = {
  orderedPacks: number;
  allocatedPacks: number;
  dispatchedPacks: number;
  inTransitPacks: number;
  receivedPacks: number;
  awaitingDispatchPacks: number;
  isSplit: boolean;
  percentReceived: number;
  percentAllocated: number;
  percentInTransit: number;
};

function aggregateFulfilmentProgress(lines: FulfilmentDisplayLine[]): FulfilmentProgressSnapshot {
  const orderedPacks = lines.reduce((sum, line) => sum + line.orderedPacks, 0);
  const allocatedPacks = lines.reduce((sum, line) => sum + line.allocatedPacks, 0);
  const dispatchedPacks = lines.reduce((sum, line) => sum + line.dispatchedPacks, 0);
  const inTransitPacks = lines.reduce((sum, line) => sum + line.inTransitPacks, 0);
  const receivedPacks = lines.reduce((sum, line) => sum + line.receivedPacks, 0);
  const awaitingDispatchPacks = lines.reduce((sum, line) => sum + line.awaitingDispatchPacks, 0);

  return {
    orderedPacks,
    allocatedPacks,
    dispatchedPacks,
    inTransitPacks,
    receivedPacks,
    awaitingDispatchPacks,
    isSplit: lines.some(line => line.isSplit),
    percentReceived: orderedPacks > 0 ? Math.min(100, Math.round((receivedPacks / orderedPacks) * 100)) : 0,
    percentAllocated: orderedPacks > 0 ? Math.min(100, Math.round((allocatedPacks / orderedPacks) * 100)) : 0,
    percentInTransit: orderedPacks > 0 && inTransitPacks > 0
      ? Math.min(100, Math.round(((receivedPacks + inTransitPacks) / orderedPacks) * 100))
      : 0,
  };
}

function PrescriptionSwitcher({ items, selectedPrescriptionId, onSelect }: {
  items: PrescriptionWorkItem[];
  selectedPrescriptionId: number | null;
  onSelect: (prescriptionId: number) => void;
}) {
  const statusCounts = items.reduce<Record<string, number>>((counts, item) => {
    const label = recordCardTag(item.record);
    counts[label] = (counts[label] ?? 0) + 1;
    return counts;
  }, {});
  const summary = Object.entries(statusCounts).map(([label, count]) => `${count} ${label.toLowerCase()}`).join(' · ');

  const moveSelection = (currentIndex: number, direction: number) => {
    const next = items[(currentIndex + direction + items.length) % items.length]?.prescription;
    if (next) onSelect(next.id);
  };

  return (
    <section className="order-rx-switcher" aria-label="Choose prescription">
      <header>
        <span><strong>{items.length} prescriptions</strong><small>{summary}</small></span>
        <label>
          <span className="sr-only">Selected prescription</span>
          <select value={selectedPrescriptionId ?? ''} onChange={event => onSelect(Number(event.target.value))}>
            {items.map(item => item.prescription ? (
              <option value={item.prescription.id} key={item.key}>{prescriptionWorkItemLabel(item)} · {recordCardTag(item.record)}</option>
            ) : null)}
          </select>
        </label>
      </header>
      <div className="order-rx-switcher__tabs" role="tablist" aria-label="Prescriptions in this order">
        {items.map((item, index) => {
          const prescription = item.prescription;
          if (!prescription) return null;
          const selected = prescription.id === selectedPrescriptionId;
          const meta = recordStageMeta(item.record);
          const Icon = meta.icon;
          return (
            <button
              type="button"
              role="tab"
              id={`order-rx-tab-${prescription.id}`}
              aria-selected={selected}
              aria-controls={`order-rx-panel-${prescription.id}`}
              tabIndex={selected ? 0 : -1}
              className={`order-rx-switcher__tab order-tone--${meta.tone}${selected ? ' is-selected' : ''}`}
              key={item.key}
              onClick={() => onSelect(prescription.id)}
              onKeyDown={event => {
                if (event.key === 'ArrowRight') { event.preventDefault(); moveSelection(index, 1); }
                if (event.key === 'ArrowLeft') { event.preventDefault(); moveSelection(index, -1); }
                if (event.key === 'Home') { event.preventDefault(); items[0]?.prescription && onSelect(items[0].prescription.id); }
                if (event.key === 'End') { event.preventDefault(); items.at(-1)?.prescription && onSelect(items.at(-1)!.prescription!.id); }
              }}
            >
              <span className="order-rx-switcher__icon"><Icon size={14} aria-hidden="true" /></span>
              <span><strong>{`Rx ${index + 1}`}</strong><small>{recordCardTag(item.record)}</small></span>
              {prescription.purchaseOrderId ? <code title={prescription.purchaseOrderId}>{prescription.purchaseOrderId}</code> : <em>No PO</em>}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function PrescriptionCard({ order, prescription, index, busy, onReceiptDraftChange, onConfirmDelivery, onManualPlace, onChaseCuraleaf, onOpenHandout }: {
  order: PatientOrder;
  prescription: Prescription;
  index: number;
  receiptDraft: GoodsReceiptDraft;
  busy: boolean;
  onReceiptDraftChange: (patch: Partial<GoodsReceiptDraft>) => void;
  onSavePartial: (shipmentId?: string) => void;
  onConfirmDelivery: (shipmentId?: string) => void;
  onManualPlace: () => void;
  onChaseCuraleaf?: (prescription: Prescription, shipmentId?: string) => void;
  onOpenHandout?: (partial: boolean, shipmentId?: string) => void;
}) {
  const { state } = useApp();
  const shipmentIds = useMemo(() => prescription.shipmentIds?.length ? prescription.shipmentIds : prescription.shipmentId ? [prescription.shipmentId] : [], [prescription.shipmentId, prescription.shipmentIds]);
  const [selectedShipmentId, setSelectedShipmentId] = useState(shipmentIds.find(id => prescription.shipmentStates?.[id] !== 'collected') ?? shipmentIds[0] ?? '');
  const [poCopied, setPoCopied] = useState(false);
  useEffect(() => {
    if (!selectedShipmentId || !shipmentIds.includes(selectedShipmentId)) setSelectedShipmentId(shipmentIds.find(id => prescription.shipmentStates?.[id] !== 'collected') ?? shipmentIds[0] ?? '');
  }, [prescription.shipmentStates, selectedShipmentId, shipmentIds]);
  const selectedShipmentState = selectedShipmentId ? prescription.shipmentStates?.[selectedShipmentId] : undefined;
  const isCancelled = prescriptionIsCancelled(prescription);
  const statusLabel = prescriptionStatusLabel(prescription);
  const statusChipTone = prescriptionStatusChipTone(prescription);
  const totalReceivedPacks = (prescription.fulfilmentLines ?? []).reduce((sum, line) => sum + (line.received ?? 0), 0);
  const totalShippedPacks = (prescription.fulfilmentLines ?? []).reduce((sum, line) => sum + (line.shipped ?? 0), 0);
  const hasCheckedInPacks = totalReceivedPacks > 0;
  const hasShippedNotCheckedIn = totalShippedPacks > totalReceivedPacks;

  // Supply outstanding (supplier still owes packs, or goods-in has not verified a dispatch)
  // is a different question from packs waiting on the shelf for the patient.
  const supplyIncomplete = prescriptionSupplyIncomplete(prescription);
  const uncollectedReadyPacks = prescriptionUncollectedReadyPacks(prescription);
  const isCollected = !supplyIncomplete && uncollectedReadyPacks === 0 && prescription.status === 'collected';
  const selectedConsignmentCollected = selectedShipmentState === 'collected';
  const selectedConsignmentReady = selectedShipmentState === 'ready_for_collection';
  // Staff no longer press anything to tell the patient: goods-in queues that email and
  // the 15:00 London cut-off decides whether it leaves now or at 09:00 next working
  // day. Stating the answer here is the difference between an automation people trust
  // and one they work around by phoning the patient themselves.
  const collectionNotice = collectionEmailNotice(prescription.goodsInAt ? new Date(prescription.goodsInAt) : new Date());
  const selectedConsignmentReceived = (selectedShipmentState === 'received' || selectedConsignmentReady || selectedConsignmentCollected) && hasCheckedInPacks;
  const isReady = !isCollected && (prescription.status === 'ready' || selectedConsignmentReady);
  const isDelivered = !isCollected && !isReady && (prescription.status === 'received' || selectedConsignmentReceived || (hasCheckedInPacks && prescription.status === 'partially-received'));
  const isPartiallyDelivered = !isCollected && hasCheckedInPacks && (prescription.status === 'partially-received' || selectedShipmentState === 'partially_received' || (supplyIncomplete && (prescription.receivedItems?.some(item => item.quantityReceived > 0) || (prescription.fulfilmentLines ?? []).some(line => line.received > 0))));

  const selectedConsignment = selectedShipmentId
    ? prescription.shipments?.find(shipment => shipment.id === selectedShipmentId)
    : prescription.shipments?.[0];
  const consignmentPacksFor = (productId: string) => {
    const fromShipment = selectedConsignment?.items?.filter(item => item.productId === productId).reduce((sum, item) => sum + Number(item.packCount || 0), 0) ?? 0;
    if (fromShipment > 0) return fromShipment;
    const line = prescription.fulfilmentLines?.find(item => item.productId === productId);
    return line?.shipped ?? 0;
  };
  const totalConsignmentPacks = prescription.items.reduce((sum, item) => sum + consignmentPacksFor(item.productId), 0);
  const consignmentHasShippedPacks = totalConsignmentPacks > 0;

  const isDispatchedPhase = (consignmentHasShippedPacks || totalShippedPacks > 0 || prescription.dispatchStatus === 'partial' || prescription.dispatchStatus === 'complete') && (
    prescription.status === 'dispatched'
    || prescription.status === 'partially-received'
    || prescription.dispatchStatus === 'complete'
    || prescription.dispatchStatus === 'partial'
    || Boolean(selectedShipmentId)
    || Boolean(prescription.shipmentIds?.length)
  );

  const receiving = prescription.placed
    && !selectedConsignmentCollected
    && hasShippedNotCheckedIn
    && isDispatchedPhase;

  // Packs sitting in the selected consignment that goods-in verified but nobody has handed out.
  const consignmentUncollectedPacks = prescription.items.reduce((sum, item) => {
    const line = prescription.fulfilmentLines?.find(candidate => candidate.productId === item.productId);
    const uncollected = Math.max(0, (line?.received ?? 0) - (line?.collected ?? 0));
    const inConsignment = consignmentPacksFor(item.productId);
    return sum + (inConsignment > 0 ? Math.min(inConsignment, uncollected) : uncollected);
  }, 0);
  const handoutPacks = consignmentUncollectedPacks || uncollectedReadyPacks;

  const readyControl = isDelivered && !supplyIncomplete;
  const partialReadyControl = (isPartiallyDelivered || (isDelivered && supplyIncomplete)) && !selectedConsignmentReady && !selectedConsignmentCollected;
  const partialHandoutControl = supplyIncomplete
    && handoutPacks > 0
    && (selectedConsignmentReady || prescription.status === 'ready');
  const fullHandoutControl = (prescription.status === 'ready' || selectedConsignmentReady)
    && !supplyIncomplete
    && uncollectedReadyPacks > 0;
  const collectionControl = isReady && !supplyIncomplete;
  const totalOrderedPacks = prescription.items.reduce((s, i) => s + i.qty, 0);
  const totalDispatchedPacks = prescription.items.reduce((s, i) => {
    const line = prescription.fulfilmentLines?.find(l => l.productId === i.productId);
    return s + (line?.shipped ?? 0);
  }, 0);

  const resolveProductName = (item: { name?: string; productId: string; formulaId?: string }) => {
    const isGeneric = !item.name || ['Curaleaf prescription item', 'Curaleaf formulary product', 'Curaleaf medication', 'Curaleaf medicine', 'Prescribed product'].includes(item.name);
    if (!isGeneric) return item.name!;
    const cat = state.catalogue.find(c => c.id === item.productId || (item.formulaId && c.formulaId === item.formulaId));
    return cat?.name ?? item.name ?? 'Curaleaf medicine';
  };

  const displayLines = prescription.items.map(item => {
    const matchingLine = prescription.fulfilmentLines?.find(l => l.productId === item.productId || (item.formulaId && l.productId.includes(item.formulaId)));
    const orderedPacks = matchingLine?.requested || matchingLine?.ordered || item.qty;
    const allocatedPacks = matchingLine?.allocated ?? 0;
    const dispatchedPacks = matchingLine?.shipped ?? 0;
    const consignmentPacks = consignmentPacksFor(item.productId);
    const itemReceived = prescription.receivedItems?.find(it => it.productId === item.productId)?.quantityReceived;
    const receivedPacks = typeof itemReceived === 'number'
      ? itemReceived
      : (matchingLine?.received || 0);
    const consignmentCheckedIn = selectedConsignmentReceived;
    const inTransitPacks = consignmentCheckedIn
      ? 0
      : Math.max(0, consignmentPacks > 0 ? consignmentPacks : Math.max(0, dispatchedPacks - receivedPacks));
    const cancelledRemainderPacks = Math.max(0, matchingLine?.cancelledRemainder ?? 0);
    const remainingExpectedPacks = Math.max(0, matchingLine?.remainingExpected ?? orderedPacks - dispatchedPacks - cancelledRemainderPacks);
    const awaitingDispatchPacks = remainingExpectedPacks;
    const isDeliveredOrCheckedIn = receivedPacks > 0 && (consignmentCheckedIn || (!supplyIncomplete && receivedPacks >= orderedPacks));
    const isSplit = awaitingDispatchPacks > 0 && dispatchedPacks > 0;

    const percentReceived = orderedPacks > 0 ? Math.min(100, Math.round((receivedPacks / orderedPacks) * 100)) : 0;
    const percentAllocated = orderedPacks > 0 ? Math.min(100, Math.round((allocatedPacks / orderedPacks) * 100)) : 0;
    const percentInTransit = orderedPacks > 0 && inTransitPacks > 0 ? Math.min(100, Math.round(((receivedPacks + inTransitPacks) / orderedPacks) * 100)) : 0;

    return {
      productId: item.productId,
      displayName: resolveProductName(item),
      item,
      orderedPacks,
      allocatedPacks,
      dispatchedPacks,
      consignmentPacks,
      receivedPacks,
      inTransitPacks,
      awaitingDispatchPacks,
      cancelledRemainderPacks,
      remainingExpectedPacks,
      isDeliveredOrCheckedIn,
      isSplit,
      percentReceived,
      percentAllocated,
      percentInTransit,
      quantityMismatch: matchingLine?.quantityMismatch,
      supplierReportedOrdered: matchingLine?.supplierReportedOrdered,
    };
  });

  const placed = Boolean(prescription.purchaseOrderId);
  const routeLabel = prescription.entryMode === 'clinic' || prescription.clinicScanId ? 'Clinic' : 'Manual';
  const totalAwaitingDispatchPacks = displayLines.reduce((sum, line) => sum + line.awaitingDispatchPacks, 0);
  const arrivingPacks = totalConsignmentPacks || totalDispatchedPacks;
  const combinedProgress = aggregateFulfilmentProgress(displayLines);

  return (
    <div className="order-rx-pair" role="tabpanel" id={`order-rx-panel-${prescription.id}`} aria-label={`Prescription ${index + 1} fulfilment`}>
      <article className={`order-rx-card order-rx-card--unified${isCancelled ? ' order-rx-card--cancelled' : ''}`}>
        <header className="order-rx-card__header">
          <span>
            <small>Prescription {index + 1}</small>
            <strong>{routeLabel} entry</strong>
          </span>
          <div className="order-rx-card__meta">
            <strong>{money(rxRevenue(prescription))}</strong>
            <span className={`rx-status-chip rx-status-chip--${statusChipTone}`}>{statusLabel}</span>
          </div>
        </header>
        <PrescriptionStageRail order={order} prescription={prescription} />
        {prescription.manualPlaceRequired ? (
          <div className="order-ready-control">
            <span>
              <Clock3 size={16} />
              <span>
                <strong>Manual placement required</strong>
                <small>Automatic placement is disabled for this pharmacy. The final quote will be rechecked when you continue.</small>
              </span>
            </span>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={onManualPlace}>
              {busy ? 'Placing…' : 'Place prescription'}
            </button>
          </div>
        ) : null}

        <div className="order-rx-lines">
          {displayLines.map(line => (
            <div key={line.productId}>
              <span>
                <strong>{line.displayName}</strong>
                <small>
                  {line.orderedPacks} pack{line.orderedPacks === 1 ? '' : 's'}
                  {line.item.retail ? ` · ${money(lineRevenue(line.item))}` : ''}
                  {placed ? ` · ${line.allocatedPacks > 0 ? `${line.allocatedPacks} allocated` : 'Awaiting Curaleaf allocation'} · ${line.inTransitPacks} in transit · ${line.receivedPacks} checked in` : ''}
                </small>
                {line.quantityMismatch ? (
                  <span className="mismatch-tag">PO reports {line.supplierReportedOrdered} pk (mismatch)</span>
                ) : null}
                {line.cancelledRemainderPacks > 0 ? (
                  <span className="order-rx-line-note">{line.cancelledRemainderPacks} pack{line.cancelledRemainderPacks === 1 ? '' : 's'} cancelled by Curaleaf</span>
                ) : null}
              </span>
              <span className="pack-qty-badge">{line.orderedPacks} pack{line.orderedPacks === 1 ? '' : 's'}</span>
            </div>
          ))}
        </div>

        {placed ? (
          <>
            {shipmentIds.length > 1 ? (
              <div className="order-shipments-segmented-bar">
                <div className="order-shipments-segmented-bar__meta">
                  <Truck size={13} />
                  <span><strong>{shipmentIds.length} consignments dispatched</strong> · Select parcel to inspect and check in:</span>
                </div>
                <div className="order-shipments-segmented-tabs">
                  {shipmentIds.map((id, shipmentIndex) => {
                    const state = prescription.shipmentStates?.[id];
                    const isSelected = id === selectedShipmentId;
                    const formattedState = consignmentStatusLabel(state, true);
                    return (
                      <button
                        key={id}
                        type="button"
                        className={`order-shipments-tab ${isSelected ? 'order-shipments-tab--active' : ''}`}
                        onClick={() => setSelectedShipmentId(id)}
                      >
                        <span className="order-shipments-tab__title">Consignment {shipmentIndex + 1}</span>
                        <span className={`order-shipments-tab__badge order-shipments-tab__badge--${state || 'in_transit'}`}>
                          {formattedState}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="order-supplier-fulfilment">
              <header className="order-supplier-fulfilment__header">
                <div>
                  <small>
                    {prescription.purchaseOrderId ? (
                      <span className="order-supplier-fulfilment__po-row">
                        Curaleaf PO <span className="order-supplier-fulfilment__po">{prescription.purchaseOrderId}</span>
                        <button
                          type="button"
                          className="order-ledger__copy-btn"
                          aria-label={`Copy Curaleaf PO for prescription ${index + 1}`}
                          title="Copy Curaleaf PO"
                          onClick={() => {
                            void navigator.clipboard.writeText(prescription.purchaseOrderId || '');
                            setPoCopied(true);
                            window.setTimeout(() => setPoCopied(false), 2000);
                          }}
                        >
                          {poCopied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                        </button>
                      </span>
                    ) : 'Curaleaf fulfilment'}
                  </small>
                  <strong>
                    {isCancelled
                      ? 'Curaleaf cancelled this purchase order'
                      : isCollected
                      ? 'Delivered to Pharmacy — Checked In'
                      : isPartiallyDelivered
                        ? 'Partial check-in — remainder awaiting dispatch'
                        : hasShippedNotCheckedIn && prescription.dispatchStatus === 'partial'
                          ? 'Partial dispatch — check in arriving consignment'
                          : isDelivered || isReady
                            ? 'Arrived consignment checked in'
                            : prescription.dispatchStatus === 'complete'
                              ? 'Fulfilled by Curaleaf — Dispatched'
                              : prescription.dispatchStatus === 'partial'
                                ? 'Partial dispatch — remainder awaiting dispatch'
                                : isDispatchedPhase
                                  ? 'Dispatched with courier — check in arriving consignment'
                                  : prescription.purchaseOrderState === 'FULLY_ALLOCATED'
                                    ? 'Fully dispensed by Curaleaf'
                                    : prescription.purchaseOrderState === 'PROCESSING'
                                      ? 'Dispensing at Curaleaf'
                                      : 'Curaleaf purchase order active'}
                  </strong>
                </div>
              </header>
              {isCancelled ? (
                <div className="order-supplier-fulfilment__body">
                  <div className="order-fulfilment-stopped" role="status">
                    <XCircle size={18} aria-hidden="true" />
                    <span>
                      <strong>Fulfilment stopped</strong>
                      <small>
                        {combinedProgress.orderedPacks} pack{combinedProgress.orderedPacks === 1 ? '' : 's'} ordered
                        {' · '}
                        {combinedProgress.allocatedPacks} dispensed
                        {' · '}
                        {combinedProgress.inTransitPacks + combinedProgress.receivedPacks} dispatched
                        {' · '}
                        {displayLines.reduce((sum, line) => sum + line.cancelledRemainderPacks, 0)} cancelled remainder.
                        {' '}Nothing further will ship for the cancelled quantity. Use paid-order resolution above to replace or refund only what remains unresolved.
                      </small>
                    </span>
                  </div>
                </div>
              ) : null}
            </div>

            {isCancelled ? null : receiving ? (
              <div className="order-goods-in order-goods-in--compact">
                <header className="order-goods-in__header">
                  <div>
                    <span className="order-goods-in__eyebrow">Goods-in check</span>
                    <h3 className="order-goods-in__title">Accept arriving consignment</h3>
                  </div>
                  <div className="order-goods-in__header-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm order-goods-in__chase-btn"
                      onClick={() => onChaseCuraleaf?.(prescription, selectedShipmentId || undefined)}
                    >
                      <PhoneCall size={12} /> Chase Curaleaf / Issue
                    </button>
                  </div>
                </header>

                <div className="order-goods-in__consignment-summary">
                  <div className="order-goods-in__consignment-stats">
                    <span className="pill pill-blue"><PackageCheck size={11} /> {arrivingPacks} pack{arrivingPacks === 1 ? '' : 's'} Arriving</span>
                    {totalAwaitingDispatchPacks > 0 ? (
                      <span className="pill pill-amber">{totalAwaitingDispatchPacks} pack{totalAwaitingDispatchPacks === 1 ? '' : 's'} Awaiting Dispatch</span>
                    ) : (
                      <span className="pill pill-green"><Check size={11} /> Full Quantity in Consignment</span>
                    )}
                  </div>
                  <small>Verify the physical delivery matches the line items above, then accept to record pharmacy check-in.</small>
                </div>

                <div className="order-goods-in__footer">
                  <div className="order-goods-in__summary-pill">
                    <span className="order-goods-in__status-badge order-goods-in__status-badge--ready">
                      <CheckCircle2 size={14} /> Manifest Verified ({arrivingPacks} pk)
                    </span>
                  </div>
                  <div className="order-goods-in__actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={busy || arrivingPacks < 1}
                      onClick={() => {
                        const allArrived: Record<string, number> = {};
                        prescription.items.forEach(it => { allArrived[it.productId] = consignmentPacksFor(it.productId); });
                        onReceiptDraftChange({ quantities: allArrived });
                        onConfirmDelivery(selectedShipmentId || undefined);
                      }}
                    >
                      <PackageCheck size={15} />
                      {busy ? 'Recording delivery…' : `Accept Delivery (${arrivingPacks} pk)`}
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
            {!isCancelled && !receiving && !partialReadyControl && !readyControl && !partialHandoutControl && !fullHandoutControl && !collectionControl && hasShippedNotCheckedIn ? (
              <div className="order-ready-control order-ready-control--hint">
                <span>
                  <PackageCheck size={16} style={{ color: 'var(--tenant-primary)' }} />
                  <span>
                    <strong>Check in arriving packs before partial handover</strong>
                    <small>{totalShippedPacks - totalReceivedPacks} pack(s) dispatched from Curaleaf are not checked in yet. Accept delivery when the consignment arrives — that books the packs in and tells the patient — then hand over the arrived quantity.</small>
                  </span>
                </span>
              </div>
            ) : null}
            {!isCancelled && partialReadyControl ? (
              <div className="order-ready-control order-ready-control--notified" style={{ background: 'color-mix(in srgb, #f59e0b 8%, var(--bg-surface))', borderColor: 'color-mix(in srgb, #f59e0b 30%, var(--border))' }}>
                <span>
                  <Mail size={16} style={{ color: '#d97706' }} />
                  <span>
                    <strong>Arrived consignment checked in ({arrivingPacks} pk) · {collectionNotice.summary}</strong>
                    <small>{collectionNotice.detail}{supplyIncomplete && totalOrderedPacks > totalDispatchedPacks ? ` ${totalOrderedPacks - totalDispatchedPacks} pack(s) still to dispatch in a later shipment.` : ''}</small>
                  </span>
                </span>
              </div>
            ) : null}
            {!isCancelled && readyControl ? (
              <div className="order-ready-control order-ready-control--notified" style={{ background: 'color-mix(in srgb, var(--tenant-primary) 6%, var(--bg-surface))', borderColor: 'color-mix(in srgb, var(--tenant-primary) 25%, var(--border))' }}>
                <span>
                  <CheckCircle2 size={18} style={{ color: 'var(--tenant-primary)' }} />
                  <span>
                    <strong>All packs checked in ({totalOrderedPacks} pk) · {collectionNotice.summary}</strong>
                    <small>Verified by {prescription.goodsInBy ?? 'Pharmacy staff'}{prescription.goodsInAt ? ` on ${formatDate(prescription.goodsInAt, true)}` : ''}. {collectionNotice.detail}</small>
                  </span>
                </span>
              </div>
            ) : null}
            {!isCancelled && partialHandoutControl && onOpenHandout ? (
              <div className="order-ready-control" style={{ background: 'color-mix(in srgb, var(--tenant-primary) 6%, var(--bg-surface))', borderColor: 'color-mix(in srgb, var(--tenant-primary) 25%, var(--border))' }}>
                <span>
                  <PackageCheck size={16} style={{ color: 'var(--tenant-primary)' }} />
                  <span>
                    <strong>Arrived packs ready — partial handover available</strong>
                    <small>Hand over only the checked-in packs now. Remaining packs will ship separately.</small>
                  </span>
                </span>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => onOpenHandout(true, selectedShipmentId || undefined)}>
                  <Check size={13} /> Partial handover ({handoutPacks} pk)
                </button>
              </div>
            ) : null}
            {!isCancelled && fullHandoutControl && onOpenHandout ? (
              <div className="order-ready-control">
                <span>
                  <PackageCheck size={16} />
                  <span>
                    <strong>All packs ready for handover</strong>
                    <small>Every ordered pack has been checked in and is ready for patient collection.</small>
                  </span>
                </span>
                <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => onOpenHandout(false, selectedShipmentId || undefined)}>
                  <Check size={13} /> Hand over
                </button>
              </div>
            ) : null}
            {!isCancelled && collectionControl ? (
              <div className="order-ready-confirmed">
                <Mail size={16} />
                <span>
                  <strong>Medicine ready for patient collection</strong>
                  <small>Collection email notification queued{prescription.readyAt ? ` on ${formatDate(prescription.readyAt, true)}` : ''}. Hand over the medicine when the patient arrives at the dispensary.</small>
                </span>
              </div>
            ) : null}
          </>
        ) : null}
      </article>
    </div>
  );
}

function LedgerCopyButton({ detailKey, copyKey, value, label, copiedDetailKey, onCopy }: {
  detailKey: string;
  copyKey: string;
  value: string;
  label: string;
  copiedDetailKey: string | null;
  onCopy: (key: string, text: string) => void;
}) {
  return (
    <button
      type="button"
      className="order-ledger__copy-btn"
      onClick={() => onCopy(copyKey, value)}
      title={`Copy ${label}`}
      aria-label={`Copy ${label}`}
    >
      {copiedDetailKey === detailKey ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
    </button>
  );
}

function LedgerValue({ children, mono = false, muted = false, title }: {
  children: React.ReactNode;
  mono?: boolean;
  muted?: boolean;
  title?: string;
}) {
  return (
    <span
      className={`order-ledger__value ${mono ? 'order-ledger__value--mono' : ''} ${muted ? 'order-ledger__value--muted' : ''}`}
      title={title}
    >
      {children}
    </span>
  );
}

function OrderDetailsDrawer({ order, selectedPrescription, selectedPrescriptionIndex, pharmacyName, showOrderDetails, onToggle, copiedDetailKey, onCopy, resolveProductName }: {
  order: PatientOrder;
  selectedPrescription: Prescription | null;
  selectedPrescriptionIndex: number;
  pharmacyName: string | null;
  showOrderDetails: boolean;
  onToggle: () => void;
  copiedDetailKey: string | null;
  onCopy: (key: string, text: string) => void;
  resolveProductName: (item: { name?: string; productId: string; formulaId?: string }) => string;
}) {
  const detailOrder = selectedPrescription ? { ...order, prescriptions: [selectedPrescription] } : order;
  const consignments = collectOrderConsignments(detailOrder);
  const courierLabel = orderCourierLabel(detailOrder);
  const deliveryDestination = orderDeliveryDestination(detailOrder, pharmacyName);
  const paymentReference = order.payment.manualReference ?? order.payment.ref ?? null;
  const registration = selectedPrescription?.prescriberGmcNumber
    ? `GMC ${selectedPrescription.prescriberGmcNumber}`
    : selectedPrescription?.prescriberGphcNumber
      ? `GPhC ${selectedPrescription.prescriberGphcNumber}`
      : null;

  return (
    <div className="order-details-drawer">
      <button
        type="button"
        className="order-details-drawer__toggle-btn"
        onClick={onToggle}
        aria-expanded={showOrderDetails}
        aria-controls="order-details-drawer-content"
      >
        <strong>{showOrderDetails ? 'Hide details' : 'Order details'}</strong>
        {showOrderDetails ? <ChevronUp size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
      </button>

      {showOrderDetails ? (
        <div id="order-details-drawer-content" className="order-details-drawer__content">
          {selectedPrescription ? <section className="order-details-block order-details-block--prescriptions">
            <h3>{`Prescription ${selectedPrescriptionIndex + 1} details`}</h3>
            <div className="order-details-prescription-grid">
                  <article className="order-details-prescription-card" key={selectedPrescription.id}>
                    <h4>{prescriptionStatusLabel(selectedPrescription)}</h4>
                    <dl className="order-details-kv">
                      <div>
                        <dt>Curaleaf PO</dt>
                        <dd className="order-details-value">
                          <LedgerValue mono>{selectedPrescription.purchaseOrderId ?? 'No Curaleaf PO created yet'}</LedgerValue>
                          {selectedPrescription.purchaseOrderId ? <LedgerCopyButton detailKey={`po_${selectedPrescription.id}`} copyKey={`po_${selectedPrescription.id}`} value={selectedPrescription.purchaseOrderId} label="PO reference" copiedDetailKey={copiedDetailKey} onCopy={onCopy} /> : null}
                        </dd>
                      </div>
                      {selectedPrescription.serialNumber ? (
                        <div>
                          <dt>Prescription serial</dt>
                          <dd className="order-details-value">
                            <LedgerValue mono>{selectedPrescription.serialNumber}</LedgerValue>
                            <LedgerCopyButton detailKey={`serial_${selectedPrescription.id}`} copyKey={`serial_${selectedPrescription.id}`} value={selectedPrescription.serialNumber} label="serial number" copiedDetailKey={copiedDetailKey} onCopy={onCopy} />
                          </dd>
                        </div>
                      ) : null}
                      {selectedPrescription.curaleafPrescriptionId ? (
                        <div>
                          <dt>Curaleaf prescription</dt>
                          <dd className="order-details-value">
                            <LedgerValue mono>{selectedPrescription.curaleafPrescriptionId}</LedgerValue>
                            <LedgerCopyButton detailKey={`rx_${selectedPrescription.id}`} copyKey={`rx_${selectedPrescription.id}`} value={selectedPrescription.curaleafPrescriptionId} label={`Prescription ${selectedPrescriptionIndex + 1} Rx ID`} copiedDetailKey={copiedDetailKey} onCopy={onCopy} />
                          </dd>
                        </div>
                      ) : null}
                      {selectedPrescription.prescriber || registration ? (
                        <div>
                          <dt>Prescriber</dt>
                          <dd><LedgerValue>{[selectedPrescription.prescriber, registration].filter(Boolean).join(' · ')}</LedgerValue></dd>
                        </div>
                      ) : null}
                      {selectedPrescription.issueDate ? <div><dt>Issued</dt><dd><LedgerValue>{formatDate(selectedPrescription.issueDate)}</LedgerValue></dd></div> : null}
                      {selectedPrescription.expiryDate ? <div><dt>Expires</dt><dd><LedgerValue>{formatDate(selectedPrescription.expiryDate)}</LedgerValue></dd></div> : null}
                    </dl>
                  </article>
            </div>
            <dl className="order-details-kv order-details-kv--products">
              {selectedPrescription.items.map((item, itemIdx) => (
                <div key={`${selectedPrescription.id}-${item.productId}-${itemIdx}`}>
                  <dt className="order-details-product">
                    <span className="order-details-product-name" title={resolveProductName(item)}>{resolveProductName(item)}</span>
                    <span className="order-details-qty">{item.qty} × {money(item.retail)}</span>
                  </dt>
                  <dd><LedgerValue>{money(item.retail * item.qty)}</LedgerValue></dd>
                </div>
              ))}
              <div className="order-details-total"><dt>Prescription subtotal</dt><dd><LedgerValue>{money(rxRevenue(selectedPrescription))}</LedgerValue></dd></div>
            </dl>
          </section> : null}

          {consignments.length ? (
            <section className="order-details-block">
              <h3>Dispatch</h3>
              <p className="order-details-summary">
                {[courierLabel, deliveryDestination].filter(Boolean).join(' · ') || 'Curaleaf courier'}
              </p>
              <ul className="order-details-consignments">
                {consignments.map((consignment, index) => (
                  <li key={consignment.id}>
                    <span>
                      <strong>{consignments.length > 1 ? `Consignment ${index + 1}` : 'Consignment'}</strong>
                      {' · '}
                      {consignment.statusLabel}
                      {consignment.packCount ? ` · ${consignment.packCount} pack${consignment.packCount === 1 ? '' : 's'}` : ''}
                    </span>
                    <span className="order-details-value">
                      <LedgerValue mono>{shortConsignmentId(consignment.id)}</LedgerValue>
                      <LedgerCopyButton detailKey={`shp_${consignment.id}`} copyKey={`shp_${consignment.id}`} value={consignment.id} label="consignment ID" copiedDetailKey={copiedDetailKey} onCopy={onCopy} />
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="order-details-block">
            <h3>{order.payment.status === 'paid' ? 'Order payment' : 'Order amount due'}</h3>
            <dl className="order-details-kv">
              <div><dt>Prescription total</dt><dd><LedgerValue>{money(order.prescriptions.reduce((sum, rx) => sum + rxRevenue(rx), 0))}</LedgerValue></dd></div>
              {order.dispensingFee ? (
                <div>
                  <dt>Dispensing fee</dt>
                  <dd><LedgerValue>{money(order.dispensingFee)}</LedgerValue></dd>
                </div>
              ) : null}
              {order.pharmacyDelivery ? (
                <div>
                  <dt>Pharmacy Delivery</dt>
                  <dd><LedgerValue>{money(order.pharmacyDelivery)}</LedgerValue></dd>
                </div>
              ) : null}
              <div className="order-details-total">
                <dt>Total</dt>
                <dd><LedgerValue>{money(order.payment.amount)}</LedgerValue></dd>
              </div>
            </dl>
            <p className="order-details-summary">
              {[
                order.payment.route === 'worldpay' ? 'Worldpay' : 'Pharmacy managed',
                order.payment.paidAt ? `Paid ${formatDate(order.payment.paidAt, true)}` : order.payment.sentAt ? `Requested ${formatDate(order.payment.sentAt, true)}` : null,
                paymentReference && !order.prescriptions.some(rx => rx.purchaseOrderId === paymentReference) ? `Ref ${paymentReference}` : null,
              ].filter(Boolean).join(' · ')}
            </p>
          </section>

          <section className="order-details-block order-details-block--timeline">
            <details className="order-activity-log">
              <summary>
                <ChevronDown size={14} aria-hidden="true" />
                Activity log
              </summary>
              <p className="order-activity-log__help">Sources show whether a step was recorded by pharmacy staff or completed automatically. Times are exact audit timestamps.</p>
              <OrderTimeline order={order} />
            </details>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function OrderTimeline({ order }: { order: PatientOrder & { handoutAt?: Date | string | null; handoutRecipient?: string | null } }) {
  const events = buildOrderTimelineEvents(order);
  if (!events.length) {
    return <p className="order-ledger__empty">No activity recorded yet.</p>;
  }
  return (
    <ol className="order-details-timeline">
      {events.map((event, index) => (
        <li key={`${event.label}-${index}`}>
          <span className={`order-details-timeline__marker order-details-timeline__marker--${event.source.toLowerCase().replaceAll(' ', '-')}`} aria-hidden="true" />
          <div className="order-details-timeline__event">
            <span className="order-details-timeline__heading">
              <strong>{event.label}</strong>
              <small className="order-details-timeline__source">{event.source}</small>
            </span>
            {event.detail && !event.detail.startsWith('PO ') ? <small>{event.detail}</small> : null}
          </div>
          <div className="order-details-timeline__meta">
            {event.date ? <time dateTime={new Date(event.date).toISOString()}>{formatTimelineDate(event.date)}</time> : null}
            {event.detail?.startsWith('PO ') ? <small>{event.detail}</small> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
