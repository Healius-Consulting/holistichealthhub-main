import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { prescriptionDateIsCurrent } from '@hhh/domain/prescription-date';
import { AlertTriangle, ArrowRight, Banknote, CheckCircle, ChevronDown, ChevronUp, CreditCard, FileScan, FileText, Minus, Pencil, Plus, RefreshCw, Save, Search, Send, ShieldCheck, Trash2, Upload, X } from 'lucide-react';
import ProviderStatusNotice from '../components/ProviderStatusNotice';
import ManualPrescriptionEditor from '../components/ManualPrescriptionEditor';
import MedicineLabel from '../components/MedicineLabel';
import {
  useApp,
  money,
  lineRevenue,
  lineCost,
  lineMargin,
  orderRevenue,
  orderCost,
  marginPct,
  getUnresolvedReason,
  orderReference,
  type CatalogueItem,
  type LineItem,
  type PatientOrder,
  type UnresolvedOrderReason,
} from '../context/AppContext';
import { TRAINING_PRESCRIBER, TRAINING_PRODUCT } from '../training/workspace';
import { isLocalPortalPreview } from '../dev/localPortalPreview';
import { createOrderDraft, createPortalOrder, createWorldpaySession, deleteOrderDraft, deletePrescriptionFile, getCuraleafQuote, getCuraleafTrainingQuote, getDevCuraleafQuote, isApiConfigured, scanCuraleafClinicPrescription, updateOrderDraft, uploadPrescriptionFile } from '../shared/api';
import { formatPatientDob } from '../utils/patientDob';
import { canCreateOrderForPatient } from '../utils/patientOrderEligibility';
import { MAX_PRESCRIPTION_FILE_BYTES, PRESCRIPTION_FILE_ACCEPT, resolvePrescriptionContentType } from '../utils/prescriptionFile';

type GuidedRxPhase = 'route' | 'upload' | 'details';

const rxPhaseRank = (phase: GuidedRxPhase) => (phase === 'route' ? 1 : phase === 'upload' ? 2 : 3);
const maxRxPhase = (current: GuidedRxPhase, next: GuidedRxPhase) => (rxPhaseRank(next) > rxPhaseRank(current) ? next : current);

function basketItemIssue(input: {
  productId: string;
  cost: number | null;
  catalogue?: CatalogueItem;
  unavailableProductIds: string[];
  quoteError: boolean;
}): { tone: 'blocked' | 'warning'; label: string } | null {
  const { catalogue, unavailableProductIds, productId, cost, quoteError } = input;
  if (unavailableProductIds.includes(productId) || catalogue?.availability === 'out') {
    return { tone: 'blocked', label: 'Out of stock' };
  }
  if (catalogue?.supplierState && catalogue.supplierState !== 'ACTIVE') {
    return { tone: 'blocked', label: 'Unavailable' };
  }
  if (cost === null && quoteError) {
    return { tone: 'blocked', label: 'Quote needs attention' };
  }
  if (catalogue?.availability === 'low') {
    return { tone: 'warning', label: 'Low stock' };
  }
  if (catalogue?.availability === 'unknown' && cost !== null) {
    return { tone: 'warning', label: 'Stock check required' };
  }
  return null;
}

export default function CreateOrder() {
  const { state, dispatch } = useApp();
  const organisationPatients = state.crm.filter(candidate => candidate.organisationId === state.currentOrganisationId);
  const orderablePatients = organisationPatients.filter(canCreateOrderForPatient);
  const organisation = state.organisations.find(org => org.id === state.currentOrganisationId) ?? state.organisations[0];
  const canUseWorldpay = Boolean(organisation?.worldpay.enabled && organisation?.worldpay.status === 'connected');
  const draftOrders = state.orders.filter(order => order.organisationId === state.currentOrganisationId && order.payment.status === 'none');
  const activeOrder = state.orders.find(order => order.organisationId === state.currentOrganisationId && order.id === state.activeOrderId && order.payment.status === 'none');
  const selectedPaymentRoute = activeOrder?.paymentRoute ?? (canUseWorldpay ? 'worldpay' : 'manual');
  const redoSourceOrder = activeOrder?.redoContext
    ? state.orders.find(order => order.organisationId === state.currentOrganisationId && order.id === activeOrder.redoContext!.originalOrderId)
    : null;
  const patient = activeOrder?.patientId ? organisationPatients.find(candidate => candidate.id === activeOrder.patientId) ?? null : null;
  const [selectedRxId, setSelectedRxId] = useState<number | null>(null);
  const [changingPatient, setChangingPatient] = useState(false);
  const [patientQuery, setPatientQuery] = useState('');
  const [patientSearchOpen, setPatientSearchOpen] = useState(true);
  const [patientActiveIndex, setPatientActiveIndex] = useState(0);
  const [confirmingDraftDeleteId, setConfirmingDraftDeleteId] = useState<number | null>(null);
  const [confirmingRxDeleteId, setConfirmingRxDeleteId] = useState<number | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteError, setQuoteError] = useState<{ title: string; detail: string } | null>(null);
  const [quotedSignature, setQuotedSignature] = useState<string | null>(null);
  const [quoteSummary, setQuoteSummary] = useState<{ shippingPrice: number; taxRate: number } | null>(null);
  const [quotedUnavailableProductIds, setQuotedUnavailableProductIds] = useState<string[]>([]);
  const quoteRequestVersion = useRef(0);
  const draftCreationInFlight = useRef(new Map<number, Promise<string>>());
  const deletedDraftOrderIds = useRef(new Set<number>());
  const [uploadingRxId, setUploadingRxId] = useState<number | null>(null);
  const [confirmingFileRemoveRxId, setConfirmingFileRemoveRxId] = useState<number | null>(null);
  const [fileRemovalBusyRxId, setFileRemovalBusyRxId] = useState<number | null>(null);
  const [readingRxId, setReadingRxId] = useState<number | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [editingClinicFormularyRxId, setEditingClinicFormularyRxId] = useState<number | null>(null);
  const [selectedUnresolvedOrderId, setSelectedUnresolvedOrderId] = useState<number | null>(null);
  const guidedLayout = true;
  const [guidedStep, setGuidedStep] = useState<1 | 2 | 3 | 4>(1);
  const [guidedReveal, setGuidedReveal] = useState<1 | 2 | 3 | 4>(1);
  const [guidedRouteChosen, setGuidedRouteChosen] = useState(false);
  const [guidedRxPhase, setGuidedRxPhase] = useState<GuidedRxPhase>('route');
  const [guidedRxReveal, setGuidedRxReveal] = useState<GuidedRxPhase>('route');
  const [confirmingRouteSwitch, setConfirmingRouteSwitch] = useState<'clinic' | 'manual' | null>(null);
  const [basketOpen, setBasketOpen] = useState(false);
  const [showReturnToTop, setShowReturnToTop] = useState(false);
  const [basketHost, setBasketHost] = useState<HTMLElement | null>(null);
  const [guidedLockNotice, setGuidedLockNotice] = useState<string | null>(null);
  const guidedStageHeadingRef = useRef<HTMLHeadingElement>(null);
  const skipGuidedFocus = useRef(true);
  const previousPatientReady = useRef(false);
  const durableDraftEnabled = isApiConfigured && !isLocalPortalPreview && state.workspaceMode === 'live';
  const durableDraftPayload = useMemo(() => activeOrder ? {
    localOrderId: activeOrder.id,
    patientId: activeOrder.patientId,
    prescriptions: activeOrder.prescriptions,
    dispensingFeePence: Math.round(activeOrder.dispensingFee * 100),
    paymentRoute: selectedPaymentRoute,
    redoContext: activeOrder.redoContext ?? null,
  } : null, [activeOrder, selectedPaymentRoute]);
  const durableDraftSignature = durableDraftPayload ? JSON.stringify(durableDraftPayload) : '';

  const ensureDurableDraft = useCallback((order: PatientOrder, payload: Record<string, unknown>) => {
    if (order.draftId) return Promise.resolve(order.draftId);
    const existing = draftCreationInFlight.current.get(order.id);
    if (existing) return existing;
    const creation = createOrderDraft({ organisationId: state.currentOrganisationId, patientId: order.patientId, payload })
      .then(async record => {
        if (deletedDraftOrderIds.current.has(order.id)) {
          await deleteOrderDraft(record.id, state.currentOrganisationId).catch(() => undefined);
          throw new Error('This draft was removed before it finished saving.');
        }
        dispatch({ type: 'SET_ORDER_DRAFT_ID', orderId: order.id, draftId: record.id });
        return record.id;
      })
      .finally(() => draftCreationInFlight.current.delete(order.id));
    draftCreationInFlight.current.set(order.id, creation);
    return creation;
  }, [dispatch, state.currentOrganisationId]);

  useEffect(() => {
    if (!isLocalPortalPreview || !state.currentOrganisationId) return;
    if (state.orders.some(order => order.organisationId === state.currentOrganisationId && order.payment.status === 'none')) return;
    dispatch({ type: 'NEW_ORDER' });
  }, [dispatch, state.currentOrganisationId, state.orders]);

  useEffect(() => {
    if (activeOrder?.payment.status === 'none' && activeOrder.paymentRoute === 'worldpay' && !canUseWorldpay) {
      dispatch({ type: 'SET_ORDER_PAYMENT_ROUTE', orderId: activeOrder.id, paymentRoute: 'manual' });
    }
  }, [activeOrder?.id, activeOrder?.payment.status, activeOrder?.paymentRoute, canUseWorldpay, dispatch]);

  useEffect(() => {
    if (!durableDraftEnabled || !activeOrder || activeOrder.draftId || checkoutBusy) return;
    void ensureDurableDraft(activeOrder, durableDraftPayload ?? {})
      .catch(error => {
        if (!checkoutBusy) console.warn('Draft autosave:', error);
      });
  }, [activeOrder, checkoutBusy, durableDraftEnabled, durableDraftPayload, ensureDurableDraft]);

  useEffect(() => {
    if (!durableDraftEnabled || !activeOrder?.draftId || !durableDraftPayload || uploadingRxId !== null || fileRemovalBusyRxId !== null || checkoutBusy) return;
    const timer = window.setTimeout(() => {
      void updateOrderDraft(activeOrder.draftId!, { organisationId: state.currentOrganisationId, patientId: activeOrder.patientId, payload: durableDraftPayload })
        .catch(error => {
          if (!checkoutBusy) console.warn('Draft autosave update:', error);
        });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [activeOrder?.draftId, activeOrder?.patientId, checkoutBusy, durableDraftEnabled, durableDraftPayload, durableDraftSignature, fileRemovalBusyRxId, state.currentOrganisationId, uploadingRxId]);

  useEffect(() => {
    if (!activeOrder?.prescriptions.length) return setSelectedRxId(null);
    if (!activeOrder.prescriptions.some(rx => rx.id === selectedRxId)) setSelectedRxId(activeOrder.prescriptions[0].id);
  }, [activeOrder, selectedRxId]);

  useEffect(() => {
    quoteRequestVersion.current += 1;
    setChangingPatient(false);
    setPatientQuery('');
    setPatientSearchOpen(!activeOrder?.patientId);
    setPatientActiveIndex(0);
    setConfirmingDraftDeleteId(null);
    setConfirmingRxDeleteId(null);
    setConfirmingFileRemoveRxId(null);
    setQuoteError(null);
    setQuotedSignature(null);
    setQuoteSummary(null);
    setQuotedUnavailableProductIds([]);
    setQuoteBusy(false);
    setEditingClinicFormularyRxId(null);
    setSelectedUnresolvedOrderId(activeOrder?.redoContext?.originalOrderId ?? null);
  }, [activeOrder?.id, activeOrder?.redoContext?.originalOrderId]);

  const matchingPatients = useMemo(() => {
    const query = patientQuery.trim().toLowerCase();
    return orderablePatients.filter(candidate => !query || [candidate.name, candidate.email, candidate.mobile, candidate.dob ?? '', formatPatientDob(candidate.dob)].some(value => value.toLowerCase().includes(query))).slice(0, 7);
  }, [orderablePatients, patientQuery]);

  const unresolvedOrdersForPatient = useMemo(() => {
    if (!patient) return [] as Array<{ order: PatientOrder; reason: UnresolvedOrderReason; itemCount: number }>;
    const now = new Date();
    return state.orders
      .filter(order => order.organisationId === state.currentOrganisationId && order.patientId === patient.id)
      .map(order => {
        const reason = getUnresolvedReason(order, now);
        if (!reason) return null;
        return {
          order,
          reason,
          itemCount: order.prescriptions.flatMap(rx => rx.items).length,
        };
      })
      .filter((entry): entry is { order: PatientOrder; reason: UnresolvedOrderReason; itemCount: number } => Boolean(entry))
      .sort((a, b) => new Date(b.order.date).getTime() - new Date(a.order.date).getTime());
  }, [patient, state.currentOrganisationId, state.orders]);

  useEffect(() => {
    if (!unresolvedOrdersForPatient.length) {
      setSelectedUnresolvedOrderId(null);
      return;
    }
    if (activeOrder?.redoContext?.originalOrderId && unresolvedOrdersForPatient.some(entry => entry.order.id === activeOrder.redoContext!.originalOrderId)) {
      setSelectedUnresolvedOrderId(activeOrder.redoContext.originalOrderId);
      return;
    }
    if (!unresolvedOrdersForPatient.some(entry => entry.order.id === selectedUnresolvedOrderId)) {
      setSelectedUnresolvedOrderId(unresolvedOrdersForPatient[0].order.id);
    }
  }, [activeOrder?.redoContext?.originalOrderId, selectedUnresolvedOrderId, unresolvedOrdersForPatient]);

  const selectedRx = activeOrder?.prescriptions.find(rx => rx.id === selectedRxId) ?? null;
  const selectedRxIndex = activeOrder && selectedRx ? activeOrder.prescriptions.findIndex(rx => rx.id === selectedRx.id) : -1;
  const requiresLiveCuraleafEvidence = state.workspaceMode === 'live' && !isLocalPortalPreview;
  const hasPrescriptionRecords = Boolean(activeOrder?.prescriptions.length);
  const readiness = activeOrder ? [
    { label: 'Approved referral or active patient linked', complete: canCreateOrderForPatient(patient) },
    { label: 'Prescription evidence attached', complete: hasPrescriptionRecords && activeOrder.prescriptions.every(rx => Boolean(rx.copyFileName) && (!requiresLiveCuraleafEvidence || Boolean(rx.fileId))) },
    { label: 'Serial number / Clinic source verified', complete: hasPrescriptionRecords && activeOrder.prescriptions.every(rx => rx.entryMode === 'manual' ? Boolean(rx.serialNumber?.trim()) : Boolean(rx.clinicScanId && rx.curaleafPrescriptionId)) },
    { label: 'Prescription inside its 28-day window', complete: hasPrescriptionRecords && activeOrder.prescriptions.every(rx => prescriptionDateIsCurrent(rx.issueDate, rx.expiryDate)) },
    { label: 'Prescriber details complete', complete: hasPrescriptionRecords && activeOrder.prescriptions.every(rx => Boolean(rx.issueDate && rx.prescriber.trim() && (rx.entryMode === 'manual' ? rx.prescriberPin?.trim() : rx.prescriberId))) },
    { label: 'Priced medicines and quantities complete', complete: hasPrescriptionRecords && activeOrder.prescriptions.every(rx => rx.items.length > 0 && rx.items.every(item => Boolean(item.productId && item.formulaId) && Number.isInteger(item.qty) && item.qty > 0 && Number.isInteger(item.unitsNeededCount) && item.unitsNeededCount! > 0 && Number.isFinite(item.retail) && item.retail > 0)) },
  ] : [];
  const prescriptionReady = readiness.every(item => item.complete);
  const wholesaleKnown = Boolean(activeOrder?.prescriptions.every(rx => rx.items.every(item => item.cost !== null)));
  const orderMargin = activeOrder && wholesaleKnown
    ? marginPct(orderCost(activeOrder), orderRevenue(activeOrder))
    : null;
  const currentQuoteItems = activeOrder?.prescriptions.flatMap(rx => rx.items.map(item => ({ packId: item.productId, quantity: item.qty }))) ?? [];
  const currentQuoteSignature = JSON.stringify(currentQuoteItems.slice().sort((a, b) => a.packId.localeCompare(b.packId)));

  useEffect(() => {
    quoteRequestVersion.current += 1;
    setQuoteError(null);
    setQuotedSignature(null);
    setQuoteSummary(null);
    setQuotedUnavailableProductIds([]);
  }, [currentQuoteSignature]);

  const quoteCurrent = wholesaleKnown && quotedSignature === currentQuoteSignature;
  const currentUnavailableProductIds = quotedSignature === currentQuoteSignature ? quotedUnavailableProductIds : [];
  const quoteAvailable = quoteCurrent && currentUnavailableProductIds.length === 0;
  const dispensingFeeValid = !activeOrder
    || activeOrder.redoContext?.priceResolution === 'continue_as_fee'
    || activeOrder.dispensingFee === 0
    || activeOrder.dispensingFee >= 5 && activeOrder.dispensingFee <= 15;
  const quoteGateComplete = !requiresLiveCuraleafEvidence || quoteAvailable;
  const paidRedo = Boolean(activeOrder?.redoContext?.isPaidRedo);
  const paymentRouteReady = paidRedo || selectedPaymentRoute === 'manual' || canUseWorldpay;
  const paidRedoAmountDifference = activeOrder?.redoContext?.isPaidRedo && redoSourceOrder
    ? Math.round((orderRevenue(activeOrder) - redoSourceOrder.payment.amount) * 100) / 100
    : 0;
  const paidRedoAmountMatches = !activeOrder?.redoContext?.isPaidRedo || Math.abs(paidRedoAmountDifference) < 0.005;
  const redoPriceResolutionReady = paidRedoAmountMatches
    || activeOrder?.redoContext?.priceResolution === 'absorb' && paidRedoAmountDifference > 0;
  const readyForPayment = prescriptionReady && quoteGateComplete && paymentRouteReady && redoPriceResolutionReady && dispensingFeeValid;
  const paymentGate = activeOrder ? [
    ...readiness,
    { label: requiresLiveCuraleafEvidence ? 'Live Curaleaf price and stock quote verified' : 'Curaleaf quote optional in training', complete: quoteGateComplete },
    { label: activeOrder.redoContext?.priceResolution === 'continue_as_fee' ? 'Price drop taken into the dispensing charge' : 'Dispensing charge is £0 or £5–£15', complete: dispensingFeeValid },
    { label: paidRedo ? 'Original verified payment route retained' : selectedPaymentRoute === 'worldpay' ? 'Worldpay merchant connection verified' : 'Pharmacy-managed payment route selected', complete: paymentRouteReady },
    ...(activeOrder.redoContext?.isPaidRedo ? [{ label: 'Replacement price decision recorded', complete: redoPriceResolutionReady }] : []),
  ] : [];
  const outstandingPaymentGates = paymentGate.filter(item => !item.complete);
  const workflowSteps = activeOrder ? [
    { label: 'Patient', detail: patient ? 'Approved and linked' : 'Select approved patient', complete: Boolean(patient), active: !patient },
    { label: 'Prescription', detail: prescriptionReady ? `${activeOrder.prescriptions.length} record${activeOrder.prescriptions.length === 1 ? '' : 's'} verified` : `${readiness.filter(item => item.complete).length}/${readiness.length} checks passed`, complete: prescriptionReady, active: Boolean(patient) && !prescriptionReady },
    { label: 'Curaleaf quote', detail: requiresLiveCuraleafEvidence ? quoteAvailable ? 'Price and stock verified' : 'Required before payment' : quoteAvailable ? 'Training quote checked' : 'Optional in training', complete: quoteGateComplete, active: prescriptionReady && !quoteGateComplete },
    { label: 'Payment', detail: readyForPayment ? paidRedo ? 'Carry-over ready' : `${selectedPaymentRoute === 'worldpay' ? 'Worldpay' : 'Pharmacy route'} ready` : paidRedo && !redoPriceResolutionReady ? 'Price decision needed' : `${outstandingPaymentGates.length} blocker${outstandingPaymentGates.length === 1 ? '' : 's'}`, complete: false, active: readyForPayment },
  ] : [];
  const patientLinked = Boolean(patient);
  const patientReady = patientLinked && canCreateOrderForPatient(patient);
  const prescriptionUploaded = Boolean(selectedRx && (selectedRx.copyFileName || selectedRx.clinicScanId));
  const readyForProducts = selectedRx?.entryMode === 'clinic'
    ? Boolean(selectedRx.clinicScanId)
    : Boolean(selectedRx?.copyFileName && selectedRx.prescriber.trim() && selectedRx.serialNumber?.trim());
  const draftBasketItems = activeOrder
    ? activeOrder.prescriptions.flatMap(rx => rx.items.map(item => ({ ...item, rxId: rx.id })))
    : [];
  const draftBasketCount = draftBasketItems.length;
  const draftBasketTotal = activeOrder ? orderRevenue(activeOrder) : 0;
  const draftBasketWholesalePlusDelivery = activeOrder && wholesaleKnown && quoteCurrent && quoteSummary
    ? orderCost(activeOrder) + quoteSummary.shippingPrice
    : null;
  const draftBasketIssues = draftBasketItems.map(item => basketItemIssue({
    productId: item.productId,
    cost: item.cost,
    catalogue: state.catalogue.find(product => product.id === item.productId),
    unavailableProductIds: currentUnavailableProductIds,
    quoteError: Boolean(quoteError),
  }));
  const draftBasketBlockedCount = draftBasketIssues.filter(issue => issue?.tone === 'blocked').length;
  const draftBasketWarningCount = draftBasketIssues.filter(issue => issue?.tone === 'warning').length;
  const canEditBasketItems = Boolean(selectedRx && (selectedRx.entryMode === 'manual' || editingClinicFormularyRxId === selectedRx.id));
  const guidedRxPhaseForProgress = !guidedRouteChosen ? 'route' as const : !prescriptionUploaded ? 'upload' as const : 'details' as const;
  const returnToTop = () => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById('pharmacy-main-content')?.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  };
  const applyGuidedRoute = (mode: 'clinic' | 'manual') => {
    if (!activeOrder || !selectedRx) return;
    setEditingClinicFormularyRxId(null);
    dispatch({ type: 'SET_RX_ENTRY_MODE', orderId: activeOrder.id, rxId: selectedRx.id, mode });
    setGuidedRouteChosen(true);
    setGuidedRxPhase('upload');
    setGuidedRxReveal('upload');
    setConfirmingRouteSwitch(null);
    setGuidedLockNotice(null);
  };
  const chooseGuidedRoute = (mode: 'clinic' | 'manual') => {
    if (!activeOrder || !selectedRx) return;
    setEditingClinicFormularyRxId(null);
    if (selectedRx.entryMode === mode) {
      setGuidedRouteChosen(true);
      setGuidedRxPhase('upload');
      setGuidedRxReveal(current => maxRxPhase(current, 'upload'));
      setConfirmingRouteSwitch(null);
      setGuidedLockNotice(null);
      return;
    }
    const hasWork = Boolean(
      selectedRx.clinicScanId
      || selectedRx.copyFileName
      || selectedRx.serialNumber?.trim()
      || selectedRx.prescriber.trim()
      || selectedRx.items.length,
    );
    if (hasWork) {
      setConfirmingRouteSwitch(mode);
      return;
    }
    applyGuidedRoute(mode);
  };
  const guidedStageTitle = guidedStep === 1
    ? 'Link an approved patient'
    : guidedStep === 2
      ? guidedRxPhaseForProgress === 'route'
        ? 'Scan the Curaleaf QR or enter it manually'
        : guidedRxPhaseForProgress === 'upload'
          ? 'Upload the prescription'
          : selectedRx?.entryMode === 'manual'
            ? 'Enter the signed prescription'
            : 'Confirm the Curaleaf scan'
      : guidedStep === 3
        ? selectedRx?.entryMode === 'manual'
          ? 'Select the prescribed medicines'
          : 'Review the Curaleaf pack match'
        : paidRedo
          ? 'Review and carry over payment'
          : 'Review and request payment';
  const guidedNextHint = !patientReady
    ? patientLinked && !patientReady
      ? 'This patient cannot start an order until they are approved.'
      : 'Link an approved patient to continue.'
    : !guidedRouteChosen
      ? 'Choose Scan Curaleaf QR or Enter details manually.'
      : !prescriptionUploaded
        ? 'Upload the prescription copy to continue.'
        : !readyForProducts
          ? selectedRx?.entryMode === 'manual'
            ? 'Enter the signed prescription details to review medicines.'
            : 'Wait until Curaleaf verifies the barcode, or try the scan again.'
          : draftBasketCount === 0
            ? 'Add a prescribed medicine to review payment.'
            : '';

  useEffect(() => {
    if (!guidedLayout) return;
    setGuidedStep(1);
    setGuidedReveal(1);
    setGuidedRxPhase('route');
    setGuidedRxReveal('route');
    setConfirmingRouteSwitch(null);
    setBasketOpen(false);
    setGuidedLockNotice(null);
    skipGuidedFocus.current = true;
    previousPatientReady.current = patientReady;
  }, [activeOrder?.id, guidedLayout]); // patientReady is snapshotted only when the draft changes

  useEffect(() => {
    if (!guidedLayout) return;
    const rx = activeOrder?.prescriptions.find(item => item.id === selectedRxId);
    setGuidedRouteChosen(Boolean(rx && (
      rx.clinicScanId || rx.copyFileName || rx.serialNumber?.trim() || (rx.entryMode === 'manual' && rx.prescriber.trim())
    )));
  }, [activeOrder?.id, guidedLayout, selectedRxId]);

  useEffect(() => {
    if (!guidedLayout || !guidedRouteChosen) return;
    setGuidedRxPhase(current => (current === 'route' ? 'upload' : current));
    setGuidedRxReveal(current => maxRxPhase(current, 'upload'));
  }, [guidedLayout, guidedRouteChosen]);

  useEffect(() => {
    if (!guidedLayout || !prescriptionUploaded) return;
    setGuidedRxPhase(current => (current === 'upload' ? 'details' : current));
    setGuidedRxReveal(current => maxRxPhase(current, 'details'));
  }, [guidedLayout, prescriptionUploaded]);

  useEffect(() => {
    if (!guidedLayout) return;
    if (patientReady && !previousPatientReady.current && !changingPatient) {
      skipGuidedFocus.current = true;
      setGuidedStep(current => (current === 1 ? 2 : current));
      setGuidedReveal(current => (current < 2 ? 2 : current));
      setGuidedLockNotice(null);
    }
    previousPatientReady.current = patientReady;
  }, [changingPatient, guidedLayout, patientReady]);

  useEffect(() => {
    if (!guidedLayout || !patientReady || !readyForProducts) return;
    skipGuidedFocus.current = true;
    setGuidedReveal(current => (current < 3 ? 3 : current));
    setGuidedStep(current => (current === 2 ? 3 : current));
  }, [guidedLayout, patientReady, readyForProducts]);

  useEffect(() => {
    if (!guidedLayout || !patientReady || !readyForProducts || draftBasketCount < 1) return;
    skipGuidedFocus.current = true;
    setGuidedReveal(current => (current < 4 ? 4 : current));
    setGuidedStep(current => (current === 3 ? 4 : current));
  }, [draftBasketCount, guidedLayout, patientReady, readyForProducts]);

  useEffect(() => {
    if (!basketOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setBasketOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [basketOpen]);

  useEffect(() => {
    if (!guidedLayout) return;
    const scroller = document.getElementById('pharmacy-main-content');
    if (!scroller) return;
    const update = () => setShowReturnToTop(scroller.scrollTop > 120);
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    return () => scroller.removeEventListener('scroll', update);
  }, [guidedLayout]);

  useEffect(() => {
    setBasketHost(document.querySelector('.app-main'));
  }, []);

  useEffect(() => {
    if (!guidedLayout) return;
    if (skipGuidedFocus.current) {
      skipGuidedFocus.current = false;
      return;
    }
    guidedStageHeadingRef.current?.focus();
  }, [guidedLayout, guidedStep, guidedRxPhase]);

  const activeOrderRef = activeOrder ? orderReference(activeOrder) : '';
  const confirmingDraft = confirmingDraftDeleteId === null ? null : draftOrders.find(order => order.id === confirmingDraftDeleteId) ?? null;
  const confirmingDraftPatient = confirmingDraft?.patientId ? organisationPatients.find(candidate => candidate.id === confirmingDraft.patientId) : null;
  const confirmingDraftLabel = confirmingDraftPatient?.name ?? (confirmingDraft ? `Unlinked draft #${confirmingDraft.id}` : 'this draft');

  const initials = (name: string) => name.split(' ').map(word => word[0]).join('').toUpperCase().slice(0, 2);
  const gmcNumber = (value?: string) => {
    const number = value?.trim() ? Number(value) : null;
    return number && Number.isInteger(number) && number > 0 ? number : null;
  };
  const applyClinicScan = (rxId: number, scan: Awaited<ReturnType<typeof scanCuraleafClinicPrescription>>) => {
    if (!activeOrder || scan.status !== 'ready' || !scan.prescription || !scan.prescriber || !scan.matchedItems?.length) return false;
    const items: LineItem[] = scan.matchedItems.map(item => ({
      productId: item.packId,
      formulaId: item.formulaId,
      name: item.formulaName,
      qty: item.quantity,
      unitsNeededCount: item.unitsNeededCount,
      cost: null,
      retail: Number(item.patientPackPrice),
    }));
    dispatch({
      type: 'APPLY_CURALEAF_SCAN',
      orderId: activeOrder.id,
      rxId,
      scan: {
        scanId: scan.scanId,
        prescriptionId: scan.prescription.id,
        state: scan.prescription.state,
        serialNumber: scan.prescription.serialNumber,
        issueDate: scan.prescription.issueDate,
        expiryDate: scan.prescription.expiryDate,
        prescriberId: scan.prescriber.id,
        prescriberName: scan.prescriber.name,
        prescriberGmcNumber: scan.prescriber.gmcNumber?.toString() ?? '',
        prescriberGphcNumber: scan.prescriber.gphcNumber ?? '',
        items,
      },
    });
    setQuotedSignature(null);
    setQuoteSummary(null);
    setQuotedUnavailableProductIds([]);
    setQuoteError(null);
    return true;
  };

  const readClinicBarcode = async (rxId: number, fileId: string) => {
    if (!activeOrder || isLocalPortalPreview || state.workspaceMode !== 'live') return;
    setReadingRxId(rxId);
    setScanError(null);
    try {
      const scan = await scanCuraleafClinicPrescription(state.currentOrganisationId, fileId);
      if (scan.status === 'processing') {
        dispatch({ type: 'ADD_TOAST', message: 'Curaleaf is still reading the barcode. Wait a moment, then check again.', toastType: 'info' });
        return;
      }
      if (!applyClinicScan(rxId, scan)) throw new Error('Curaleaf did not return the complete prescription and pack details.');
      dispatch({ type: 'ADD_TOAST', message: 'Curaleaf verified the barcode and supplied the prescription details.', toastType: 'success' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Curaleaf could not read this prescription barcode.';
      setScanError(message);
      dispatch({ type: 'ADD_TOAST', message, toastType: 'error' });
    } finally {
      setReadingRxId(null);
    }
  };

  const applySyntheticClinicScan = (rxId: number, fileName = `synthetic-curaleaf-clinic-${rxId}.pdf`) => {
    if (!activeOrder) return;
    const product = state.catalogue.find(item => item.supplierState === 'ACTIVE' && item.formulaId && item.packSize && item.retail > 0)
      ?? state.catalogue.find(item => item.formulaId && item.packSize)
      ?? TRAINING_PRODUCT;
    const issued = new Date();
    const expiry = new Date(issued);
    expiry.setDate(expiry.getDate() + 28);
    const serial = `TRAINING-${issued.toISOString().slice(0, 10).replaceAll('-', '')}-${activeOrder.id}-${rxId}`;
    dispatch({ type: 'SET_RX_FILE', orderId: activeOrder.id, rxId, fileName, fileId: null });
    dispatch({
      type: 'APPLY_CURALEAF_SCAN',
      orderId: activeOrder.id,
      rxId,
      scan: {
        scanId: `training-scan-${activeOrder.id}-${rxId}`,
        prescriptionId: `training-prescription-${activeOrder.id}-${rxId}`,
        state: 'ACTIVE',
        serialNumber: serial,
        issueDate: issued.toISOString().slice(0, 10),
        expiryDate: expiry.toISOString().slice(0, 10),
        prescriberId: TRAINING_PRESCRIBER.id,
        prescriberName: TRAINING_PRESCRIBER.name,
        prescriberGmcNumber: TRAINING_PRESCRIBER.gmcNumber,
        prescriberGphcNumber: '',
        items: [{
          productId: product.id,
          formulaId: product.formulaId,
          name: product.name,
          qty: 1,
          unitsNeededCount: product.packSize ?? 1,
          cost: product.cost,
          retail: product.retail,
        }],
      },
    });
    dispatch({ type: 'ADD_TOAST', message: 'Synthetic Clinic barcode verified for training. Nothing was sent to Curaleaf.', toastType: 'info' });
  };

  const createPaymentRequest = async () => {
    if (!activeOrder || !patient || !readyForPayment) return;
    setCheckoutBusy(true);
    try {
      if (!isLocalPortalPreview && state.workspaceMode === 'live') {
        if (!quoteAvailable) throw new Error('A complete in-stock Curaleaf quote is required before creating the live order.');
        const pricingQuote = activeOrder.pricingQuote ?? activeOrder.curaleaf?.quote;
        const quoteItems = Array.isArray(pricingQuote?.items) ? pricingQuote.items : [];
        const lineItems = activeOrder.prescriptions.flatMap(rx => rx.items.map(item => {
          const quoted = quoteItems.find(entry => entry.packId === item.productId);
          const wholesalePackPricePence = quoted ? Math.round(Number(quoted.wholesalePackPrice) * 100) : undefined;
          const catalogueItem = state.catalogue.find(entry => entry.id === item.productId);
          const packSize = Number.isInteger(catalogueItem?.packSize) && (catalogueItem?.packSize ?? 0) > 0
            ? catalogueItem!.packSize
            : undefined;
          return {
            productId: item.productId,
            packId: item.productId,
            formulaId: item.formulaId,
            name: item.name,
            quantity: item.qty,
            packSize,
            unitsNeededCount: packSize ? packSize * item.qty : item.unitsNeededCount,
            unitPricePence: Math.round((item.retail || 0) * 100),
            wholesalePackPrice: quoted?.wholesalePackPrice,
            wholesalePackPricePence,
          };
        }));
        const orderRevPence = Math.round(orderRevenue(activeOrder) * 100);
        const dispensingFeePence = Math.round((activeOrder.dispensingFee || 0) * 100);
        const medicineTotalPence = Math.max(0, orderRevPence - dispensingFeePence);
        const totalPence = orderRevPence > 0 ? orderRevPence : Math.round(activeOrder.payment.amount * 100);
        const shippingPence = pricingQuote
          ? (typeof pricingQuote.shippingPence === 'number'
            ? pricingQuote.shippingPence
            : Math.round(Number(pricingQuote.shippingPrice || 0) * 100))
          : undefined;
        const wholesaleProductPence = lineItems.reduce((sum, item) => sum + (item.wholesalePackPricePence || 0) * item.quantity, 0);

        const persisted = activeOrder.backendId ? { id: activeOrder.backendId } : await createPortalOrder({
          organisationId: state.currentOrganisationId,
          draftId: activeOrder.draftId,
          patientId: activeOrder.patientId!,
          paymentRoute: selectedPaymentRoute,
          medicineTotalPence,
          dispensingFeePence,
          totalPence,
          pricingQuote,
          quoteSnapshot: pricingQuote ? {
            quote: pricingQuote,
            pricingQuote,
            lineItems,
            totalPence,
            shippingPence,
            wholesaleProductPence,
          } : undefined,
          lineItems,
          prescriptions: activeOrder.prescriptions.map(rx => ({
            fileId: rx.fileId!,
            clinicScanId: rx.clinicScanId,
            curaleafPrescriptionId: rx.curaleafPrescriptionId,
            serialNumber: rx.serialNumber!,
            issueDate: rx.issueDate!,
            expiryDate: rx.expiryDate,
            patient: {
              name: patient.name,
              dob: patient.dob ?? '',
            },
            prescriber: {
              id: rx.prescriberId,
              pin: rx.prescriberPin ?? '',
              gmcNumber: gmcNumber(rx.prescriberGmcNumber),
              gphcNumber: rx.prescriberGphcNumber?.trim() || null,
              name: rx.prescriber,
              initials: rx.prescriber.split(/\s+/).map(part => part[0]).join('').toUpperCase().slice(0, 20),
            },
            items: rx.items.map(item => ({
              formulaId: item.formulaId!,
              unitsNeededCount: item.unitsNeededCount!,
              packId: item.productId,
              quantity: item.qty,
            })),
          })),
          currency: 'GBP',
          ...(activeOrder.redoContext ? {
            redoContext: {
              originalOrderId: activeOrder.redoContext.originalBackendId ?? activeOrder.redoContext.originalOrderId,
              isPaidRedo: activeOrder.redoContext.isPaidRedo,
              requireCuraleafAuth: true as const,
              priceResolution: activeOrder.redoContext.priceResolution === 'absorb' || activeOrder.redoContext.priceResolution === 'continue_as_fee'
                ? activeOrder.redoContext.priceResolution
                : undefined,
            },
          } : {}),
        });
        if (!activeOrder.backendId) {
          dispatch({ type: 'SET_ORDER_BACKEND_ID', orderId: activeOrder.id, backendId: persisted.id });
          if ('lineItems' in persisted) dispatch({
            type: 'SYNC_ORDER_PATIENT_PRICES',
            orderId: activeOrder.id,
            items: persisted.lineItems.map(item => ({ productId: item.productId, patientPrice: item.unitPricePence / 100 })),
          });
        }
        if (paidRedo) {
          dispatch({ type: 'CARRY_OVER_PAYMENT', orderId: activeOrder.id, sourceOrderId: activeOrder.redoContext!.originalOrderId });
          dispatch({ type: 'ADD_TOAST', message: 'The verified payment was carried over. No second patient payment was requested.', toastType: 'success' });
        } else if (selectedPaymentRoute === 'worldpay') {
          if (!canUseWorldpay) throw new Error('This pharmacy’s Worldpay connection is not verified. Change the default route in Settings.');
          const session = await createWorldpaySession(persisted.id, {
            organisationId: state.currentOrganisationId,
          });
          const provider = session.provider as { url?: string; _links?: { redirect?: { href?: string } } };
          const paymentUrl = provider.url ?? provider._links?.redirect?.href;
          if (paymentUrl) await navigator.clipboard.writeText(paymentUrl).catch(() => undefined);
          dispatch({ type: 'SEND_PAYMENT_LINK', orderId: activeOrder.id });
          dispatch({ type: 'ADD_TOAST', message: paymentUrl ? 'Worldpay checkout created and its secure link copied.' : 'Worldpay checkout created. It is awaiting the patient.', toastType: 'success' });
        } else {
          dispatch({ type: 'START_MANUAL_PAYMENT', orderId: activeOrder.id });
          dispatch({ type: 'ADD_TOAST', message: 'Order saved. Confirm the pharmacy payment before sending its prescriptions to Curaleaf.', toastType: 'success' });
        }
      } else if (paidRedo) {
        dispatch({ type: 'CARRY_OVER_PAYMENT', orderId: activeOrder.id, sourceOrderId: activeOrder.redoContext!.originalOrderId });
        dispatch({ type: 'ADD_TOAST', message: 'Training payment carry-over recorded. No second payment request was created.', toastType: 'info' });
      } else if (selectedPaymentRoute === 'worldpay') {
        if (!canUseWorldpay) return;
        dispatch({ type: 'SEND_PAYMENT_LINK', orderId: activeOrder.id });
        dispatch({ type: 'ADD_TOAST', message: 'Training Worldpay request created. No external payment was sent.', toastType: 'success' });
      } else {
        dispatch({ type: 'START_MANUAL_PAYMENT', orderId: activeOrder.id });
        dispatch({ type: 'ADD_TOAST', message: 'Training pharmacy payment selected. No external record was created.', toastType: 'success' });
      }
      dispatch({ type: 'SET_SCREEN', screen: 'orders' });
    } catch (error) {
      dispatch({ type: 'ADD_TOAST', message: error instanceof Error ? error.message : 'The order could not be created.', toastType: 'error' });
    } finally {
      setCheckoutBusy(false);
    }
  };

  const attachPrescriptionFile = async (rxId: number, file: File) => {
    if (!activeOrder) return;
    const prescription = activeOrder.prescriptions.find(candidate => candidate.id === rxId);
    if (!prescription) return;
    if (isLocalPortalPreview || state.workspaceMode !== 'live') {
      if (prescription.entryMode === 'manual') {
        dispatch({ type: 'SET_RX_FILE', orderId: activeOrder.id, rxId, fileName: file.name, fileId: `training-file-${activeOrder.id}-${rxId}` });
        dispatch({ type: 'ADD_TOAST', message: 'Manual prescription attached for training. Nothing was uploaded.', toastType: 'info' });
      } else {
        applySyntheticClinicScan(rxId, file.name);
      }
      return;
    }
    setUploadingRxId(rxId);
    try {
      if (file.size > MAX_PRESCRIPTION_FILE_BYTES) throw new Error('Prescription files must be 16 MB or smaller.');
      const contentType = await resolvePrescriptionContentType(file);
      const draftId = await ensureDurableDraft(activeOrder, durableDraftPayload ?? {});
      const uploaded = await uploadPrescriptionFile({ organisationId: state.currentOrganisationId, filename: file.name, contentType, sizeBytes: file.size }, file);
      const prescriptions = activeOrder.prescriptions.map(candidate => candidate.id === rxId
        ? { ...candidate, copyFileName: file.name, fileId: uploaded.id }
        : candidate);
      try {
        await updateOrderDraft(draftId, {
          organisationId: state.currentOrganisationId,
          patientId: activeOrder.patientId,
          payload: { ...(durableDraftPayload ?? {}), prescriptions },
        });
      } catch (error) {
        await deletePrescriptionFile(uploaded.id, state.currentOrganisationId).catch(() => undefined);
        throw error;
      }
      dispatch({ type: 'SET_RX_FILE', orderId: activeOrder.id, rxId, fileName: file.name, fileId: uploaded.id });
      if (prescription.fileId) {
        void deletePrescriptionFile(prescription.fileId, state.currentOrganisationId)
          .catch(() => console.warn('Previous prescription copy cleanup was deferred.'));
      }
      if (prescription.entryMode === 'manual') {
        dispatch({ type: 'ADD_TOAST', message: prescription.fileId ? 'Prescription copy replaced securely.' : 'Manual prescription copy uploaded securely.', toastType: 'success' });
      } else {
        dispatch({ type: 'ADD_TOAST', message: 'Prescription uploaded securely. Curaleaf is reading its barcode now.', toastType: 'success' });
        await readClinicBarcode(rxId, uploaded.id);
      }
    } catch (error) {
      dispatch({ type: 'ADD_TOAST', message: error instanceof Error ? error.message : 'Prescription upload failed.', toastType: 'error' });
    } finally {
      setUploadingRxId(null);
    }
  };

  const removePrescriptionFile = async (rxId: number) => {
    if (!activeOrder) return;
    const prescription = activeOrder.prescriptions.find(candidate => candidate.id === rxId);
    if (!prescription?.copyFileName) return;
    setFileRemovalBusyRxId(rxId);
    try {
      if (!isLocalPortalPreview && state.workspaceMode === 'live' && prescription.fileId) {
        const draftId = await ensureDurableDraft(activeOrder, durableDraftPayload ?? {});
        const prescriptions = activeOrder.prescriptions.map(candidate => candidate.id === rxId
          ? { ...candidate, copyFileName: null, fileId: null, clinicScanId: undefined, curaleafPrescriptionId: undefined }
          : candidate);
        await updateOrderDraft(draftId, {
          organisationId: state.currentOrganisationId,
          patientId: activeOrder.patientId,
          payload: { ...(durableDraftPayload ?? {}), prescriptions },
        });
        dispatch({ type: 'CLEAR_RX_FILE', orderId: activeOrder.id, rxId });
        void deletePrescriptionFile(prescription.fileId, state.currentOrganisationId)
          .catch(() => console.warn('Removed prescription copy cleanup was deferred.'));
      } else {
        dispatch({ type: 'CLEAR_RX_FILE', orderId: activeOrder.id, rxId });
      }
      setScanError(null);
      dispatch({ type: 'ADD_TOAST', message: 'Prescription copy removed. You can upload a replacement.', toastType: 'info' });
      setConfirmingFileRemoveRxId(null);
    } catch (error) {
      dispatch({ type: 'ADD_TOAST', message: error instanceof Error ? error.message : 'The prescription copy could not be removed.', toastType: 'error' });
    } finally {
      setFileRemovalBusyRxId(null);
    }
  };

  const refreshQuote = async ({ silent = false }: { silent?: boolean } = {}) => {
    if (!activeOrder || !currentQuoteItems.length || !isApiConfigured) return;
    const requestVersion = ++quoteRequestVersion.current;
    setQuoteBusy(true);
    setQuoteError(null);
    try {
      const quote = isLocalPortalPreview
        ? await getDevCuraleafQuote(currentQuoteItems)
        : state.workspaceMode === 'live'
          ? await getCuraleafQuote(state.currentOrganisationId, currentQuoteItems)
          : await getCuraleafTrainingQuote(state.currentOrganisationId, currentQuoteItems);
      if (requestVersion !== quoteRequestVersion.current) return;
      const quotedPackIds = new Set(quote.items.map(item => item.packId));
      const missingPackIds = [...new Set(currentQuoteItems.map(item => item.packId).filter(packId => !quotedPackIds.has(packId)))];
      const lineNames = (packIds: string[]) => [...new Set(
        activeOrder.prescriptions.flatMap(rx => rx.items)
          .filter(item => packIds.includes(item.productId))
          .map(item => item.name),
      )];
      if (missingPackIds.length) {
        const names = lineNames(missingPackIds);
        setQuotedSignature(null);
        setQuoteSummary(null);
        setQuotedUnavailableProductIds([]);
        setQuoteError({
          title: 'Selected pack not quoted by Curaleaf',
          detail: state.workspaceMode === 'training'
            ? `Curaleaf returned no wholesale or availability line for ${names.join(', ') || 'the selected pack'}. The draft is unchanged and no supplier order has been sent.`
            : `Curaleaf returned no wholesale or availability line for ${names.join(', ') || 'the selected pack'}, although it remains listed in the catalogue. Keep the draft and retry later, or ask your HHH administrator to raise the pack with Curaleaf.`,
        });
        return;
      }
      dispatch({
        type: 'APPLY_CURALEAF_QUOTE',
        items: quote.items.map(item => ({
          productId: item.packId,
          wholesalePrice: Number(item.wholesalePackPrice),
          patientPrice: Number(item.patientPackPrice),
          inStock: item.inStock,
          stockStatus: item.stockStatus ?? (item.inStock ? 'in_stock' : 'out_of_stock'),
        })),
      });
      const unavailableProductIds = quote.items.filter(item => !item.inStock || item.stockStatus === 'out_of_stock').map(item => item.packId);
      setQuotedSignature(currentQuoteSignature);
      setQuoteSummary({ shippingPrice: Number(quote.shippingPrice) || 0, taxRate: Number(quote.taxRate) || 0 });
      setQuotedUnavailableProductIds(unavailableProductIds);
      if (unavailableProductIds.length) {
        const names = lineNames(unavailableProductIds);
        setQuoteError({
          title: 'Selected pack is currently unavailable',
          detail: `Curaleaf returned pricing for ${names.join(', ') || 'the selected pack'} but marked it out of stock. Payment remains blocked; keep the draft and refresh later.`,
        });
        if (!silent) dispatch({ type: 'ADD_TOAST', message: 'Curaleaf returned pricing, but one or more selected packs are out of stock.', toastType: 'info' });
      } else {
        setQuoteError(null);
        if (!silent) dispatch({ type: 'ADD_TOAST', message: `Curaleaf quote refreshed for ${quote.items.length} product line${quote.items.length === 1 ? '' : 's'}.`, toastType: 'success' });
      }
    } catch (error) {
      if (requestVersion !== quoteRequestVersion.current) return;
      setQuoteSummary(null);
      setQuotedSignature(null);
      setQuotedUnavailableProductIds([]);
      setQuoteError({
        title: 'Quote request could not be completed',
        detail: error instanceof Error ? error.message : 'The Curaleaf quote could not be loaded. Wait and retry, or contact your HHH administrator if this continues.',
      });
    } finally {
      if (requestVersion === quoteRequestVersion.current) setQuoteBusy(false);
    }
  };

  const automaticQuoteRef = useRef(refreshQuote);
  automaticQuoteRef.current = refreshQuote;
  const automaticQuoteOrderId = activeOrder?.id ?? null;
  const hasCurrentQuoteItems = currentQuoteItems.length > 0;

  useEffect(() => {
    if (!automaticQuoteOrderId || !hasCurrentQuoteItems || !isApiConfigured) return;
    const timeoutId = window.setTimeout(() => {
      void automaticQuoteRef.current({ silent: true });
    }, 500);
    return () => window.clearTimeout(timeoutId);
  }, [automaticQuoteOrderId, currentQuoteSignature, hasCurrentQuoteItems, state.currentOrganisationId, state.workspaceMode]);

  const selectPatient = (patientId: string) => {
    if (!activeOrder || !patientId) return;
    if (patientId === activeOrder.patientId) {
      setChangingPatient(false);
      setPatientQuery('');
      setPatientSearchOpen(false);
      return;
    }
    const linkedPatient = orderablePatients.find(candidate => candidate.id === patientId);
    if (!linkedPatient) return;
    const replacingPatient = Boolean(activeOrder.patientId);
    dispatch({ type: 'SET_ORDER_PATIENT', orderId: activeOrder.id, patientId });
    dispatch({ type: 'ADD_TOAST', message: replacingPatient ? 'Draft reassigned. The prescription already entered was kept.' : 'Patient linked to this draft.', toastType: 'success' });
    setChangingPatient(false);
    setPatientQuery('');
    setPatientSearchOpen(false);
  };

  const handleRedoPrescription = (sourceOrderId: number) => {
    if (!activeOrder) return;
    const source = unresolvedOrdersForPatient.find(entry => entry.order.id === sourceOrderId);
    if (!source) return;
    dispatch({ type: 'APPLY_REDO_FROM_ORDER', orderId: activeOrder.id, sourceOrderId });
    setSelectedUnresolvedOrderId(sourceOrderId);
    dispatch({
      type: 'ADD_TOAST',
      message: source.order.payment.status === 'paid'
        ? `Replacement draft loaded (${source.itemCount} item${source.itemCount === 1 ? '' : 's'}). Payment can be carried over after the new prescription is authenticated.`
        : `Replacement draft loaded (${source.itemCount} item${source.itemCount === 1 ? '' : 's'}). Authenticate the new prescription before checkout.`,
      toastType: 'info',
    });
  };

  const chooseAbsorbDifference = () => {
    if (!activeOrder || paidRedoAmountDifference <= 0) return;
    dispatch({ type: 'SET_REDO_PRICE_RESOLUTION', orderId: activeOrder.id, resolution: 'absorb' });
    dispatch({ type: 'ADD_TOAST', message: `The pharmacy will absorb ${money(paidRedoAmountDifference)}. The patient’s verified payment stays unchanged.`, toastType: 'info' });
  };

  const chooseContinueAsFee = () => {
    if (!activeOrder || !redoSourceOrder || paidRedoAmountDifference >= 0) return;
    const productTotal = orderRevenue(activeOrder) - activeOrder.dispensingFee;
    const targetFee = Math.max(0, Math.round((redoSourceOrder.payment.amount - productTotal) * 100) / 100);
    const extra = Math.abs(paidRedoAmountDifference);
    dispatch({ type: 'SET_ORDER_DISPENSING_FEE', orderId: activeOrder.id, amount: targetFee });
    dispatch({ type: 'SET_REDO_PRICE_RESOLUTION', orderId: activeOrder.id, resolution: 'continue_as_fee' });
    dispatch({ type: 'ADD_TOAST', message: `${money(extra)} was added to the dispensing fee so the original payment can be carried over.`, toastType: 'info' });
  };

  const beginPatientChange = () => {
    if (activeOrder?.redoContext) return;
    setPatientQuery('');
    setPatientActiveIndex(0);
    setPatientSearchOpen(true);
    setChangingPatient(true);
  };

  const cancelPatientChange = () => {
    setChangingPatient(false);
    setPatientQuery('');
    setPatientSearchOpen(false);
    setPatientActiveIndex(0);
  };

  const renderPatientSearch = (mode: 'link' | 'change') => {
    if (!activeOrder) return null;
    return (
      <div className={`rx-patient-change${mode === 'link' ? ' is-linking' : ''}`}>
        <label className="rx-patient-change__heading" htmlFor={`rx-patient-${activeOrder.id}`}>
          <small>{mode === 'change' ? 'Change linked patient' : 'Link patient'}</small>
          <strong>{mode === 'change' ? 'Search approved patients' : 'Find an approved patient'}</strong>
          <span>{mode === 'change' ? 'The prescription already on this draft is kept. Payment stays locked if the new patient does not match it.' : 'Type a patient name or mobile number.'}</span>
        </label>
        <div className="rx-patient-combobox" onBlur={event => { if (guidedLayout && mode === 'link') return; if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPatientSearchOpen(false); }}>
          <div className="rx-patient-combobox__field">
            <Search size={15} aria-hidden="true" />
            <input
              id={`rx-patient-${activeOrder.id}`}
              className="input"
              type="search"
              name="approved-patient-directory"
              value={patientQuery}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={patientSearchOpen}
              aria-controls={`rx-patient-results-${activeOrder.id}`}
              aria-activedescendant={patientSearchOpen && matchingPatients[patientActiveIndex] ? `rx-patient-option-${matchingPatients[patientActiveIndex].id}` : undefined}
              placeholder="Search approved patients…"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              data-lpignore="true"
              data-1p-ignore="true"
              data-form-type="other"
              onFocus={() => setPatientSearchOpen(true)}
              onChange={event => { setPatientQuery(event.target.value); setPatientActiveIndex(0); setPatientSearchOpen(true); }}
              onKeyDown={event => {
                if (event.key === 'ArrowDown' && matchingPatients.length) { event.preventDefault(); setPatientSearchOpen(true); setPatientActiveIndex(index => Math.min(index + 1, matchingPatients.length - 1)); }
                if (event.key === 'ArrowUp' && matchingPatients.length) { event.preventDefault(); setPatientActiveIndex(index => Math.max(index - 1, 0)); }
                if (event.key === 'Enter' && patientSearchOpen && matchingPatients[patientActiveIndex]) { event.preventDefault(); selectPatient(matchingPatients[patientActiveIndex].id); }
                if (event.key === 'Escape') { event.preventDefault(); setPatientSearchOpen(false); }
              }}
            />
          </div>
          {patientSearchOpen || (guidedLayout && mode === 'link') ? (
            <div id={`rx-patient-results-${activeOrder.id}`} className={`rx-patient-results${guidedLayout && mode === 'link' ? ' rx-patient-results--inline' : ''}`} role="listbox" aria-label="Matching approved patients">
              {matchingPatients.length ? matchingPatients.map((candidate, index) => (
                <button
                  id={`rx-patient-option-${candidate.id}`}
                  type="button"
                  role="option"
                  aria-selected={index === patientActiveIndex}
                  className={index === patientActiveIndex ? 'active' : ''}
                  key={candidate.id}
                  onMouseEnter={() => setPatientActiveIndex(index)}
                  onClick={() => selectPatient(candidate.id)}
                >
                  <span className="rx-patient-result__avatar" aria-hidden="true">{initials(candidate.name)}</span>
                  <span><strong>{candidate.name}</strong><small className="rx-patient-result__dob">DOB {formatPatientDob(candidate.dob)}</small><small>{candidate.email} · {candidate.mobile}</small></span>
                  {candidate.id === patient?.id ? <em>Current</em> : null}
                </button>
              )) : <span className="rx-patient-results__empty">{orderablePatients.length ? `No approved patients match “${patientQuery.trim()}”.` : isLocalPortalPreview ? 'Training patients did not load. Keep ?devPortal=pharmacy in the address bar and refresh.' : 'No approved patients are available to link in this pharmacy.'}</span>}
            </div>
          ) : null}
        </div>
        {mode === 'change' ? <button type="button" className="btn btn-sm rx-patient-change__cancel" onClick={cancelPatientChange}>Cancel</button> : null}
      </div>
    );
  };

  const deleteDraft = async (orderId: number) => {
    const target = state.orders.find(order => order.id === orderId && order.organisationId === state.currentOrganisationId && order.payment.status === 'none');
    if (!target) return;
    deletedDraftOrderIds.current.add(orderId);
    if (durableDraftEnabled && target.draftId) {
      try {
        await deleteOrderDraft(target.draftId, state.currentOrganisationId);
      } catch (error) {
        deletedDraftOrderIds.current.delete(orderId);
        dispatch({ type: 'ADD_TOAST', message: error instanceof Error ? error.message : 'The saved draft could not be deleted.', toastType: 'error' });
        return;
      }
    }
    dispatch({ type: 'CLEAR_ORDER', orderId });
    dispatch({ type: 'ADD_TOAST', message: `Draft order ${orderId} deleted.`, toastType: 'info' });
    setConfirmingDraftDeleteId(null);
  };

  const renderFormularyEditor = () => {
    if (!selectedRx || !activeOrder) return null;
    return (
      <ManualPrescriptionEditor
        view="formulary"
        hideSelectedList={guidedLayout}
        prescription={selectedRx}
        catalogue={state.catalogue}
        onPrescriberChange={value => dispatch({ type: 'SET_RX_PRESCRIBER', orderId: activeOrder.id, rxId: selectedRx.id, prescriber: value })}
        onMetadataChange={(field, value) => dispatch({ type: 'SET_RX_METADATA', orderId: activeOrder.id, rxId: selectedRx.id, updates: { [field]: value } })}
        onAddItem={item => dispatch({ type: 'ADD_ITEM_TO_RX', orderId: activeOrder.id, rxId: selectedRx.id, item })}
        onRemoveItem={productId => dispatch({ type: 'REMOVE_ITEM_FROM_RX', orderId: activeOrder.id, rxId: selectedRx.id, productId })}
        onUpdateQuantity={(productId, qty) => dispatch({ type: 'UPDATE_ITEM_QTY', orderId: activeOrder.id, rxId: selectedRx.id, productId, qty })}
        onUpdateUnits={(productId, unitsNeededCount) => dispatch({ type: 'UPDATE_ITEM_UNITS', orderId: activeOrder.id, rxId: selectedRx.id, productId, unitsNeededCount })}
      />
    );
  };

  return (
    <>
    <div className={`page-body rx-workbench${guidedLayout ? ' rx-workbench--guided' : ''}`}>
      {isLocalPortalPreview ? (
        <p className="rx-guided-preview-banner" role="status">
          Local training preview. Synthetic barcode and quotes stay on this machine.
        </p>
      ) : null}
      <section className="rx-draft-bar card" aria-label="Prescription draft sessions">
        <div className="rx-draft-bar__title">
          <p className="section-label">Draft sessions</p>
          <strong>{draftOrders.length} open</strong>
        </div>
        <div className="rx-draft-tabs" role="tablist" aria-label="Open prescription drafts">
          {draftOrders.map(order => {
            const draftPatient = order.patientId ? organisationPatients.find(candidate => candidate.id === order.patientId) : null;
            const active = order.id === state.activeOrderId;
            return (
              <div className={`rx-draft-tab-wrap${active ? ' active' : ''}`} key={order.id}>
                <button type="button" role="tab" aria-selected={active} className="rx-draft-tab" onClick={() => dispatch({ type: 'SET_ACTIVE_ORDER', orderId: order.id })}>
                  <span className="rx-draft-tab__avatar">{draftPatient ? initials(draftPatient.name) : '—'}</span>
                  <span>
                    <strong>{draftPatient?.name ?? `Unlinked draft #${order.id}`}</strong>
                    <small>{order.prescriptions.length} Rx{order.prescriptions.length === 1 ? '' : 's'}{order.redoContext ? ` · ${orderReference(order)}` : ''}</small>
                  </span>
                </button>
                <button type="button" className="rx-draft-tab-delete" aria-label={`Delete ${draftPatient?.name ?? `unlinked draft ${order.id}`}`} onClick={() => setConfirmingDraftDeleteId(order.id)}><Trash2 size={13} /></button>
              </div>
            );
          })}
        </div>
        <button type="button" className="btn btn-primary rx-new-draft" onClick={() => dispatch({ type: 'NEW_ORDER' })}>
          + New patient order
        </button>
      </section>

      {confirmingDraft ? (
        <section className="rx-draft-delete-confirm card" role="alertdialog" aria-modal="true" aria-label={`Delete ${confirmingDraftLabel}`}>
          <span><Trash2 size={16} /><span><strong>Delete {confirmingDraftLabel}?</strong><small>This removes every unfinished prescription record in this draft. This cannot be undone.</small></span></span>
          <div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmingDraftDeleteId(null)}>Keep draft</button>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => void deleteDraft(confirmingDraft.id)}>Delete draft</button>
          </div>
        </section>
      ) : null}

      {!activeOrder ? (
        <div className="empty-state">
          <FileText size={32} />
          <h3>No active prescription</h3>
          <p className="empty-desc">Start a prescription, link an approved patient and add the supplied prescription records.</p>
        </div>
      ) : (
        <div className={guidedLayout ? 'rx-guided' : 'rx-workbench-stack'}>
          <div className={guidedLayout ? 'rx-guided__stage' : 'rx-workbench-stack'}>
            {guidedLayout ? (
              <header className="rx-guided__stage-head">
                <p className="section-label">Step {guidedStep} of 4</p>
                <h2 key={guidedStep} ref={guidedStageHeadingRef} tabIndex={-1}>{guidedStageTitle}</h2>
              </header>
            ) : null}
            {guidedLockNotice ? <p className="rx-guided__lock-notice" role="status">{guidedLockNotice}</p> : null}

          <section id="rx-guided-card-1" className={`rx-patient-band rx-builder-context card${changingPatient || !patient ? ' is-changing-patient' : ''}${guidedLayout ? ` rx-guided-reveal is-in${guidedStep === 1 ? ' is-current' : ''}` : ''}`}>
            <div className="rx-patient-band__identity rx-builder-patient">
              {patient ? (
                changingPatient ? (
                  renderPatientSearch('change')
                ) : (
                  <>
                    <span className="avatar">{initials(patient.name)}</span>
                    <span className="rx-patient-identity-copy">
                      <p className="section-label">STEP 1</p>
                      <p className="section-label rx-patient-approved-label"><CheckCircle size={12} /> Approved patient</p>
                      <strong>{patient.name}</strong>
                      <span className="rx-patient-meta" aria-label="Patient identity details">
                        <span>DOB {formatPatientDob(patient.dob)}</span>
                        <span>{patient.email}</span>
                        <span>{patient.mobile}</span>
                      </span>
                    </span>
                    <div className="rx-patient-actions">
                      {activeOrder.redoContext
                        ? <span className="rx-redo-patient-lock"><ShieldCheck size={12} /> Locked to redo</span>
                        : <button type="button" className="btn btn-secondary btn-sm" onClick={beginPatientChange}><Pencil size={12} /> Change</button>}
                      <button type="button" className="icon-button danger" aria-label="Delete this prescription draft" title="Delete draft" onClick={() => setConfirmingDraftDeleteId(activeOrder.id)}><Trash2 size={14} /></button>
                    </div>
                  </>
                )
              ) : (
                renderPatientSearch('link')
              )}
            </div>
            {guidedLayout ? null : (
              <ol className="rx-builder-flow" aria-label="Create order workflow">
                {workflowSteps.map((step, index) => (
                  <li key={step.label} className={step.complete ? 'complete' : step.active ? 'active' : ''}>
                    <span className="rx-builder-flow__number">{step.complete ? <CheckCircle size={15} /> : index + 1}</span>
                    <span><strong>{step.label}</strong><small>{step.detail}</small></span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {patient && !canCreateOrderForPatient(patient) ? (
            <ProviderStatusNotice title="This patient cannot start an order" detail="The linked patient is no longer approved or referred. Change the patient, or wait until their record is eligible again." />
          ) : null}

          {patient && activeOrder.redoContext ? (
            <section className="rx-replacement-context card" aria-label={`Replacement order ${activeOrderRef}`}>
              <span className="rx-replacement-context__mark">{activeOrderRef.replace(/^#\d+/, '')}</span>
              <span className="rx-replacement-context__identity">
                <p className="section-label">Replacement prescription</p>
                <strong>Order {activeOrderRef}</strong>
                <small>
                  Replaces order {redoSourceOrder ? orderReference(redoSourceOrder) : `#${activeOrder.redoContext.originalOrderId}`}
                  {' · '}{activeOrder.redoContext.reason === 'rejected' ? 'Curaleaf rejected' : 'Prescription expired'}
                </small>
              </span>
              <span className="rx-replacement-context__carry">
                <strong>{activeOrder.prescriptions.flatMap(rx => rx.items).length} medicine{activeOrder.prescriptions.flatMap(rx => rx.items).length === 1 ? '' : 's'} carried forward</strong>
                <small>The old document was cleared automatically.</small>
              </span>
              <span className="rx-replacement-context__next"><ShieldCheck size={15} /><span><strong>New prescription required</strong><small>Authenticate the replacement below.</small></span></span>
            </section>
          ) : patient && unresolvedOrdersForPatient.length > 0 ? (
            <details className="rx-unresolved-panel rx-unresolved-drawer card" aria-label="Unresolved archived and rejected orders">
              <summary className="rx-unresolved-panel__header">
                <span>
                  <p className="section-label">Unresolved for this patient</p>
                  <strong>{unresolvedOrdersForPatient.length} archived / rejected order{unresolvedOrdersForPatient.length === 1 ? '' : 's'}</strong>
                  <small>Open to repair a previous order using a newly authenticated prescription.</small>
                </span>
                <span className="pill pill-neutral">Review</span>
              </summary>
              <div className="rx-unresolved-drawer__body">
                <p>Select one to load its medicines into this draft. The old document is never reused; a new prescription must pass authentication.</p>
                <div className="rx-unresolved-list" role="listbox" aria-label="Unresolved orders">
                {unresolvedOrdersForPatient.map(entry => {
                  const selected = selectedUnresolvedOrderId === entry.order.id;
                  const itemNames = entry.order.prescriptions.flatMap(rx => rx.items.map(item => item.name));
                  return (
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      key={entry.order.id}
                      className={`rx-unresolved-item${selected ? ' is-selected' : ''}`}
                      onClick={() => setSelectedUnresolvedOrderId(entry.order.id)}
                    >
                      <span className="rx-unresolved-item__meta">
                        <strong>Order {orderReference(entry.order)}</strong>
                        <small>
                          {entry.reason === 'rejected' ? 'Curaleaf rejected' : '28-day archived'}
                          {' · '}
                          {new Date(entry.order.date).toLocaleDateString('en-GB')}
                          {' · '}
                          {entry.order.payment.status === 'paid' ? 'Paid' : entry.order.payment.status}
                        </small>
                      </span>
                      <span className="rx-unresolved-item__items">
                        {entry.itemCount} item{entry.itemCount === 1 ? '' : 's'}
                        {itemNames.length ? ` · ${itemNames.slice(0, 2).join(', ')}${itemNames.length > 2 ? '…' : ''}` : ''}
                      </span>
                      <span className={`pill ${entry.reason === 'rejected' ? 'pill-red' : 'pill-neutral'}`}>{entry.reason === 'rejected' ? 'Rejected' : 'Archived'}</span>
                    </button>
                  );
                })}
                </div>
                <footer className="rx-unresolved-panel__actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!selectedUnresolvedOrderId}
                  onClick={() => selectedUnresolvedOrderId && handleRedoPrescription(selectedUnresolvedOrderId)}
                >
                  <RefreshCw size={14} />
                  Use this draft as replacement
                </button>
                <span>
                  Clears the old PDF and pre-fills medicines. New Curaleaf prescription authentication is required
                  {selectedUnresolvedOrderId && unresolvedOrdersForPatient.find(entry => entry.order.id === selectedUnresolvedOrderId)?.order.payment.status === 'paid'
                    ? '; the existing verified payment is carried over after authentication, so no second payment request is created.'
                    : '.'}
                </span>
                </footer>
              </div>
            </details>
          ) : null}

          {guidedLayout ? null : (
            <button type="button" className="rx-mobile-review-bar" onClick={() => document.getElementById('rx-order-review')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })}>
              <span><small>Patient total</small><strong>{money(orderRevenue(activeOrder))}</strong></span>
              <span>Review order <ArrowRight size={15} /></span>
            </button>
          )}

          <div hidden={guidedLayout && guidedReveal < 2} className={guidedLayout ? 'rx-guided__work' : 'rx-workbench-layout'}>
            <main hidden={guidedLayout && guidedReveal < 2} className="rx-workbench-main">
              {guidedLayout && selectedRx ? (
                <>
                  <section id="rx-guided-card-2-route" className={`rx-surface card rx-guided-card rx-guided-reveal is-in${guidedStep === 2 && guidedRxPhaseForProgress === 'route' ? ' is-current' : ''}`}>
                      <header className="rx-surface__header">
                        <div className="section-heading" style={{ margin: 0 }}>
                          <div>
                            <p className="section-label">Step 2A · Choose a route</p>
                            <h3><FileText size={17} /> Scan Curaleaf QR or enter details manually</h3>
                          </div>
                        </div>
                      </header>
                      <div className="rx-guided-card__body">
                        <p className="rx-guided__route-lead">Choose one route for this draft. Next you will upload the prescription copy.</p>
                        <div className="rx-entry-mode rx-entry-mode--choose" role="group" aria-label="Prescription entry route">
                          <button type="button" aria-pressed={guidedRouteChosen && selectedRx.entryMode === 'clinic'} onClick={() => chooseGuidedRoute('clinic')}>
                            <FileScan size={15} /><span><strong>Scan Curaleaf QR</strong><small>Then upload the prescription with a clear barcode</small></span>
                          </button>
                          <button type="button" aria-pressed={guidedRouteChosen && selectedRx.entryMode === 'manual'} onClick={() => chooseGuidedRoute('manual')}>
                            <Pencil size={15} /><span><strong>Enter details manually</strong><small>Then upload the signed copy and type the fields</small></span>
                          </button>
                        </div>
                        {confirmingRouteSwitch ? (
                          <div className="rx-prescription-cancel-confirm" role="alertdialog" aria-modal="true" aria-label="Switch prescription entry route">
                            <AlertTriangle size={16} />
                            <span>
                              <strong>Switch to {confirmingRouteSwitch === 'clinic' ? 'Curaleaf QR' : 'manual entry'}?</strong>
                              <small>This clears the current upload and prescription details. Medicines already chosen will also be removed.</small>
                            </span>
                            <div>
                              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmingRouteSwitch(null)}>Keep current route</button>
                              <button type="button" className="btn btn-danger btn-sm" onClick={() => applyGuidedRoute(confirmingRouteSwitch)}>Switch route</button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </section>

                  {rxPhaseRank(guidedRxReveal) >= 2 ? (
                    <section id="rx-guided-card-2-upload" className={`rx-surface card rx-guided-card rx-guided-reveal is-in${guidedStep === 2 && guidedRxPhaseForProgress === 'upload' ? ' is-current' : ''}`}>
                      <header className="rx-surface__header">
                        <div className="section-heading" style={{ margin: 0 }}>
                          <div>
                            <p className="section-label">Step 2B · Upload</p>
                            <h3><Upload size={17} /> {selectedRx.entryMode === 'clinic' ? 'Upload the prescription and scan the QR' : 'Upload the signed prescription copy'}</h3>
                          </div>
                        </div>
                      </header>
                      <div className="rx-guided-card__body">
                        <div className="rx-clinic-note">
                          <Upload size={18} aria-hidden="true" />
                          <span>
                            <strong>{selectedRx.entryMode === 'clinic' ? 'Clear barcode required' : 'All other details must stay visible'}</strong>
                            <span>{selectedRx.entryMode === 'clinic' ? 'Attach a redacted copy (redact patient details) of the prescription with a clear barcode. (TIP: Apply a blank dispensing label to cover confidential patient details).' : 'Attach a redacted copy (redact patient details) of the prescription with all other prescription details clearly visible. (TIP: Apply a blank dispensing label to cover confidential patient details).'}</span>
                          </span>
                        </div>
                        {(isLocalPortalPreview || state.workspaceMode === 'training') && selectedRx.entryMode === 'clinic' ? <button type="button" className={`rx-document-control${selectedRx.clinicScanId ? ' uploaded' : ''}`} onClick={() => applySyntheticClinicScan(selectedRx.id)}>
                          {selectedRx.clinicScanId ? <CheckCircle size={18} /> : <FileScan size={18} />}<span><strong>{selectedRx.clinicScanId ? 'Synthetic Clinic barcode verified' : 'Use synthetic Clinic barcode'}</strong><small>Isolated local training fixture · nothing is uploaded or sent</small></span>
                        </button> : <label className={`rx-document-control${selectedRx.copyFileName ? ' uploaded' : ''}${readingRxId === selectedRx.id ? ' scanning' : ''}`}>
                          <input className="sr-only" type="file" accept={PRESCRIPTION_FILE_ACCEPT} disabled={uploadingRxId !== null} onChange={event => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void attachPrescriptionFile(selectedRx.id, file); }} />
                          {selectedRx.clinicScanId ? <CheckCircle size={18} /> : readingRxId === selectedRx.id ? <RefreshCw size={18} className="spin" /> : <Upload size={18} />}<span><strong>{uploadingRxId === selectedRx.id ? 'Uploading securely…' : readingRxId === selectedRx.id ? 'Curaleaf is reading its barcode…' : selectedRx.copyFileName ?? (selectedRx.entryMode === 'manual' ? 'Attach signed prescription' : 'Attach barcode prescription')}</strong><small>{selectedRx.clinicScanId ? 'Barcode verified and linked to this prescription' : selectedRx.fileId ? 'Uploaded and server-verified' : 'PDF, JPG or PNG · maximum 16 MB'}</small></span>
                        </label>}
                        {selectedRx.entryMode === 'clinic' && state.workspaceMode === 'live' && !isLocalPortalPreview && selectedRx.fileId && !selectedRx.clinicScanId && readingRxId !== selectedRx.id ? <button type="button" className="btn btn-sm rx-scan-retry" onClick={() => void readClinicBarcode(selectedRx.id, selectedRx.fileId!)}><RefreshCw size={13} /> Check barcode again</button> : null}
                        {selectedRx.copyFileName ? (
                          <div className="rx-document-actions">
                            <span>Choose the upload control above to replace this copy.</span>
                            <button type="button" className="btn btn-sm btn-danger" disabled={fileRemovalBusyRxId === selectedRx.id} onClick={() => setConfirmingFileRemoveRxId(selectedRx.id)}><Trash2 size={13} /> Remove copy</button>
                          </div>
                        ) : null}
                        {confirmingFileRemoveRxId === selectedRx.id ? (
                          <div className="rx-prescription-cancel-confirm" role="alertdialog" aria-modal="true" aria-label={`Remove ${selectedRx.copyFileName}`}>
                            <AlertTriangle size={16} />
                            <span><strong>Remove {selectedRx.copyFileName}?</strong><small>The encrypted copy will be removed from this draft. You can then upload a replacement.</small></span>
                            <div><button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmingFileRemoveRxId(null)}>Keep copy</button><button type="button" className="btn btn-danger btn-sm" disabled={fileRemovalBusyRxId === selectedRx.id} onClick={() => void removePrescriptionFile(selectedRx.id)}>{fileRemovalBusyRxId === selectedRx.id ? 'Removing…' : 'Remove copy'}</button></div>
                          </div>
                        ) : null}
                        {selectedRx.entryMode === 'clinic' && scanError ? <ProviderStatusNotice title="Barcode not verified" detail={`${scanError} Check that the full Curaleaf Clinic barcode is sharp and visible. If it still fails, use the manual route or contact your HHH administrator.`} /> : null}
                      </div>
                    </section>
                  ) : null}

                  {rxPhaseRank(guidedRxReveal) >= 3 ? (
                    <section id="rx-guided-card-2-details" className={`rx-surface card rx-guided-card rx-guided-reveal is-in${guidedStep === 2 && guidedRxPhaseForProgress === 'details' ? ' is-current' : ''}`}>
                      <header className="rx-surface__header">
                        <div className="section-heading" style={{ margin: 0 }}>
                          <div>
                            <p className="section-label">Step 2C · {selectedRx.entryMode === 'manual' ? 'Manual details' : 'Scan result'}</p>
                            <h3><FileText size={17} /> {selectedRx.entryMode === 'manual' ? 'Enter the signed prescription' : 'Confirm the Curaleaf scan'}</h3>
                          </div>
                        </div>
                      </header>
                      <div className="rx-guided-card__body">
                        {selectedRx.entryMode === 'manual' ? (
                          <ManualPrescriptionEditor
                            view="details"
                            prescription={selectedRx}
                            catalogue={state.catalogue}
                            onPrescriberChange={value => dispatch({ type: 'SET_RX_PRESCRIBER', orderId: activeOrder.id, rxId: selectedRx.id, prescriber: value })}
                            onMetadataChange={(field, value) => dispatch({ type: 'SET_RX_METADATA', orderId: activeOrder.id, rxId: selectedRx.id, updates: { [field]: value } })}
                            onAddItem={item => dispatch({ type: 'ADD_ITEM_TO_RX', orderId: activeOrder.id, rxId: selectedRx.id, item })}
                            onRemoveItem={productId => dispatch({ type: 'REMOVE_ITEM_FROM_RX', orderId: activeOrder.id, rxId: selectedRx.id, productId })}
                            onUpdateQuantity={(productId, qty) => dispatch({ type: 'UPDATE_ITEM_QTY', orderId: activeOrder.id, rxId: selectedRx.id, productId, qty })}
                            onUpdateUnits={(productId, unitsNeededCount) => dispatch({ type: 'UPDATE_ITEM_UNITS', orderId: activeOrder.id, rxId: selectedRx.id, productId, unitsNeededCount })}
                          />
                        ) : selectedRx.clinicScanId ? (
                          <div className="rx-clinic-result" aria-label="Curaleaf verified prescription details">
                            <div className="rx-clinic-result__status"><ShieldCheck size={18} /><span><strong>{isLocalPortalPreview ? 'Synthetic Curaleaf response' : 'Verified by Curaleaf'}</strong><small>{isLocalPortalPreview ? 'Read-only local training fixture' : 'Read-only supplier record'} · {selectedRx.curaleafPrescriptionState}</small></span></div>
                            <dl>
                              <div><dt>Prescription serial</dt><dd>{selectedRx.serialNumber}</dd></div>
                              <div><dt>Prescriber</dt><dd>{selectedRx.prescriber}</dd></div>
                              <div><dt>Issued</dt><dd>{selectedRx.issueDate ? new Date(`${selectedRx.issueDate}T00:00:00`).toLocaleDateString('en-GB') : '—'}</dd></div>
                              <div><dt>Expires</dt><dd>{selectedRx.expiryDate ? new Date(`${selectedRx.expiryDate}T00:00:00`).toLocaleDateString('en-GB') : '—'}</dd></div>
                              <div><dt>Registration</dt><dd>{selectedRx.prescriberGmcNumber ? `GMC ${selectedRx.prescriberGmcNumber}` : selectedRx.prescriberGphcNumber ? `GPhC ${selectedRx.prescriberGphcNumber}` : 'Held by Curaleaf'}</dd></div>
                            </dl>
                          </div>
                        ) : <p className="rx-scan-waiting">No prescription fields need completing. They appear here after Curaleaf verifies the barcode.</p>}
                      </div>
                    </section>
                  ) : null}
                </>
              ) : (
              <section hidden={guidedLayout} className="rx-surface card rx-record-editor">
                <header className="rx-surface__header">
                  <div className="section-heading" style={{ margin: 0 }}>
                    <div>
                      <p className="section-label">Step 2 · Prescription</p>
                      <h3><FileText size={17} /> {guidedLayout ? 'One prescription for this draft' : 'Authenticate each prescription record'}</h3>
                    </div>
                  </div>
                  {guidedLayout ? null : (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => dispatch({ type: 'ADD_RX', orderId: activeOrder.id })}>+Add Rx</button>
                  )}
                </header>
                {guidedLayout && activeOrder.prescriptions.length <= 1 ? null : (
                <div className="rx-record-tabs" role="tablist" aria-label="Prescription records">
                  {activeOrder.prescriptions.map((rx, index) => {
                    const active = rx.id === selectedRxId;
                    return (
                      <button key={rx.id} type="button" role="tab" aria-selected={active} className={active ? 'active' : ''} onClick={() => setSelectedRxId(rx.id)}>
                        <FileText size={14} />
                        <span><strong>Rx {index + 1}</strong><small>{rx.items.length} item{rx.items.length === 1 ? '' : 's'}</small></span>
                        <span className={`rx-record-state${rx.copyFileName && rx.prescriber.trim() ? ' complete' : ''}`} aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
                )}

                {selectedRx && (
                  <div className="rx-record-body">
                    <div className="rx-record-evidence">
                      {guidedLayout ? null : (
                      <div className="rx-record-evidence__heading">
                        <div>
                          <p className="section-label">Editing</p>
                          <strong>Prescription {selectedRxIndex + 1}</strong>
                        </div>
                        {activeOrder.prescriptions.length > 1 && (
                          <button type="button" className="icon-button danger" aria-label={`Delete prescription ${selectedRxIndex + 1}`} title="Cancel this prescription record" onClick={() => setConfirmingRxDeleteId(selectedRx.id)}>
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                      )}
                      {confirmingRxDeleteId === selectedRx.id ? (
                        <div className="rx-prescription-cancel-confirm" role="alert">
                          <AlertTriangle size={16} />
                          <span><strong>Cancel prescription {selectedRxIndex + 1}?</strong><small>This removes only this unpaid draft prescription. Once a payment request exists, cancellation is handled from Orders with the payment and Curaleaf safeguards.</small></span>
                          <div><button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmingRxDeleteId(null)}>Keep it</button><button type="button" className="btn btn-danger btn-sm" onClick={() => { dispatch({ type: 'REMOVE_RX', orderId: activeOrder.id, rxId: selectedRx.id }); dispatch({ type: 'ADD_TOAST', message: `Cancelled prescription ${selectedRxIndex + 1}.`, toastType: 'info' }); setConfirmingRxDeleteId(null); }}>Cancel prescription</button></div>
                        </div>
                      ) : null}
                      <div className={`rx-entry-mode${guidedLayout && !guidedRouteChosen ? ' rx-entry-mode--choose' : ''}`} role="group" aria-label="Prescription entry route">
                        <button type="button" aria-pressed={(!guidedLayout || guidedRouteChosen) && selectedRx.entryMode === 'clinic'} onClick={() => { setEditingClinicFormularyRxId(null); dispatch({ type: 'SET_RX_ENTRY_MODE', orderId: activeOrder.id, rxId: selectedRx.id, mode: 'clinic' }); if (guidedLayout) { setGuidedRouteChosen(true); setGuidedLockNotice(null); } }}>
                          <FileScan size={15} /><span><strong>Scan Curaleaf QR</strong><small>{guidedLayout ? 'Then upload the prescription with a clear barcode' : 'Preferred automatic route'}</small></span>
                        </button>
                        <button type="button" aria-pressed={(!guidedLayout || guidedRouteChosen) && selectedRx.entryMode === 'manual'} onClick={() => { setEditingClinicFormularyRxId(null); dispatch({ type: 'SET_RX_ENTRY_MODE', orderId: activeOrder.id, rxId: selectedRx.id, mode: 'manual' }); if (guidedLayout) { setGuidedRouteChosen(true); setGuidedLockNotice(null); } }}>
                          <Pencil size={15} /><span><strong>Enter details manually</strong><small>{guidedLayout ? 'Then upload the signed copy and type the fields' : 'Copy from the signed document'}</small></span>
                        </button>
                      </div>
                      {guidedLayout && !guidedRouteChosen ? (
                        <p className="rx-guided__route-lead">Choose one route for this draft. Next you will upload the prescription copy.</p>
                      ) : (
                      <>
                      <div className="rx-clinic-note">
                        <Upload size={18} aria-hidden="true" />
                        <span>
                          <strong>{selectedRx.entryMode === 'clinic' ? 'Upload the prescription and scan the QR' : 'Upload the signed prescription copy'}</strong>
                          <span>{selectedRx.entryMode === 'clinic' ? 'Attach a redacted copy (redact patient details) of the prescription with a clear barcode. (TIP: Apply a blank dispensing label to cover confidential patient details).' : 'Attach a redacted copy (redact patient details) of the prescription with all other prescription details clearly visible. (TIP: Apply a blank dispensing label to cover confidential patient details).'}</span>
                        </span>
                      </div>
                      {(isLocalPortalPreview || state.workspaceMode === 'training') && selectedRx.entryMode === 'clinic' ? <button type="button" className={`rx-document-control${selectedRx.clinicScanId ? ' uploaded' : ''}`} onClick={() => applySyntheticClinicScan(selectedRx.id)}>
                        {selectedRx.clinicScanId ? <CheckCircle size={18} /> : <FileScan size={18} />}<span><strong>{selectedRx.clinicScanId ? 'Synthetic Clinic barcode verified' : 'Use synthetic Clinic barcode'}</strong><small>Isolated local training fixture · nothing is uploaded or sent</small></span>
                      </button> : <label className={`rx-document-control${selectedRx.copyFileName ? ' uploaded' : ''}${readingRxId === selectedRx.id ? ' scanning' : ''}`}>
                        <input className="sr-only" type="file" accept={PRESCRIPTION_FILE_ACCEPT} disabled={uploadingRxId !== null} onChange={event => { const file = event.target.files?.[0]; event.currentTarget.value = ''; if (file) void attachPrescriptionFile(selectedRx.id, file); }} />
                        {selectedRx.clinicScanId ? <CheckCircle size={18} /> : readingRxId === selectedRx.id ? <RefreshCw size={18} className="spin" /> : <Upload size={18} />}<span><strong>{uploadingRxId === selectedRx.id ? 'Uploading securely…' : readingRxId === selectedRx.id ? 'Curaleaf is reading its barcode…' : selectedRx.copyFileName ?? (selectedRx.entryMode === 'manual' ? 'Attach signed prescription' : 'Attach barcode prescription')}</strong><small>{selectedRx.clinicScanId ? 'Barcode verified and linked to this prescription' : selectedRx.fileId ? 'Uploaded and server-verified' : 'PDF, JPG or PNG · maximum 16 MB'}</small></span>
                      </label>}
                      {selectedRx.entryMode === 'clinic' && state.workspaceMode === 'live' && !isLocalPortalPreview && selectedRx.fileId && !selectedRx.clinicScanId && readingRxId !== selectedRx.id ? <button type="button" className="btn btn-sm rx-scan-retry" onClick={() => void readClinicBarcode(selectedRx.id, selectedRx.fileId!)}><RefreshCw size={13} /> Check barcode again</button> : null}
                      {selectedRx.copyFileName ? (
                        <div className="rx-document-actions">
                          <span>Choose the upload control above to replace this copy.</span>
                          <button type="button" className="btn btn-sm btn-danger" disabled={fileRemovalBusyRxId === selectedRx.id} onClick={() => setConfirmingFileRemoveRxId(selectedRx.id)}><Trash2 size={13} /> Remove copy</button>
                        </div>
                      ) : null}
                      {confirmingFileRemoveRxId === selectedRx.id ? (
                        <div className="rx-prescription-cancel-confirm" role="alertdialog" aria-modal="true" aria-label={`Remove ${selectedRx.copyFileName}`}>
                          <AlertTriangle size={16} />
                          <span><strong>Remove {selectedRx.copyFileName}?</strong><small>The encrypted copy will be removed from this draft. You can then upload a replacement.</small></span>
                          <div><button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmingFileRemoveRxId(null)}>Keep copy</button><button type="button" className="btn btn-danger btn-sm" disabled={fileRemovalBusyRxId === selectedRx.id} onClick={() => void removePrescriptionFile(selectedRx.id)}>{fileRemovalBusyRxId === selectedRx.id ? 'Removing…' : 'Remove copy'}</button></div>
                        </div>
                      ) : null}
                      {selectedRx.entryMode === 'clinic' && scanError ? <ProviderStatusNotice title="Barcode not verified" detail={`${scanError} Check that the full Curaleaf Clinic barcode is sharp and visible. If it still fails, use the manual route or contact your HHH administrator.`} /> : null}
                      </>
                      )}
                    </div>

                    {(!guidedLayout || prescriptionUploaded) ? (
                    <div className="rx-line-editor rx-prescription-details">
                      {selectedRx.entryMode === 'manual' ? (
                        <ManualPrescriptionEditor
                          view="details"
                          prescription={selectedRx}
                          catalogue={state.catalogue}
                          onPrescriberChange={value => dispatch({ type: 'SET_RX_PRESCRIBER', orderId: activeOrder.id, rxId: selectedRx.id, prescriber: value })}
                          onMetadataChange={(field, value) => dispatch({ type: 'SET_RX_METADATA', orderId: activeOrder.id, rxId: selectedRx.id, updates: { [field]: value } })}
                          onAddItem={item => dispatch({ type: 'ADD_ITEM_TO_RX', orderId: activeOrder.id, rxId: selectedRx.id, item })}
                          onRemoveItem={productId => dispatch({ type: 'REMOVE_ITEM_FROM_RX', orderId: activeOrder.id, rxId: selectedRx.id, productId })}
                          onUpdateQuantity={(productId, qty) => dispatch({ type: 'UPDATE_ITEM_QTY', orderId: activeOrder.id, rxId: selectedRx.id, productId, qty })}
                          onUpdateUnits={(productId, unitsNeededCount) => dispatch({ type: 'UPDATE_ITEM_UNITS', orderId: activeOrder.id, rxId: selectedRx.id, productId, unitsNeededCount })}
                        />
                      ) : selectedRx.clinicScanId ? (
                        <div className="rx-clinic-result" aria-label="Curaleaf verified prescription details">
                          <div className="rx-clinic-result__status"><ShieldCheck size={18} /><span><strong>{isLocalPortalPreview ? 'Synthetic Curaleaf response' : 'Verified by Curaleaf'}</strong><small>{isLocalPortalPreview ? 'Read-only local training fixture' : 'Read-only supplier record'} · {selectedRx.curaleafPrescriptionState}</small></span></div>
                          <dl>
                            <div><dt>Prescription serial</dt><dd>{selectedRx.serialNumber}</dd></div>
                            <div><dt>Prescriber</dt><dd>{selectedRx.prescriber}</dd></div>
                            <div><dt>Issued</dt><dd>{selectedRx.issueDate ? new Date(`${selectedRx.issueDate}T00:00:00`).toLocaleDateString('en-GB') : '—'}</dd></div>
                            <div><dt>Expires</dt><dd>{selectedRx.expiryDate ? new Date(`${selectedRx.expiryDate}T00:00:00`).toLocaleDateString('en-GB') : '—'}</dd></div>
                            <div><dt>Registration</dt><dd>{selectedRx.prescriberGmcNumber ? `GMC ${selectedRx.prescriberGmcNumber}` : selectedRx.prescriberGphcNumber ? `GPhC ${selectedRx.prescriberGphcNumber}` : 'Held by Curaleaf'}</dd></div>
                          </dl>
                        </div>
                      ) : <p className="rx-scan-waiting">No prescription fields need completing. They appear here after Curaleaf verifies the barcode.</p>}
                    </div>
                    ) : null}
                  </div>
                )}
              </section>
              )}

              <section id="rx-guided-card-3" hidden={guidedLayout && guidedReveal < 3} className={`rx-surface card rx-formulary-stage${guidedLayout && guidedReveal >= 3 ? ` rx-guided-reveal is-in${guidedStep === 3 ? ' is-current' : ''}` : ''}`}>
                <header className="rx-surface__header">
                  <div className="section-heading" style={{ margin: 0 }}>
                    <div>
                      <p className="section-label">Step 3 · Products</p>
                      <h3>
                        <ShieldCheck size={17} />
                        {selectedRx?.entryMode === 'manual'
                          ? 'Select the prescribed Curaleaf medicines'
                          : editingClinicFormularyRxId === selectedRx?.id
                            ? 'Correct the Curaleaf formula and pack match'
                            : 'Review the Curaleaf formula and pack match'}
                      </h3>
                    </div>
                  </div>
                  <div className="rx-formulary-actions">
                    {selectedRx?.items.length ? <span className="pill pill-green"><CheckCircle size={11} /> {selectedRx.entryMode === 'clinic' && editingClinicFormularyRxId !== selectedRx.id ? 'Matched automatically' : `${selectedRx.items.length} selected`}</span> : null}
                    {selectedRx?.entryMode === 'clinic' && selectedRx.clinicScanId ? (
                      editingClinicFormularyRxId === selectedRx.id ? (
                        <button type="button" className="btn btn-sm btn-primary" onClick={() => { setEditingClinicFormularyRxId(null); dispatch({ type: 'ADD_TOAST', message: 'Formulary corrections saved to this prescription draft.', toastType: 'success' }); }}><Save size={13} /> Save formulary</button>
                      ) : (
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditingClinicFormularyRxId(selectedRx.id)}><Pencil size={13} /> Edit formulary</button>
                      )
                    ) : null}
                  </div>
                </header>
                {state.catalogueLoading ? <ProviderStatusNotice state="loading" title="Refreshing Curaleaf products" detail="The latest patient prices and pack information are being retrieved." /> : null}
                {state.catalogueError ? <ProviderStatusNotice title="Curaleaf information is temporarily delayed" detail="Wait and try again later. If this continues, contact your HHH administrator; pharmacy staff do not need to change the connection." /> : null}
                {!selectedRx ? <div className="rx-inline-empty"><FileText size={20} /><span><strong>Select a prescription record</strong><small>Its prescribed medicines will appear here.</small></span></div> : selectedRx.entryMode === 'manual' || editingClinicFormularyRxId === selectedRx.id ? renderFormularyEditor() : (
                  <div className="rx-line-editor">
                    <div className="rx-line-editor__heading"><span><small>Curaleaf formulary result</small><strong>{selectedRx.items.length} prescribed product{selectedRx.items.length === 1 ? '' : 's'}</strong></span><span>Matched automatically · read-only</span></div>
                    {selectedRx.items.length === 0 ? <div className="rx-inline-empty"><FileScan size={20} /><span><strong>Medicines appear after the barcode scan</strong><small>Curaleaf supplies the formula, prescribed quantity and matching pack automatically. Open the basket drawer to see prices.</small></span></div> : (
                      <div className="rx-item-stack">
                        {selectedRx.items.map((item, index) => {
                          const product = state.catalogue.find(candidate => candidate.id === item.productId);
                          const stockLabel = product?.availability === 'out' ? 'Out of stock' : product?.availability === 'low' ? 'Low stock' : product?.availability === 'in' ? 'In stock' : 'Stock check required';
                          const stockPill = product?.availability === 'out' ? 'pill-red' : product?.availability === 'in' ? 'pill-green' : 'pill-amber';
                          return (
                            <article className="rx-prescribed-item" key={item.productId}>
                              <header className="rx-prescribed-item__header">
                                <span className="rx-prescribed-item__index">Medicine {String(index + 1).padStart(2, '0')}</span>
                                <span className="rx-prescribed-item__identity"><MedicineLabel name={item.name} /><small>Matched from the Curaleaf prescription · {item.qty} {item.qty === 1 ? 'pack' : 'packs'} · {item.unitsNeededCount ?? '—'} {product?.unit ?? 'units'}</small></span>
                                <span className={`pill ${stockPill}`}>{stockLabel}</span>
                              </header>
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </section>
            </main>

            <aside id="rx-guided-card-4" hidden={guidedLayout && guidedReveal < 4} className={`${guidedLayout ? 'rx-guided__payment' : 'rx-checkout-rail'}${guidedLayout && guidedReveal >= 4 ? ` rx-guided-reveal is-in${guidedStep === 4 ? ' is-current' : ''}` : ''}`}>
              <section className={`rx-checkout-panel card${guidedLayout ? ' rx-checkout-panel--guided' : ''}`} id="rx-order-review">
                <header>
                  <p className="section-label">Step 4 · Order {activeOrderRef}</p>
                  <strong>{paidRedo ? 'Review and carry over payment' : 'Review and request payment'}</strong>
                  <small>{patient?.name ?? 'Patient not linked'} · {activeOrder.prescriptions.length} prescription record{activeOrder.prescriptions.length === 1 ? '' : 's'}</small>
                </header>
                <dl className="rx-order-totals">
                  <div><dt>Prescription records</dt><dd>{activeOrder.prescriptions.length}</dd></div>
                  <div><dt>Wholesale total (excl VAT)</dt><dd>{wholesaleKnown ? money(orderCost(activeOrder)) : state.workspaceMode === 'training' ? 'Not supplied' : 'Quote required'}</dd></div>
                  <div><dt>Patient-price subtotal</dt><dd>{money(orderRevenue(activeOrder) - activeOrder.dispensingFee)}</dd></div>
                  <div><dt>Gross margin</dt><dd className={orderMargin === null ? '' : orderMargin >= 25 ? 'text-green' : 'text-amber'}>{orderMargin === null ? 'Pending' : `${money(orderRevenue(activeOrder) - orderCost(activeOrder))} · ${orderMargin}%`}</dd></div>
                </dl>
                <div className={`rx-checkout-readiness${quoteError ? ' has-error' : ''}`}>
                  <span className="section-label">{state.workspaceMode === 'training' ? 'Curaleaf test quote' : 'Live Curaleaf quote'}</span>
                  <span className={quoteAvailable ? 'complete' : ''}>{quoteAvailable ? <CheckCircle size={13} /> : quoteBusy ? <RefreshCw size={13} className="spin" /> : <span className="rx-readiness-dot" />}{quoteAvailable ? 'Wholesale and stock verified' : quoteBusy ? 'Updating automatically for this basket…' : quoteError ? 'Automatic quote needs attention' : quoteCurrent ? 'Pricing returned · stock unavailable' : currentQuoteItems.length ? 'Automatic quote waiting to refresh' : 'Add a medicine to generate a quote'}</span>
                  {quoteSummary && quoteCurrent ? <span className={quoteAvailable ? 'complete' : ''}>{quoteAvailable ? <CheckCircle size={13} /> : <span className="rx-readiness-dot" />} Shipping {money(quoteSummary.shippingPrice)} · tax {quoteSummary.taxRate}%</span> : null}
                  <small className="rx-auto-quote-note">Quotes refresh after a medicine or pack quantity changes.</small>
                  {quoteError ? <>
                    <ProviderStatusNotice title={quoteError.title} detail={quoteError.detail} />
                    <button type="button" className="btn btn-secondary btn-sm" disabled={quoteBusy || !currentQuoteItems.length} onClick={() => void refreshQuote()}><RefreshCw size={13} className={quoteBusy ? 'spin' : ''} /> {quoteBusy ? 'Retrying quote…' : 'Retry quote now'}</button>
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
                  <span>
                    <strong>Dispensing charge</strong>
                    {activeOrder.redoContext?.priceResolution === 'continue_as_fee' ? <small>Includes the patient-price drop so the original payment can be carried over.</small> : null}
                  </span>
                  <div className="rx-dispensing-presets" role="group" aria-label="Set dispensing charge">{[5, 10, 15].map(amount => <button type="button" key={amount} aria-pressed={activeOrder.dispensingFee === amount} disabled={activeOrder.redoContext?.priceResolution === 'continue_as_fee'} onClick={() => dispatch({ type: 'SET_ORDER_DISPENSING_FEE', orderId: activeOrder.id, amount })}>{money(amount)}</button>)}<button type="button" aria-pressed={activeOrder.dispensingFee === 0} disabled={activeOrder.redoContext?.priceResolution === 'continue_as_fee'} onClick={() => dispatch({ type: 'SET_ORDER_DISPENSING_FEE', orderId: activeOrder.id, amount: 0 })}>No charge</button></div>
                  <label className="rx-dispensing-custom"><span>Custom</span><span className="money-input"><span>£</span><input type="number" min="5" max={activeOrder.redoContext?.priceResolution === 'continue_as_fee' ? undefined : 15} step="0.01" value={activeOrder.dispensingFee || ''} disabled={activeOrder.redoContext?.priceResolution === 'continue_as_fee'} onFocus={event => event.currentTarget.select()} onChange={event => { const amount = Number(event.target.value); dispatch({ type: 'SET_ORDER_DISPENSING_FEE', orderId: activeOrder.id, amount: event.target.value === '' ? 0 : activeOrder.redoContext?.priceResolution === 'continue_as_fee' ? Math.max(0, amount) : Math.max(5, Math.min(15, amount)) }); }} aria-label="Custom dispensing charge" /></span></label>
                {activeOrder.redoContext?.isPaidRedo && redoSourceOrder ? (
                  <div className={`rx-redo-balance${paidRedoAmountMatches ? ' is-matched' : ' is-different'}`}>
                    <span><small>Verified payment carried by order {orderReference(redoSourceOrder)}</small><strong>{money(redoSourceOrder.payment.amount)}</strong></span>
                    <span><small>Replacement difference</small><strong>{paidRedoAmountDifference === 0 ? money(0) : `${paidRedoAmountDifference > 0 ? '+' : '−'}${money(Math.abs(paidRedoAmountDifference))}`}</strong></span>
                    <p>{paidRedoAmountMatches
                      ? 'Amounts match. The original verified payment may be carried over after authentication.'
                      : activeOrder.redoContext.priceResolution === 'absorb'
                        ? `The pharmacy will contribute ${money(paidRedoAmountDifference)}; the patient is not charged again.`
                        : activeOrder.redoContext.priceResolution === 'continue_as_fee'
                          ? `${money(Math.abs(paidRedoAmountDifference))} will be added to the dispensing fee so the original payment can be carried over.`
                          : paidRedoAmountDifference > 0
                            ? 'Absorb the increase or cancel this replacement.'
                            : 'Take the drop into the dispensing fee or cancel this replacement.'}</p>
                    {!paidRedoAmountMatches ? <div className="rx-redo-balance__choices">
                      {paidRedoAmountDifference > 0 ? <button type="button" className={`btn btn-sm ${activeOrder.redoContext.priceResolution === 'absorb' ? 'btn-primary' : 'btn-secondary'}`} onClick={chooseAbsorbDifference}><Banknote size={12} /> Absorb {money(paidRedoAmountDifference)}</button> : null}
                      {paidRedoAmountDifference < 0 ? <button type="button" className={`btn btn-sm ${activeOrder.redoContext.priceResolution === 'continue_as_fee' ? 'btn-primary' : 'btn-secondary'}`} onClick={chooseContinueAsFee}><Banknote size={12} /> Take {money(Math.abs(paidRedoAmountDifference))} into dispensing fee</button> : null}
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setConfirmingDraftDeleteId(activeOrder.id)}><X size={12} /> Cancel replacement</button>
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
                    <div className="rx-payment-route-toggle"><div className="is-selected"><ShieldCheck size={17} /><span><strong>Verified payment carry-over</strong><small>{activeOrder.redoContext?.priceResolution === 'absorb' ? 'Original payment retained · pharmacy pays difference' : activeOrder.redoContext?.priceResolution === 'continue_as_fee' ? 'Original payment retained · difference added to dispensing fee' : 'No second charge to the patient'}</small></span><CheckCircle size={14} /></div></div>
                  ) : (
                    <div className="rx-payment-route-toggle" role="radiogroup" aria-label="Pharmacy payment route">
                      <button type="button" role="radio" aria-checked={selectedPaymentRoute === 'worldpay'} disabled={!canUseWorldpay} className={selectedPaymentRoute === 'worldpay' ? 'is-selected' : ''} onClick={() => dispatch({ type: 'SET_ORDER_PAYMENT_ROUTE', orderId: activeOrder.id, paymentRoute: 'worldpay' })}><CreditCard size={17} /><span><strong>Worldpay</strong><small>{canUseWorldpay ? 'Fresh hosted checkout' : 'Not configured'}</small></span>{selectedPaymentRoute === 'worldpay' ? <CheckCircle size={14} /> : null}</button>
                      <button type="button" role="radio" aria-checked={selectedPaymentRoute === 'manual'} className={selectedPaymentRoute === 'manual' ? 'is-selected' : ''} onClick={() => dispatch({ type: 'SET_ORDER_PAYMENT_ROUTE', orderId: activeOrder.id, paymentRoute: 'manual' })}><Banknote size={17} /><span><strong>Manual payment</strong><small>EPOS, cash or transfer</small></span>{selectedPaymentRoute === 'manual' ? <CheckCircle size={14} /> : null}</button>
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
                  <button type="button" className="btn btn-primary rx-create-payment" disabled={checkoutBusy || !readyForPayment || (selectedPaymentRoute === 'worldpay' && !canUseWorldpay)} aria-describedby={!readyForPayment ? 'rx-checkout-lock-tip' : undefined} onClick={() => void createPaymentRequest()}><Send size={15} />{checkoutBusy ? 'Saving order…' : paidRedo ? 'Save replacement order' : selectedPaymentRoute === 'worldpay' ? 'send payment link' : 'Continue with manual payment'}</button>
                </footer>
                </div>
                </div>
                </div>
              </section>
            </aside>
          </div>

            {guidedLayout && guidedNextHint ? (
              <p className="rx-guided__next-hint" role="status">{guidedNextHint}</p>
            ) : null}
          </div>
        </div>
      )}
    </div>
    {guidedLayout && activeOrder && basketHost ? createPortal(
      <div className="rx-guided__chrome">
        {showReturnToTop ? (
          <button type="button" className="rx-guided__top" onClick={returnToTop}>
            <ChevronUp size={16} aria-hidden="true" />
            Return to top
          </button>
        ) : null}
        <aside className={`rx-basket-drawer${basketOpen ? ' is-open' : ''}`} aria-label="Draft medicines and cost">
          <button
            type="button"
            className="rx-basket-drawer__toggle"
            aria-expanded={basketOpen}
            aria-controls="rx-basket-drawer-panel"
            onClick={() => setBasketOpen(open => !open)}
          >
            <span>
              <small>Draft basket</small>
              <strong>
                {draftBasketCount} medicine{draftBasketCount === 1 ? '' : 's'} · {money(draftBasketTotal)}
                {draftBasketBlockedCount ? ` · ${draftBasketBlockedCount} need attention` : draftBasketWarningCount ? ` · ${draftBasketWarningCount} stock warning${draftBasketWarningCount === 1 ? '' : 's'}` : ''}
              </strong>
            </span>
            <span className="rx-basket-drawer__hint">{basketOpen ? 'Hide choices' : 'Show choices'}{basketOpen ? <ChevronDown size={16} /> : <ChevronUp size={16} />}</span>
          </button>
          <div hidden={!basketOpen} id="rx-basket-drawer-panel" className="rx-basket-drawer__panel">
            <div className="rx-basket-drawer__scroll">
              {draftBasketCount === 0 ? (
                <p className="rx-basket-drawer__empty">No medicines in this draft yet. Add them in step 3. Prices appear here.</p>
              ) : (
                <ul className="rx-basket-drawer__list">
                  {draftBasketItems.map((item, index) => {
                    const margin = lineMargin(item);
                    const issue = draftBasketIssues[index];
                    return (
                      <li key={`${item.rxId}-${item.productId}`} className={issue ? `is-${issue.tone}` : undefined}>
                        <span className="rx-basket-drawer__product">
                          <MedicineLabel name={item.name} />
                          <small>
                            {item.qty} {item.qty === 1 ? 'pack' : 'packs'} · {money(item.retail)} each
                            {issue ? <span className="rx-basket-drawer__issue"> · {issue.label}</span> : null}
                          </small>
                        </span>
                        <span className="rx-basket-drawer__line">
                          <strong>{money(lineRevenue(item))}</strong>
                          <small>{item.cost === null || margin === null ? 'Quote pending' : `${margin}% · ${money(lineCost(item))}`}</small>
                        </span>
                        {canEditBasketItems && item.rxId === selectedRx?.id ? (
                          <span className="rx-basket-drawer__edit">
                            <button type="button" className="icon-button" aria-label={`Reduce packs of ${item.name}`} disabled={item.qty <= 1} onClick={() => dispatch({ type: 'UPDATE_ITEM_QTY', orderId: activeOrder.id, rxId: item.rxId, productId: item.productId, qty: item.qty - 1 })}><Minus size={16} /></button>
                            <button type="button" className="icon-button" aria-label={`Add pack of ${item.name}`} disabled={item.qty >= 100} onClick={() => dispatch({ type: 'UPDATE_ITEM_QTY', orderId: activeOrder.id, rxId: item.rxId, productId: item.productId, qty: item.qty + 1 })}><Plus size={16} /></button>
                            <button type="button" className="icon-button danger" aria-label={`Remove ${item.name}`} onClick={() => dispatch({ type: 'REMOVE_ITEM_FROM_RX', orderId: activeOrder.id, rxId: item.rxId, productId: item.productId })}><Trash2 size={16} /></button>
                          </span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="rx-basket-drawer__footer">
              {draftBasketBlockedCount ? (
                <p className="rx-basket-drawer__alert" role="status">
                  <AlertTriangle size={14} aria-hidden="true" />
                  {draftBasketBlockedCount} medicine{draftBasketBlockedCount === 1 ? ' is' : 's are'} out of stock or unavailable. Payment stays locked until Curaleaf marks them available.
                </p>
              ) : null}
              <dl className="rx-basket-drawer__totals">
                <div>
                  <dt>Wholesale + delivery</dt>
                  <dd>{draftBasketWholesalePlusDelivery !== null ? money(draftBasketWholesalePlusDelivery) : state.workspaceMode === 'training' && !wholesaleKnown ? 'Not supplied' : 'Quote pending'}</dd>
                </div>
                <div>
                  <dt>Dispensing</dt>
                  <dd>{money(activeOrder.dispensingFee || 0)}</dd>
                </div>
                <div>
                  <dt>Patient Price Total</dt>
                  <dd>{money(draftBasketTotal)}</dd>
                </div>
              </dl>
            </div>
          </div>
        </aside>
      </div>,
      basketHost,
    ) : null}
    </>
  );
}
