import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle, ChevronDown, ChevronRight, Clock3, Inbox, LayoutGrid, List, Lock, Mail, MapPin, Package, Pencil, Phone, Plus, Search, Users, XCircle, type LucideIcon } from 'lucide-react';
import { PATIENT_PRICE_LABEL, WHOLESALE_LABEL, formatMargin, getUnresolvedReason, marginPercent, marginToneClass, orderReference, useApp, money, orderRevenue, RX_STATUS_LABELS } from '../context/AppContext';
import type { CRMPatient, EligibilitySubmission, PatientOrder, PendingEnquiry } from '../context/AppContext';
import { onboardingStatusLabel, onboardingStatusPillClass } from '../utils/onboardingStatus';
import { compactPatientName } from '../utils/patientName';
import { formatPatientDob } from '../utils/patientDob';
import { conditionLabel } from '@hhh/domain';
import RecordDialog from '../components/RecordDialog';
import ConditionList from '../components/ConditionList';
import ConditionEditor from '../components/ConditionEditor';
import { updatePatientConditions } from '../shared/api';
import MedicineLabel from '../components/MedicineLabel';
import { canCreateOrderForPatient } from '../utils/patientOrderEligibility';
import { isLocalPortalPreview } from '../dev/localPortalPreview';
import { isTrainingSandboxPatient } from '../training/workspace';
import { isNegativeEligibilityStatus, pharmacyDecisionReason } from '../utils/eligibilityPresentation';
import {
  derivePatientJourneyStage,
  PATIENT_JOURNEY_STEPS,
  patientClinicalProfile,
  patientJourneyStepIndex,
  portalSourceLabel,
  type PatientJourneyStage,
} from '../utils/pharmacyPatientDirectory';
import { orderAwaitingCuraleafCancel, orderCancellationResolution, orderRequiresCuraleafCancel } from '../utils/orderStage';
import {
  directoryContextFromHistory,
  patientCrmUrl,
  selectedCrmKeyFromSearch,
  type PatientDirectoryFilter,
} from '../utils/patientDirectoryNavigation';
import {
  PATIENT_CRM_CLOSED_LANE,
  PATIENT_CRM_LANES,
  patientCrmGroup,
  patientCrmLane,
  patientCrmRecordKey,
  patientCrmStatusMeta,
  recordMatchesPatientFilter,
  type PatientCrmIcon,
  type PatientCrmLane,
} from '../utils/patientCrm';

/** Placeholders keep every row present so a gap reads as "we do not hold this". */
const NOT_RECORDED = 'Not recorded';
const EMPTY_FIELD = '—';

/**
 * Older eligibility records often stored the postcode as the whole address, which
 * then rendered twice in the contact card. Collapse that case to a single line.
 */
function patientAddressLines(address: string | undefined, postcode: string | undefined) {
  const line = (address ?? '').trim();
  const code = (postcode ?? '').trim();
  const comparable = (value: string) => value.replace(/\s+/g, '').toLowerCase();
  if (!code) return { line, postcode: '', postcodeIsSeparate: false };
  if (!line) return { line: code, postcode: code, postcodeIsSeparate: false };
  return {
    line,
    postcode: code,
    postcodeIsSeparate: comparable(line) !== comparable(code),
  };
}

interface UnifiedPatient {
  id: string;
  name: string;
  email: string;
  mobile: string;
  dob: string;
  crmPatient: CRMPatient | null;
  submission: EligibilitySubmission | null;
  orders: PatientOrder[];
}

interface CrmRecord {
  key: string;
  kind: 'enquiry' | 'patient';
  id: string;
  name: string;
  email: string;
  mobile: string;
  dob: string;
  primaryCondition: string;
  sourceLabel: string | null;
  /** Street address is patient-record only; the enquiry contract exposes a postcode. */
  address: string;
  postcode: string;
  caseReference: string;
  enquiry: PendingEnquiry | null;
  patient: UnifiedPatient | null;
  status: ReturnType<typeof deriveStatus>;
  journey: PatientJourneyStage;
  hasCrmRecord: boolean;
  hasOpenOrder: boolean;
  needsAction: boolean;
  readyForCollection: boolean;
  overdueCollection: boolean;
}

const CRM_ICONS: Record<PatientCrmIcon, LucideIcon> = {
  inbox: Inbox,
  alert: AlertTriangle,
  package: Package,
  check: CheckCircle,
  users: Users,
  clock: Clock3,
  lock: Lock,
};

function supplierOrderCancelled(order: PatientOrder) {
  return order.prescriptions.some(prescription => prescription.purchaseOrderState === 'CANCELLED' || prescription.status === 'cancelled')
    || order.curaleafCancellation?.status === 'confirmed'
    || order.cancellation?.status === 'refund_required'
    || order.unresolvedReason === 'cancelled';
}

function orderExceptionReason(order: PatientOrder): 'rejected' | 'expired' | 'cancelled' | null {
  if (order.prescriptions.length > 0 && order.prescriptions.every(prescription => prescription.status === 'collected')) return null;
  if (order.unresolvedReason === 'rejected' || order.quoteReview?.status === 'recreate_required') return 'rejected';
  if (supplierOrderCancelled(order)) return 'cancelled';
  if (order.unresolvedReason === 'expired' || order.lifecycleStatus === 'archived' || order.isExpired) return 'expired';
  const unresolved = getUnresolvedReason(order);
  if (unresolved === 'cancelled' || unresolved === 'rejected' || unresolved === 'expired') return unresolved;
  return null;
}

function operationalOrder(order: PatientOrder) {
  return order.lifecycleStatus !== 'cancelled' && !orderExceptionReason(order);
}

function orderNeedsResolution(order: PatientOrder) {
  if (order.redoneByOrderId) return false;
  if (orderAwaitingCuraleafCancel(order)) return true;
  return Boolean(orderExceptionReason(order)) && order.refund?.status !== 'completed';
}

function deriveStatus(p: UnifiedPatient): { label: string; compactLabel: string; pill: string } {
  if (p.orders.length > 0) {
    const cancellationPending = p.orders.find(order => orderAwaitingCuraleafCancel(order) && !order.redoneByOrderId);
    if (cancellationPending) return { label: 'Supplier cancellation pending', compactLabel: 'Cancellation pending', pill: 'pill-red' };
    const cancellationAction = p.orders.find(order => orderCancellationResolution(order) === 'needs-action' && !order.redoneByOrderId);
    if (cancellationAction?.refund?.status === 'pending_confirmation' || cancellationAction?.cancellation?.status === 'refund_required') {
      return { label: 'Refund confirmation needed', compactLabel: 'Refund due', pill: 'pill-red' };
    }
    if (cancellationAction) return { label: 'Cancellation needs action', compactLabel: 'Action needed', pill: 'pill-red' };
    const unresolved = p.orders.find(order => orderExceptionReason(order) && !order.redoneByOrderId);
    if (unresolved?.refund?.status === 'pending_confirmation') return { label: 'Refund confirmation needed', compactLabel: 'Refund pending', pill: 'pill-amber' };
    if (unresolved && orderCancellationResolution(unresolved) === 'refunded') return { label: 'Refunded', compactLabel: 'Refunded', pill: 'pill-neutral' };
    if (unresolved?.refund?.status === 'completed' && !orderRequiresCuraleafCancel(unresolved)) return { label: 'Refunded', compactLabel: 'Refunded', pill: 'pill-neutral' };
    if (unresolved) {
      const replacementDraft = p.orders.some(order => order.payment.status === 'none' && order.redoContext?.originalOrderId === unresolved.id);
      return replacementDraft
        ? { label: 'Replacement in progress', compactLabel: 'Replacing', pill: 'pill-info' }
        : { label: 'Paid order needs resolution', compactLabel: 'Action needed', pill: 'pill-red' };
    }
    const operational = p.orders.filter(operationalOrder);
    if (operational.some(o => o.payment.status === 'paid' && o.prescriptions.some(rx => rx.status === 'ready')))
      return { label: 'Ready for collection', compactLabel: 'Ready', pill: 'pill-green' };
    if (operational.some(o => o.payment.status === 'paid' && o.prescriptions.some(rx => rx.status !== 'ready' && rx.status !== 'collected')))
      return { label: 'In fulfilment', compactLabel: 'Fulfilment', pill: 'pill-info' };
    if (operational.some(o => o.payment.status === 'paid' && o.prescriptions.every(rx => rx.status === 'collected')))
      return { label: 'Collected', compactLabel: 'Collected', pill: 'pill-neutral' };
    if (operational.some(o => o.payment.status === 'sent'))
      return { label: 'Awaiting payment', compactLabel: 'Awaiting payment', pill: 'pill-amber' };
    if (operational.some(o => o.payment.status === 'none' && o.prescriptions.some(rx => rx.items.length > 0)))
      return { label: 'Order in progress', compactLabel: 'In progress', pill: 'pill-info' };
  }

  if (p.submission) {
    switch (p.submission.status) {
      case 'Under HHH review':
        return { label: onboardingStatusLabel(p.submission.status), compactLabel: 'Review', pill: onboardingStatusPillClass(p.submission.status) };
      case 'New':
        return { label: onboardingStatusLabel(p.submission.status), compactLabel: 'New', pill: onboardingStatusPillClass(p.submission.status) };
      case 'Approved':
        return { label: onboardingStatusLabel(p.submission.status), compactLabel: 'Onboarded', pill: onboardingStatusPillClass(p.submission.status) };
      case 'Declined':
        return { label: onboardingStatusLabel(p.submission.status), compactLabel: 'Declined', pill: onboardingStatusPillClass(p.submission.status) };
      case 'Rejected':
        return { label: onboardingStatusLabel(p.submission.status), compactLabel: 'Rejected', pill: onboardingStatusPillClass(p.submission.status) };
    }
  }

  if (p.crmPatient) {
    const label = onboardingStatusLabel(p.crmPatient.status);
    return { label, compactLabel: label, pill: onboardingStatusPillClass(p.crmPatient.status) };
  }

  return { label: '—', compactLabel: '—', pill: 'pill-neutral' };
}

function deriveJourneyStage(p: UnifiedPatient): PatientJourneyStage {
  return derivePatientJourneyStage({
    crmPatient: p.crmPatient,
    submission: p.submission,
    orderCount: p.orders.length,
    isNegativeEligibility: isNegativeEligibilityStatus,
  });
}

function journeyLabel(stage: PatientJourneyStage) {
  if (stage === 'declined') return 'Declined';
  if (stage === 'suspended') return 'Suspended';
  return PATIENT_JOURNEY_STEPS[patientJourneyStepIndex(stage)]?.label ?? 'Enquiry';
}

function hasOverdueCollection(orders: PatientOrder[]) {
  return orders.some(order => (
    order.payment.status === 'paid'
    && order.prescriptions.some(rx => {
      if (rx.status !== 'ready' || !rx.readyAt) return false;
      const diffDays = Math.floor((Date.now() - new Date(rx.readyAt).getTime()) / (1000 * 60 * 60 * 24));
      return diffDays >= 10;
    })
  ));
}

function patientHasOpenOrder(patient: UnifiedPatient) {
  return patient.orders.some(order => orderExceptionReason(order) ? orderNeedsResolution(order) : order.payment.status === 'sent' || order.prescriptions.some(rx => rx.status !== 'collected'));
}

function patientNeedsAction(patient: UnifiedPatient) {
  const label = deriveStatus(patient).label.toLowerCase();
  return label.includes('needs') || label.includes('refund confirmation');
}

function enquiryDisplayName(enquiry: PendingEnquiry) {
  return `${enquiry.firstName} ${enquiry.surname}`.trim() || enquiry.caseReference;
}

function enquiryStatus(enquiry: PendingEnquiry): ReturnType<typeof deriveStatus> {
  return {
    label: enquiry.displayStatus,
    compactLabel: enquiry.displayStatus === 'New enquiry' ? 'New' : 'Review',
    pill: onboardingStatusPillClass(enquiry.displayStatus === 'New enquiry' ? 'New' : enquiry.displayStatus),
  };
}

function newOrderGateMessage(workspaceLive: boolean, patient: UnifiedPatient, trainingDraft: boolean): string | null {
  if (!workspaceLive && !trainingDraft) return 'HHH must flip this workspace live before creating an order.';
  if (!canCreateOrderForPatient(patient.crmPatient)) {
    return 'Orders unlock once HHH marks the patient Referred or Active. Enquiry and review stages must complete first.';
  }
  if (!workspaceLive && trainingDraft) return 'Training draft only. Payment stays locked until Curaleaf is live.';
  if (patient.crmPatient?.status === 'Referred') return 'Create this approved referral’s first prescription order.';
  return 'Create a new prescription order.';
}

function fmtDate(d: Date | string) {
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function recordMatchesQuery(record: CrmRecord, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    record.name,
    record.email,
    record.mobile,
    record.dob,
    formatPatientDob(record.dob),
    record.primaryCondition ? conditionLabel(record.primaryCondition) : '',
    record.enquiry?.caseReference ?? '',
    record.sourceLabel ?? '',
    record.status.label,
  ].some(value => value.toLowerCase().includes(q));
}

function emptyCopy(filter: PatientDirectoryFilter, hasSearch: boolean) {
  if (hasSearch) return { title: 'No matching records', detail: 'Try a different name, contact detail, condition, or case reference.' };
  switch (filter) {
    case 'enquiries':
      return { title: 'No open enquiries', detail: 'New QR or website-chosen enquiries appear here until HHH refers them or moves them to another pharmacy.' };
    case 'active':
      return { title: 'No active patients yet', detail: 'Patients appear here once HHH completes referral and activates their pharmacy record.' };
    case 'on-order':
      return { title: 'No patients on order', detail: 'Patients with draft, awaiting payment, or in-fulfilment orders will show in this view.' };
    case 'needs-action':
      return { title: 'Nothing needs action', detail: 'Paid exceptions, cancellations and refund follow-up will appear here.' };
    case 'ready':
      return { title: 'No collections waiting', detail: 'Patients with medicine ready at the pharmacy will appear here.' };
    case 'declined':
      return { title: 'No closed records', detail: 'Declined, rejected or suspended records will appear here.' };
    default:
      return { title: 'Patient CRM is empty', detail: 'Enquiries and referred patients for this pharmacy will appear in one list.' };
  }
}

export default function Patients() {
  const { state, dispatch } = useApp();
  const [search, setSearch] = useState('');
  const [activeFilter, setActiveFilter] = useState<PatientDirectoryFilter>('all');
  const [selectedKey, setSelectedKey] = useState<string | null>(() => selectedCrmKeyFromSearch(window.location.search));
  const [showClosed, setShowClosed] = useState(false);
  // Board is the triage view; List is the same records with the contact detail the
  // narrow lane cards have no room for. Both read the same search and declined filters.
  const [view, setView] = useState<'board' | 'list'>('board');

  const patients = useMemo(() => {
    const map = new Map<string, UnifiedPatient>();
    for (const crm of state.crm.filter(patient => patient.organisationId === state.currentOrganisationId)) {
      map.set(crm.email.toLowerCase(), {
        id: crm.id,
        name: crm.name,
        email: crm.email,
        mobile: crm.mobile,
        dob: crm.dob ?? '',
        crmPatient: crm,
        submission: null,
        orders: state.orders.filter(o => o.patientId === crm.id),
      });
    }
    return Array.from(map.values());
  }, [state.crm, state.orders, state.currentOrganisationId]);

  const enquiries = useMemo(() => (
    state.enquiries.filter(enquiry => enquiry.organisationId === state.currentOrganisationId)
  ), [state.enquiries, state.currentOrganisationId]);

  const records = useMemo<CrmRecord[]>(() => {
    const patientEmails = new Set(patients.map(patient => patient.email.toLowerCase()));
    const patientRecords: CrmRecord[] = patients.map(patient => {
      const status = deriveStatus(patient);
      return {
        key: patientCrmRecordKey('patient', patient.id),
        kind: 'patient',
        id: patient.id,
        name: patient.name,
        email: patient.email,
        mobile: patient.mobile,
        dob: patient.dob,
        primaryCondition: patient.submission?.primaryCondition ?? patient.crmPatient?.primaryCondition ?? patient.submission?.conditions?.[0] ?? patient.crmPatient?.conditions?.[0] ?? '',
        sourceLabel: portalSourceLabel(patient.crmPatient?.referralSource ?? patient.submission?.source ?? null),
        address: patient.crmPatient?.address ?? '',
        postcode: patient.crmPatient?.postcode ?? '',
        caseReference: '',
        enquiry: null,
        patient,
        status,
        journey: deriveJourneyStage(patient),
        hasCrmRecord: Boolean(patient.crmPatient),
        hasOpenOrder: patientHasOpenOrder(patient),
        needsAction: patientNeedsAction(patient),
        readyForCollection: status.label === 'Ready for collection',
        overdueCollection: hasOverdueCollection(patient.orders),
      };
    });
    const enquiryRecords: CrmRecord[] = enquiries
      .filter(enquiry => !patientEmails.has(enquiry.email.toLowerCase()))
      .map(enquiry => ({
        key: patientCrmRecordKey('enquiry', enquiry.id),
        kind: 'enquiry' as const,
        id: enquiry.id,
        name: enquiryDisplayName(enquiry),
        email: enquiry.email,
        mobile: enquiry.mobile,
        dob: enquiry.dob,
        primaryCondition: enquiry.primaryCondition ?? enquiry.conditions[0] ?? '',
        sourceLabel: portalSourceLabel(enquiry.sourceType),
        // The enquiry contract carries a postcode and no street address, so the list
        // shows exactly that rather than inventing a fuller address for a record the
        // pharmacy has not been given.
        address: '',
        postcode: enquiry.postcode ?? '',
        caseReference: enquiry.caseReference,
        enquiry,
        patient: null,
        status: enquiryStatus(enquiry),
        journey: 'enquiry' as const,
        hasCrmRecord: false,
        hasOpenOrder: false,
        needsAction: false,
        readyForCollection: false,
        overdueCollection: false,
      }));
    const groupOrder = ['needs-action', 'enquiries', 'ready', 'on-order', 'care', 'declined'] as const;
    return [...patientRecords, ...enquiryRecords].sort((left, right) => {
      const groupDiff = groupOrder.indexOf(patientCrmGroup(left)) - groupOrder.indexOf(patientCrmGroup(right));
      return groupDiff || left.name.localeCompare(right.name, 'en', { sensitivity: 'base' });
    });
  }, [enquiries, patients]);

  const filtered = useMemo(() => (
    records.filter(record => recordMatchesPatientFilter(record, activeFilter) && recordMatchesQuery(record, search))
  ), [activeFilter, records, search]);

  const lanes = useMemo(() => {
    const buckets = new Map<PatientCrmLane, CrmRecord[]>();
    for (const record of filtered) {
      const lane = patientCrmLane(record);
      const list = buckets.get(lane) ?? [];
      list.push(record);
      buckets.set(lane, list);
    }
    return buckets;
  }, [filtered]);

  // Nothing is auto-selected any more: the board is the view, the dialog is opt-in.
  const selected = records.find(record => record.key === selectedKey) ?? null;

  useEffect(() => {
    const selection = selected ? { kind: selected.kind, id: selected.id } : null;
    const next = patientCrmUrl(window.location.href, selection);
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next !== current) window.history.replaceState(window.history.state, '', next);
  }, [selected]);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const context = directoryContextFromHistory(event.state);
      if (context) {
        setSearch(context.search);
        setActiveFilter(context.filter);
      }
      setSelectedKey(selectedCrmKeyFromSearch(window.location.search));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const target = state.navigationTarget;
    if (target?.kind === 'patient-lane') {
      if (target.lane === 'enquiries') {
        setActiveFilter('enquiries');
        setView('list');
        setSearch('');
        setSelectedKey(null);
      }
      dispatch({ type: 'CLEAR_NAVIGATION_TARGET' });
      return;
    }
    if (target?.kind !== 'patient') return;
    const record = records.find(item => item.kind === 'patient' && item.id === target.id);
    if (record) {
      setActiveFilter('all');
      setSearch('');
      setSelectedKey(record.key);
    }
    dispatch({ type: 'CLEAR_NAVIGATION_TARGET' });
  }, [dispatch, records, state.navigationTarget]);

  const closeRecord = () => {
    setSelectedKey(null);
  };

  const handleCreateOrder = (patient: UnifiedPatient) => {
    const crmPatient = patient.crmPatient;
    const trainingDraft = Boolean(crmPatient && isTrainingSandboxPatient(crmPatient));
    if (!isLocalPortalPreview && state.workspaceMode !== 'live' && !trainingDraft) {
      dispatch({ type: 'ADD_TOAST', message: 'Orders unlock after HHH flips this workspace live.', toastType: 'warning' });
      return;
    }
    if (!canCreateOrderForPatient(crmPatient)) {
      dispatch({ type: 'ADD_TOAST', message: 'Orders stay locked until HHH completes referral.', toastType: 'warning' });
      return;
    }
    dispatch({ type: 'NEW_ORDER', patientId: crmPatient.id });
    dispatch({ type: 'ADD_TOAST', message: 'Created a new order draft.', toastType: 'success' });
    dispatch({ type: 'SET_SCREEN', screen: 'create' });
  };

  const empty = emptyCopy(activeFilter, Boolean(search.trim()));
  const closedCount = records.filter(record => patientCrmLane(record) === 'declined').length;
  const visibleLanes = showClosed ? [...PATIENT_CRM_LANES, PATIENT_CRM_CLOSED_LANE] : PATIENT_CRM_LANES;

  return (
    <div className="page-body order-crm patient-crm">
      <section className="order-crm-controls">
        <div className="order-crm-search">
          <Search size={15} />
          <input
            type="search"
            value={search}
            onChange={event => setSearch(event.target.value)}
            placeholder="Search name, condition, DOB, email, mobile or case reference"
            aria-label="Search patient CRM"
          />
        </div>
        <button
          type="button"
          className={`crm-lane-toggle${showClosed ? ' is-on' : ''}`}
          aria-pressed={showClosed}
          onClick={() => setShowClosed(value => !value)}
        >
          {showClosed ? 'Hide' : 'Show'} declined <strong>{closedCount}</strong>
        </button>
        <div className="crm-view-switch" role="group" aria-label="Patient directory view">
          <button
            type="button"
            aria-pressed={view === 'board'}
            className={view === 'board' ? 'is-on' : ''}
            onClick={() => setView('board')}
          >
            <LayoutGrid size={14} aria-hidden="true" />
            <span>Board</span>
          </button>
          <button
            type="button"
            aria-pressed={view === 'list'}
            className={view === 'list' ? 'is-on' : ''}
            onClick={() => setView('list')}
          >
            <List size={14} aria-hidden="true" />
            <span>List</span>
          </button>
        </div>
      </section>

      {filtered.length ? (
        view === 'board' ? (
          <div className={`crm-lane-board crm-lane-board--count-${visibleLanes.length}`}>
            {visibleLanes.map(lane => {
              const laneRecords = lanes.get(lane.key) ?? [];
              return (
                <section className={`crm-lane crm-lane--${lane.key}`} key={lane.key} aria-label={`${lane.label}, ${laneRecords.length} record${laneRecords.length === 1 ? '' : 's'}`} data-tour={lane.key === 'enquiries' ? 'patients-enquiries' : lane.key === 'care' ? 'patients-referred' : undefined}>
                  <header className="crm-lane__header" title={lane.detail} data-tour={lane.key === 'care' ? 'patients-active' : undefined}>
                    <span><strong>{lane.label}</strong></span>
                    <b>{laneRecords.length}</b>
                  </header>
                  {laneRecords.length ? (
                    <div className="crm-lane__rows">
                      {laneRecords.map(record => (
                        <CrmListRow key={record.key} record={record} selected={false} onSelect={() => setSelectedKey(record.key)} />
                      ))}
                    </div>
                  ) : (
                    <p className="crm-lane__empty">Nothing here.</p>
                  )}
                </section>
              );
            })}
          </div>
        ) : (
          /* One scrollable list rather than column-split lanes, but still ordered by
             lane priority under quiet headings: a flat A–Z list buries the records
             that need action today, which is the whole job of this screen. */
          <div className="crm-directory-list">
            {visibleLanes.map(lane => {
              const laneRecords = lanes.get(lane.key) ?? [];
              if (!laneRecords.length) return null;
              return (
                <section className={`crm-directory-list__group crm-directory-list__group--${lane.key}`} key={lane.key} aria-label={`${lane.label}, ${laneRecords.length} record${laneRecords.length === 1 ? '' : 's'}`}>
                  <header>
                    <span>
                      <strong>{lane.label}</strong>
                      <small>{lane.detail}</small>
                    </span>
                    <b>{laneRecords.length}</b>
                  </header>
                  <div className="crm-directory-list__rows">
                    {laneRecords.map(record => (
                      <PatientDirectoryRow key={record.key} record={record} onSelect={() => setSelectedKey(record.key)} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )
      ) : (
        <div className="order-crm-empty"><Users size={26} /><strong>{empty.title}</strong><span>{empty.detail}</span></div>
      )}

      {selected ? (
        <RecordDialog label={`${selected.name} record`} onClose={closeRecord}>
          {selected.patient ? (
            <PatientCrmDetail
              record={selected}
              workspaceLive={isLocalPortalPreview || state.workspaceMode === 'live'}
              trainingDraft={Boolean(selected.patient.crmPatient && isTrainingSandboxPatient(selected.patient.crmPatient))}
              onCreateOrder={() => handleCreateOrder(selected.patient!)}
              onConditionsSaved={(patientId, conditions, primaryCondition) => {
                dispatch({ type: 'SET_PATIENT_CONDITIONS', patientId, conditions, primaryCondition });
                dispatch({ type: 'ADD_TOAST', message: 'Patient conditions updated.', toastType: 'success', dedupeKey: 'patient-conditions' });
              }}
              onOpenOrder={order => {
                if (order.payment.status === 'none') {
                  closeRecord();
                  dispatch({ type: 'SET_ACTIVE_ORDER', orderId: order.id });
                  dispatch({ type: 'SET_SCREEN', screen: 'create' });
                  return;
                }
                // Stay on Patients: Orders is keep-alive mounted and opens a portaled dialog.
                dispatch({
                  type: 'SET_NAVIGATION_TARGET',
                  target: { kind: 'order', key: String(order.id) },
                });
              }}
            />
          ) : (
            <EnquiryCrmDetail record={selected} />
          )}
        </RecordDialog>
      ) : null}
    </div>
  );
}

function crmMeta(record: CrmRecord) {
  return patientCrmStatusMeta({
    kind: record.kind,
    journey: record.journey,
    hasCrmRecord: record.hasCrmRecord,
    hasOpenOrder: record.hasOpenOrder,
    needsAction: record.needsAction,
    readyForCollection: record.readyForCollection,
    statusLabel: record.status.label,
  });
}

function crmTourTarget(record: { kind: string; id: string }): string | undefined {
  if (record.kind === 'enquiry') return 'patients-enquiry-record';
  if (record.id.endsWith('-casey')) return 'patients-referred-record';
  if (record.id.endsWith('-morgan')) return 'patients-active-record';
  return undefined;
}

function CrmListRow({ record, selected, onSelect }: { record: CrmRecord; selected: boolean; onSelect: () => void }) {
  const meta = crmMeta(record);
  const Icon = CRM_ICONS[meta.icon];
  const stamp = record.kind === 'enquiry' && record.enquiry ? fmtDate(record.enquiry.submittedAt) : formatPatientDob(record.dob);
  const tourTarget = crmTourTarget(record);
  return (
    <button
      type="button"
      className={`order-crm-row order-crm-row--${meta.tone}${selected ? ' selected' : ''}`}
      aria-pressed={selected}
      aria-label={`${compactPatientName(record.name)}, ${meta.label}`}
      title={meta.description}
      data-tour={tourTarget}
      onClick={onSelect}
    >
      <span className={`order-crm-row__stage order-tone--${meta.tone}`}><Icon size={15} aria-hidden="true" /></span>
      <span className="order-crm-row__identity">
        <strong title={record.name}>{compactPatientName(record.name)}</strong>
        <span className={`order-stage-pill order-tone--${meta.tone}`}>{meta.label}</span>
      </span>
      <span className="order-crm-row__position"><strong>{stamp}</strong><small>{record.kind === 'enquiry' ? 'Received' : 'Date of birth'}</small></span>
    </button>
  );
}

/**
 * List-view row. Same record, same click target and same dialog as the board card —
 * the difference is that the full width has room for the contact fields the operator
 * would otherwise have to open the record to read.
 */
function PatientDirectoryRow({ record, onSelect }: { record: CrmRecord; onSelect: () => void }) {
  const meta = crmMeta(record);
  const Icon = CRM_ICONS[meta.icon];
  const address = patientAddressLines(record.address, record.postcode);
  // Enquiries only ever carry a postcode, so that is all the row claims to know.
  const addressText = record.kind === 'enquiry'
    ? (record.postcode || EMPTY_FIELD)
    : [address.line, address.postcodeIsSeparate ? address.postcode : ''].filter(Boolean).join(', ') || EMPTY_FIELD;
  const addressLabel = record.kind === 'enquiry' ? 'Postcode' : 'Address';
  const reference = record.kind === 'enquiry' && record.enquiry
    ? `Case ${record.caseReference} · received ${fmtDate(record.enquiry.submittedAt)}`
    : `DOB ${formatPatientDob(record.dob)}`;

  return (
    <button
      type="button"
      className={`patient-directory-row patient-directory-row--${meta.tone}`}
      aria-label={`${record.name}, ${meta.label}`}
      title={meta.description}
      onClick={onSelect}
    >
      <span className={`patient-directory-row__stage order-tone--${meta.tone}`}><Icon size={16} aria-hidden="true" /></span>
      <span className="patient-directory-row__identity">
        <strong title={record.name}>{record.name}</strong>
        <small>{reference}</small>
      </span>
      <span className="patient-directory-row__contact">
        <span title={`${addressLabel}: ${addressText}`}>
          <MapPin size={12} aria-hidden="true" />
          <em>{addressLabel}</em>
          {addressText}
        </span>
      </span>
      <span className="patient-directory-row__contact">
        <span title={record.mobile || NOT_RECORDED}>
          <Phone size={12} aria-hidden="true" />
          <em>Phone</em>
          {record.mobile || EMPTY_FIELD}
        </span>
        <span title={record.email || NOT_RECORDED}>
          <Mail size={12} aria-hidden="true" />
          <em>Email</em>
          {record.email || EMPTY_FIELD}
        </span>
      </span>
      <span className={`order-stage-pill order-tone--${meta.tone}`}>{meta.label}</span>
    </button>
  );
}

/**
 * The intake rail, shown only while intake is still in progress.
 *
 * Once a patient is in active care the rail is three ticks that never change
 * again — it takes the top of the record to restate history that the status pill
 * already gives in one word, and pushes the orders and clinical detail staff
 * actually opened the record for below the fold. Declined and suspended
 * patients are off the journey entirely, so they never showed it either.
 */
function PatientJourneyRail({ stage }: { stage: PatientJourneyStage }) {
  if (stage === 'active' || stage === 'declined' || stage === 'suspended') return null;
  const current = patientJourneyStepIndex(stage);
  return (
    <ol className="order-journey-rail order-journey-rail--premium" aria-label="Patient journey">
      {PATIENT_JOURNEY_STEPS.map((step, index) => {
        const stateClass = index < current ? 'is-complete' : index === current ? 'is-active' : 'is-upcoming';
        return (
          <li key={step.key} className={stateClass}>
            <span className="order-journey-rail__marker">{index < current ? <CheckCircle size={14} aria-hidden="true" /> : index + 1}</span>
            <span className="order-journey-rail__copy"><strong>{step.label}</strong><small>{index < current ? 'Complete' : index === current ? 'Current' : 'Next'}</small></span>
          </li>
        );
      })}
    </ol>
  );
}

function PatientCrmDetail({ record, workspaceLive, trainingDraft = false, onCreateOrder, onOpenOrder, onConditionsSaved }: {
  record: CrmRecord;
  workspaceLive: boolean;
  trainingDraft?: boolean;
  onCreateOrder: () => void;
  onOpenOrder: (order: PatientOrder) => void;
  onConditionsSaved: (patientId: string, conditions: string[], primaryCondition: string) => void;
}) {
  const patient = record.patient!;
  const meta = crmMeta(record);
  const Icon = CRM_ICONS[meta.icon];
  const clinical = patientClinicalProfile({ crmPatient: patient.crmPatient, submission: patient.submission });
  const conditions = clinical.conditions;
  const primaryCondition = clinical.primaryCondition;
  const canOrder = (workspaceLive || trainingDraft) && canCreateOrderForPatient(patient.crmPatient);
  const orderGate = newOrderGateMessage(workspaceLive, patient, trainingDraft);
  const foundService = clinical.heardAbout || portalSourceLabel(clinical.referralSource) || null;
  const treatmentCheck = clinical.triedTwoTreatments === true ? 'Yes' : clinical.triedTwoTreatments === false ? 'No' : null;
  const psychosisCheck = clinical.psychiatricExclusion === true ? 'Excluded' : clinical.psychiatricExclusion === false ? 'Passed' : null;
  const marketing = clinical.marketingConsent === null ? null : clinical.marketingConsent ? 'Consent given' : 'No consent';
  const eligibilityLabel = patient.submission ? onboardingStatusLabel(patient.submission.status) : null;
  const address = patientAddressLines(patient.crmPatient?.address, patient.crmPatient?.postcode);
  const [expandedOrderId, setExpandedOrderId] = useState<number | null>(null);
  const [editingConditions, setEditingConditions] = useState(false);
  const [savingConditions, setSavingConditions] = useState(false);
  const [conditionError, setConditionError] = useState<string | null>(null);
  // Only a patient with a server record can have their conditions rewritten;
  // a training-sandbox row has no submission to rewrite.
  const canEditConditions = Boolean(patient.crmPatient?.id) && workspaceLive;

  const saveConditions = async (conditionCodes: string[], primaryConditionCode: string) => {
    const patientId = patient.crmPatient?.id;
    if (!patientId) return;
    setSavingConditions(true);
    setConditionError(null);
    try {
      const result = await updatePatientConditions(patientId, { conditionCodes, primaryConditionCode });
      onConditionsSaved(patientId, result.conditions.map(item => item.conditionCode), result.primaryConditionCode);
      setEditingConditions(false);
    } catch (error) {
      setConditionError(error instanceof Error ? error.message : 'The conditions could not be saved.');
    } finally {
      setSavingConditions(false);
    }
  };

  return (
    <article className="order-crm-record">
      <header className="order-crm-record__header">
        <div className="order-crm-record__hero">
          <div className="order-crm-record__identity">
            <span className={`order-crm-record__stage order-tone--${meta.tone}`} aria-hidden="true"><Icon size={20} /></span>
            <div className="order-crm-record__titles">
              <strong>{patient.name}</strong>
              <span className="order-crm-record__ref">DOB {formatPatientDob(patient.dob)}</span>
            </div>
          </div>
          <span className={`order-stage-pill order-tone--${meta.tone}`}>{meta.label}</span>
        </div>
        <div className="order-crm-record__toolbar">
          <div className="order-crm-record__value">
            <small>Orders</small>
            <strong>{patient.orders.length}</strong>
            <span className="order-crm-record__opened">{journeyLabel(record.journey)}</span>
          </div>
          <div className="order-crm-record__actions" role="group" aria-label="Patient actions">
            <button
              className="btn btn-primary btn-sm"
              type="button"
              disabled={!canOrder}
              aria-describedby={!canOrder ? 'patient-order-gate-tip' : undefined}
              onClick={onCreateOrder}
            >
              {!canOrder ? <Lock size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
              New order
            </button>
          </div>
        </div>
        {!canOrder && orderGate ? <span id="patient-order-gate-tip" className="patient-crm-gate">{orderGate}</span> : null}
      </header>

      <PatientJourneyRail stage={record.journey} />

      <div className="patient-crm-detail__body">
        {record.overdueCollection ? (
          <div className="patient-record-alert" role="alert">
            <AlertTriangle size={18} aria-hidden="true" />
            <span><strong>Collection follow-up overdue</strong><small>A prescription has remained uncollected for at least 10 days. Contact the patient.</small></span>
          </div>
        ) : null}

        {eligibilityLabel && eligibilityLabel !== record.status.label ? (
          <p className="patient-crm-eligibility"><span className={`pill ${onboardingStatusPillClass(patient.submission?.status ?? '')}`}>{eligibilityLabel}</span></p>
        ) : null}

        <div className="patient-chart__panels">
          {/* Every row renders even when empty: a missing detail is itself information. */}
          <section className="patient-chart-card" aria-labelledby="patient-contact-title">
            <header><h3 id="patient-contact-title">Contact</h3></header>
            {/* Date of birth sits under the name in the header, so it is not repeated here. */}
            <dl className="patient-chart-facts">
              <div><dt>Email</dt><dd>{patient.email || NOT_RECORDED}</dd></div>
              <div><dt>Phone</dt><dd>{patient.mobile || NOT_RECORDED}</dd></div>
              <div><dt>Address</dt><dd>{address.line || NOT_RECORDED}</dd></div>
              {address.postcodeIsSeparate ? <div><dt>Postcode</dt><dd>{address.postcode}</dd></div> : null}
            </dl>
          </section>

          <section className="patient-chart-card" aria-labelledby="patient-clinical-title">
            <header>
              <h3 id="patient-clinical-title">Eligibility Form Info</h3>
              {/* The intake form is a snapshot of what the patient could answer on
                  their own. Staff hold the clinic letter, so they can correct it. */}
              {canEditConditions && !editingConditions ? (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setConditionError(null); setEditingConditions(true); }}>
                  <Pencil size={13} aria-hidden="true" /> Edit conditions
                </button>
              ) : null}
            </header>
            {patient.submission && isNegativeEligibilityStatus(patient.submission.status) ? (
              <div className="patient-eligibility-reason"><span>Reason</span><strong>{pharmacyDecisionReason(patient.submission)}</strong></div>
            ) : null}
            {editingConditions ? (
              <div className="patient-chart-conditions patient-chart-conditions--editing">
                <span>Conditions</span>
                <ConditionEditor
                  conditions={conditions}
                  primaryCondition={primaryCondition || conditions[0] || ''}
                  saving={savingConditions}
                  error={conditionError}
                  onCancel={() => { setEditingConditions(false); setConditionError(null); }}
                  onSave={(conditionCodes, primaryConditionCode) => void saveConditions(conditionCodes, primaryConditionCode)}
                />
              </div>
            ) : conditions.length > 0 ? (
              <div className="patient-chart-conditions">
                <span>Conditions</span>
                <ConditionList conditions={conditions} primaryCondition={primaryCondition || conditions[0]} />
              </div>
            ) : null}
            {/* The pills above already carry the primary and secondary conditions.
                These rows only appear when there are no pills to show. */}
            <dl className="patient-chart-facts">
              {conditions.length === 0 && !editingConditions ? <div><dt>Conditions</dt><dd>{EMPTY_FIELD}</dd></div> : null}
              <div><dt>Tried two or more treatments</dt><dd>{treatmentCheck ?? EMPTY_FIELD}</dd></div>
              <div><dt>Psychosis check</dt><dd>{psychosisCheck ?? EMPTY_FIELD}</dd></div>
              <div><dt>How they found the service</dt><dd>{foundService ?? EMPTY_FIELD}</dd></div>
              <div><dt>Marketing contact</dt><dd>{marketing ?? EMPTY_FIELD}</dd></div>
              <div><dt>Reviewed by</dt><dd>{patient.submission?.reviewerDisplay ?? EMPTY_FIELD}</dd></div>
              <div><dt>Decision recorded</dt><dd>{patient.submission?.reviewedAt ? fmtDate(patient.submission.reviewedAt) : EMPTY_FIELD}</dd></div>
            </dl>
            {patient.submission && patient.submission.calls.length > 0 ? (
              <p className="patient-chart-calls">{patient.submission.calls.length} patient call{patient.submission.calls.length === 1 ? '' : 's'} logged</p>
            ) : null}
          </section>
        </div>

        {patient.crmPatient?.interactions && patient.crmPatient.interactions.length > 0 ? (
          <section className="patient-chart-card" aria-labelledby="patient-audit-title">
            <header><h3 id="patient-audit-title">Activity</h3><span>{patient.crmPatient.interactions.length}</span></header>
            <div className="patient-audit-list">
              {patient.crmPatient.interactions.map((log, idx) => (
                <div className="patient-audit-item" key={idx}>
                  <i aria-hidden="true" />
                  <div>
                    <strong>{log.type}</strong>
                    <time dateTime={new Date(log.ts).toISOString()}>
                      {new Date(log.ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} · {new Date(log.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                    </time>
                    <p>{log.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="patient-chart-orders" aria-labelledby="patient-orders-title">
          <header className="patient-chart-orders__header">
            <h3 id="patient-orders-title">Orders</h3>
            <span>{patient.orders.length}</span>
          </header>
          {patient.orders.length === 0 ? (
            <div className="patient-record-empty patient-order-empty">
              <Package size={22} aria-hidden="true" />
              <strong>No orders yet</strong>
              <span>{canCreateOrderForPatient(patient.crmPatient) ? 'Create the first prescription order when the patient is ready.' : 'Orders unlock after HHH marks the patient Referred or Active.'}</span>
            </div>
          ) : (
            [...patient.orders]
              .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
              .map(order => {
                const exceptionReason = orderExceptionReason(order);
                const curaleafLock = orderAwaitingCuraleafCancel(order);
                const refunded = !curaleafLock && order.refund?.status === 'completed';
                const refundPending = !curaleafLock && order.refund?.status === 'pending_confirmation';
                const paymentLabel = curaleafLock
                  ? 'Cancellation pending'
                  : refunded
                  ? 'Refunded'
                  : refundPending
                    ? 'Refund pending'
                    : exceptionReason === 'cancelled' && order.payment.status === 'paid' && !order.redoneByOrderId
                      ? 'Needs refund'
                      : exceptionReason === 'cancelled'
                        ? 'Cancelled'
                        : exceptionReason && order.payment.status === 'paid'
                          ? 'Needs action'
                          : order.payment.status === 'paid'
                            ? 'Paid'
                            : order.payment.status === 'sent'
                              ? 'Awaiting payment'
                              : 'Draft';
                const cardTone = curaleafLock
                  ? 'cancelled'
                  : refunded
                  ? 'resolved'
                  : exceptionReason === 'cancelled'
                    ? 'cancelled'
                    : exceptionReason === 'rejected'
                      ? 'rejected'
                      : exceptionReason === 'expired'
                        ? 'expired'
                        : order.payment.status === 'paid'
                          ? 'paid'
                          : order.payment.status === 'sent'
                            ? 'awaiting'
                            : 'draft';
                const paymentPill = curaleafLock
                  ? 'order-tone--danger'
                  : refunded
                  ? 'order-tone--resolved'
                  : refundPending || order.payment.status === 'sent'
                    ? 'order-tone--warning'
                    : exceptionReason === 'cancelled' || exceptionReason === 'rejected'
                      ? 'order-tone--danger'
                      : exceptionReason === 'expired'
                        ? 'order-tone--warning'
                        : order.payment.status === 'paid'
                          ? 'order-tone--paid'
                          : 'order-tone--neutral';
                const productNames = order.prescriptions.flatMap(rx => rx.items.map(item => item.name)).filter(Boolean);
                const fulfilmentLabel = curaleafLock
                  ? 'Purchase order still live'
                  : exceptionReason === 'cancelled'
                  ? (order.prescriptions.some(rx => rx.purchaseOrderState === 'CANCELLED')
                    ? 'Purchase order cancelled'
                    : order.prescriptions.some(rx => rx.status === 'cancelled')
                      ? 'Prescription cancelled'
                      : 'Cancelled by Curaleaf')
                  : exceptionReason === 'rejected'
                    ? 'Curaleaf rejected'
                    : exceptionReason === 'expired'
                      ? 'Prescription expired'
                      : order.prescriptions.some(rx => rx.placed)
                        ? (RX_STATUS_LABELS[order.prescriptions[0].status as keyof typeof RX_STATUS_LABELS] ?? order.prescriptions[0].status)
                        : 'Not submitted';
                const alertTitle = curaleafLock
                  ? 'Waiting for Curaleaf cancellation'
                  : refunded
                  ? 'Patient refund recorded'
                  : order.redoneByOrderId
                    ? 'Replacement order created'
                    : exceptionReason === 'cancelled'
                      ? (order.prescriptions.some(rx => rx.purchaseOrderState === 'CANCELLED')
                        ? 'Curaleaf cancelled this purchase order'
                        : order.prescriptions.some(rx => rx.status === 'cancelled')
                          ? 'Curaleaf cancelled this prescription'
                          : 'Curaleaf cancelled this order')
                      : exceptionReason === 'rejected'
                        ? 'Paid Curaleaf rejection'
                        : 'Paid prescription expired';
                const alertDetail = curaleafLock
                  ? 'Refund and replacement stay locked until the platform observes Curaleaf’s cancelled prescription or purchase order.'
                  : order.refund
                  ? `${order.refund.method === 'worldpay_portal' ? 'Worldpay' : 'Pharmacy'} · ${money(order.refund.amountPence / 100)}`
                  : order.redoneByOrderId
                    ? `Continued as replacement order ${order.redoneByOrderId}.`
                    : exceptionReason === 'cancelled'
                      ? 'Payment stays paid until you refund or replace this order.'
                      : 'Choose replacement or refund in Orders.';
                const AlertIcon = curaleafLock || exceptionReason === 'cancelled' ? XCircle : refunded ? CheckCircle : AlertTriangle;
                const orderTitle = `${order.redoContext ? 'Replacement' : 'Order'} ${orderReference(order)}`;
                const lines = order.prescriptions.flatMap(prescription => prescription.items);
                const expanded = expandedOrderId === order.id;
                const panelId = `patient-order-lines-${order.id}`;
                return (
                  <div className={`patient-chart-order patient-chart-order--${cardTone}`} key={order.id}>
                    {/* Collapsed the row is a glance: reference, money, state, date. The
                        line items and their margins live behind the disclosure so the
                        list stays scannable when a patient has a dozen orders. */}
                    <button
                      type="button"
                      className="patient-chart-order__summary"
                      aria-expanded={expanded}
                      aria-controls={panelId}
                      onClick={() => setExpandedOrderId(expanded ? null : order.id)}
                    >
                      <span className="patient-chart-order__head">
                        <strong>{orderTitle}</strong>
                        <span className="patient-chart-order__amount">{money(order.payment.amount || orderRevenue(order))}</span>
                        <span className={`order-stage-pill ${paymentPill}`}>{paymentLabel}</span>
                        <ChevronDown className={`patient-chart-order__chevron${expanded ? ' is-open' : ''}`} size={15} aria-hidden="true" />
                      </span>
                      <span className="patient-chart-order__meta">
                        {fmtDate(order.date)} · {fulfilmentLabel}
                        {productNames.length ? ` · ${productNames.length} item${productNames.length === 1 ? '' : 's'}` : ''}
                      </span>
                    </button>

                    {exceptionReason || curaleafLock ? (
                      <span className={`patient-order-resolution${refunded ? ' is-complete' : exceptionReason === 'cancelled' ? ' is-cancelled' : ''}`}>
                        <AlertIcon size={16} aria-hidden="true" />
                        <span><strong>{alertTitle}</strong><small>{alertDetail}</small></span>
                      </span>
                    ) : null}

                    <div className="patient-chart-order__panel" id={panelId} hidden={!expanded}>
                      {lines.length ? (
                        <table className="patient-order-lines">
                          <thead>
                            <tr>
                              <th scope="col">Item</th>
                              <th scope="col">Qty</th>
                              <th scope="col">{PATIENT_PRICE_LABEL}</th>
                              <th scope="col">{WHOLESALE_LABEL}</th>
                              <th scope="col">Margin</th>
                            </tr>
                          </thead>
                          <tbody>
                            {lines.map((item, index) => {
                              const quantity = item.qty || 1;
                              const patientTotal = item.retail * quantity;
                              // Wholesale is quote-derived; when it is missing the margin is
                              // unknown, and an unknown margin is shown as unknown.
                              const costKnown = typeof item.cost === 'number' && item.cost > 0;
                              return (
                                <tr key={`${item.productId}-${index}`}>
                                  <th scope="row"><MedicineLabel name={item.name} static /></th>
                                  <td>{quantity}</td>
                                  <td>{money(patientTotal)}</td>
                                  <td>{costKnown ? money(item.cost! * quantity) : EMPTY_FIELD}</td>
                                  <td className={`patient-order-lines__margin ${costKnown ? marginToneClass(marginPercent(patientTotal - item.cost! * quantity, patientTotal)) : ''}`.trimEnd()}>
                                    {costKnown
                                      ? formatMargin(patientTotal - item.cost! * quantity, patientTotal)
                                      : <span className="patient-order-lines__unknown">Awaiting quote</span>}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      ) : (
                        <p className="patient-chart-order__no-lines">No prescription items recorded on this order.</p>
                      )}
                      <div className="patient-chart-order__panel-actions">
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => onOpenOrder(order)}>
                          {order.payment.status === 'none' ? 'Open Draft' : 'Open order'} <ChevronRight size={14} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
          )}
        </section>
      </div>
    </article>
  );
}

function EnquiryCrmDetail({ record }: { record: CrmRecord }) {
  const enquiry = record.enquiry!;
  const meta = crmMeta(record);
  const Icon = CRM_ICONS[meta.icon];
  const conditions = enquiry.conditions;
  const primaryCondition = enquiry.primaryCondition ?? conditions[0] ?? '';
  const treatmentCheck = enquiry.triedTwoTreatments === true ? 'Yes' : enquiry.triedTwoTreatments === false ? 'No' : null;
  const psychosisCheck = enquiry.psychiatricExclusion === true ? 'Excluded' : enquiry.psychiatricExclusion === false ? 'Passed' : null;
  const heardAbout = enquiry.heardAbout?.trim() || null;
  return (
    <article className="order-crm-record">
      <header className="order-crm-record__header">
        <div className="order-crm-record__hero">
          <div className="order-crm-record__identity">
            <span className={`order-crm-record__stage order-tone--${meta.tone}`} aria-hidden="true"><Icon size={20} /></span>
            <div className="order-crm-record__titles">
              <strong>{record.name}</strong>
              <span className="order-crm-record__ref">DOB {formatPatientDob(enquiry.dob)} · {enquiry.caseReference}{record.sourceLabel ? ` · ${record.sourceLabel}` : ''}</span>
            </div>
          </div>
          <span className={`order-stage-pill order-tone--${meta.tone}`}>{meta.label}</span>
        </div>
        <div className="order-crm-record__toolbar">
          <div className="order-crm-record__value">
            <small>Received</small>
            <strong>{fmtDate(enquiry.submittedAt)}</strong>
          </div>
          <div className="order-crm-record__actions" role="group" aria-label="Enquiry actions">
            <button className="btn btn-primary btn-sm" type="button" disabled>
              <Lock size={14} aria-hidden="true" /> Orders locked
            </button>
          </div>
        </div>
        <span className="patient-crm-gate">HHH may still move this enquiry. Referral marks them referred; orders stay locked until the workspace is live.</span>
      </header>
      <PatientJourneyRail stage="enquiry" />
      <div className="patient-crm-detail__body">
        <div className="patient-chart__panels">
          <section className="patient-chart-card" aria-labelledby="enquiry-contact-title">
            <header><h3 id="enquiry-contact-title">Contact</h3></header>
            {/* Date of birth sits under the name in the header, so it is not repeated here. */}
            <dl className="patient-chart-facts">
              <div><dt>Email</dt><dd>{enquiry.email || NOT_RECORDED}</dd></div>
              <div><dt>Phone</dt><dd>{enquiry.mobile || NOT_RECORDED}</dd></div>
              <div><dt>Postcode</dt><dd>{enquiry.postcode || NOT_RECORDED}</dd></div>
            </dl>
          </section>
          <section className="patient-chart-card" aria-labelledby="enquiry-clinical-title">
            <header><h3 id="enquiry-clinical-title">Eligibility Form Info</h3></header>
            {conditions.length > 0 ? (
              <div className="patient-chart-conditions">
                <span>Conditions</span>
                <ConditionList conditions={conditions} primaryCondition={primaryCondition || conditions[0]} />
              </div>
            ) : null}
            {/* The pills above already carry the conditions; this row is the empty fallback. */}
            <dl className="patient-chart-facts">
              {conditions.length === 0 ? <div><dt>Conditions</dt><dd>{EMPTY_FIELD}</dd></div> : null}
              <div><dt>Tried two treatments</dt><dd>{treatmentCheck ?? EMPTY_FIELD}</dd></div>
              <div><dt>Psychosis exclusion</dt><dd>{psychosisCheck ?? EMPTY_FIELD}</dd></div>
              <div><dt>Heard about</dt><dd>{heardAbout ?? EMPTY_FIELD}</dd></div>
              <div><dt>Referral source</dt><dd>{record.sourceLabel ?? EMPTY_FIELD}</dd></div>
            </dl>
          </section>
        </div>
      </div>
    </article>
  );
}
