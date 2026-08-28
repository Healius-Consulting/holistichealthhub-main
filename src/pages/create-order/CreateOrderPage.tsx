import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { prescriptionDateIsCurrent } from '@hhh/domain/prescription-date';
import { FileText, Search } from 'lucide-react';
import ProviderStatusNotice from '../../components/ProviderStatusNotice';
import DraftBasketSheet from './DraftBasketSheet';
import DraftSessionBar from './DraftSessionBar';
import OrderStepper from './OrderStepper';
import OrderSummaryRail from './OrderSummaryRail';
import ReplacementBanner from './ReplacementBanner';
import Step1PatientPanel from './Step1PatientPanel';
import Step2PrescriptionPanel from './Step2PrescriptionPanel';
import Step3FormularyPanel from './Step3FormularyPanel';
import Step4CheckoutPanel from './Step4CheckoutPanel';
import UnresolvedOrdersPanel from './UnresolvedOrdersPanel';
import { wizardNextHint, wizardStageTitle } from './computeWizardProgress';
import { useCreateOrderWizard } from './useCreateOrderWizard';
import { basketItemIssue, gmcNumber, patientInitials } from './utils';
import type { WizardStep } from './types';
import {
  useApp,
  money,
  orderRevenue,
  orderCost,
  getUnresolvedReason,
  orderReference,
  type LineItem,
  type PatientOrder,
  type UnresolvedOrderReason,
} from '../../context/AppContext';
import { TRAINING_PRESCRIBER, TRAINING_PRODUCT } from '../../training/workspace';
import { isLocalPortalPreview } from '../../dev/localPortalPreview';
import { checkPrescriptionSerialAvailability, createOrderDraft, createPortalOrder, createWorldpaySession, deleteOrderDraft, deletePrescriptionFile, getCuraleafQuote, getDevCuraleafQuote, isApiConfigured, scanCuraleafClinicPrescription, updateOrderDraft, uploadPrescriptionFile } from '../../shared/api';
import { formatPatientDob } from '../../utils/patientDob';
import { canCreateOrderForPatient } from '../../utils/patientOrderEligibility';
import { quoteMedicineTotalPence } from '../../utils/pricing';
import { MAX_PRESCRIPTION_FILE_BYTES, resolvePrescriptionContentType } from '../../utils/prescriptionFile';

function serialOccupancyFieldError(reason: string | null, inherited?: boolean) {
  if (reason === 'SERIAL_IN_USE') return 'This prescription serial is already on another live order.';
  if (reason === 'CURALEAF_SERIAL_STILL_LIVE') return 'Curaleaf still has a live prescription with this serial. Call Curaleaf to cancel it before creating this order.';
  if (reason === 'SERIAL_REUSE_EXPIRED' && !inherited) return 'This prescription cannot be reused. Enter a new serial.';
  if (reason === 'SERIAL_CHECK_FAILED') return 'This serial could not be checked. Try again.';
  return null;
}

export default function CreateOrderPage() {
  const { state, dispatch } = useApp();
  const organisationPatients = state.crm.filter(candidate => candidate.organisationId === state.currentOrganisationId);
  const orderablePatients = organisationPatients.filter(canCreateOrderForPatient);
  const organisation = state.organisations.find(org => org.id === state.currentOrganisationId) ?? state.organisations[0];
  const canUseWorldpay = organisation?.worldpay.status === 'connected';
  const worldpayStatusReady = Boolean(organisation?.worldpay.lastSyncedAt);
  const draftOrders = state.orders.filter(order => order.organisationId === state.currentOrganisationId && order.payment.status === 'none');
  const activeOrder = state.orders.find(order => order.organisationId === state.currentOrganisationId && order.id === state.activeOrderId && order.payment.status === 'none');
  const selectedPaymentRoute = activeOrder?.paymentRoute ?? (canUseWorldpay ? 'worldpay' : 'manual');
  const redoSourceOrder = activeOrder?.redoContext
    ? state.orders.find(order => order.organisationId === state.currentOrganisationId && order.id === activeOrder.redoContext!.originalOrderId) ?? null
    : null;
  const patient = activeOrder?.patientId ? organisationPatients.find(candidate => candidate.id === activeOrder.patientId) ?? null : null;
  const [selectedRxId, setSelectedRxId] = useState<number | null>(null);
  const [changingPatient, setChangingPatient] = useState(false);
  const [patientQuery, setPatientQuery] = useState('');
  const [patientSearchOpen, setPatientSearchOpen] = useState(true);
  const [patientActiveIndex, setPatientActiveIndex] = useState(0);
  const [confirmingDraftDeleteId, setConfirmingDraftDeleteId] = useState<number | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteError, setQuoteError] = useState<{ title: string; detail: string } | null>(null);
  const [quotedSignature, setQuotedSignature] = useState<string | null>(null);
  const [quoteSummary, setQuoteSummary] = useState<{ shippingPrice: number } | null>(null);
  const [latestQuote, setLatestQuote] = useState<import('../../shared/contracts').CuraleafQuote | null>(null);
  const [quoteCheckedAt, setQuoteCheckedAt] = useState<string | null>(null);
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
  const [confirmingRouteSwitch, setConfirmingRouteSwitch] = useState<'clinic' | 'manual' | null>(null);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);
  const [serialAvailability, setSerialAvailability] = useState<{ allowed: boolean; reason: string | null; pending: boolean }>({
    allowed: false,
    reason: null,
    pending: false,
  });
  const durableDraftEnabled = isApiConfigured && !isLocalPortalPreview && state.workspaceMode === 'live';
  const durableDraftPayload = useMemo(() => activeOrder ? {
    localOrderId: activeOrder.id,
    patientId: activeOrder.patientId,
    prescriptions: activeOrder.prescriptions,
    dispensingFeePence: Math.round(activeOrder.dispensingFee * 100),
    pharmacyDeliveryPence: Math.round(activeOrder.pharmacyDelivery * 100),
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
    // Wait until Worldpay status has been synced before demoting a draft off Worldpay.
    // Org reloads used to reset status to not-connected and this effect would wipe the route.
    if (!organisation?.worldpay.lastSyncedAt) return;
    if (activeOrder?.payment.status === 'none' && activeOrder.paymentRoute === 'worldpay' && !canUseWorldpay) {
      dispatch({ type: 'SET_ORDER_PAYMENT_ROUTE', orderId: activeOrder.id, paymentRoute: 'manual' });
    }
  }, [activeOrder?.id, activeOrder?.payment.status, activeOrder?.paymentRoute, canUseWorldpay, dispatch, organisation?.worldpay.lastSyncedAt]);

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
    setConfirmingFileRemoveRxId(null);
    setQuoteError(null);
    setQuotedSignature(null);
    setQuoteSummary(null);
    setLatestQuote(null);
    setQuoteCheckedAt(null);
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

  useEffect(() => {
    if (selectedRx?.entryMode === 'clinic') {
      setSerialAvailability({ allowed: Boolean(selectedRx.clinicScanId), reason: 'clinic', pending: false });
      return;
    }
    const serial = selectedRx?.serialNumber?.trim() ?? '';
    if (!selectedRx || !serial) {
      setSerialAvailability({ allowed: false, reason: null, pending: false });
      return;
    }
    if (isLocalPortalPreview || !isApiConfigured) {
      setSerialAvailability({ allowed: true, reason: 'ok', pending: false });
      return;
    }
    setSerialAvailability(current => ({ ...current, pending: true }));
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void checkPrescriptionSerialAvailability({
        organisationId: state.currentOrganisationId,
        serialNumber: serial,
        issueDate: selectedRx.issueDate,
        sourceOrderId: activeOrder?.redoContext?.originalBackendId ?? null,
        sourceSerial: selectedRx.serialInherited ? serial : null,
        patientId: activeOrder?.patientId ?? null,
      }).then(result => {
        if (!cancelled) setSerialAvailability({ allowed: result.allowed, reason: result.reason, pending: false });
      }).catch(() => {
        if (!cancelled) setSerialAvailability({ allowed: false, reason: 'SERIAL_CHECK_FAILED', pending: false });
      });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    activeOrder?.patientId,
    activeOrder?.redoContext?.originalBackendId,
    selectedRx?.clinicScanId,
    selectedRx?.entryMode,
    selectedRx?.issueDate,
    selectedRx?.serialInherited,
    selectedRx?.serialNumber,
    state.currentOrganisationId,
  ]);
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
  const prescriptionAuthenticated = readiness
    .filter(item => item.label !== 'Priced medicines and quantities complete')
    .every(item => item.complete)
    && (selectedRx?.entryMode !== 'manual' || (serialAvailability.allowed && !serialAvailability.pending));
  const prescriptionReady = readiness.every(item => item.complete);
  const wholesaleKnown = Boolean(activeOrder?.prescriptions.every(rx => rx.items.every(item => item.cost !== null)));
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
    || (activeOrder.dispensingFee >= 0 && activeOrder.dispensingFee <= 15);
  const quoteGateComplete = !requiresLiveCuraleafEvidence || quoteAvailable;
  const paidRedo = Boolean(activeOrder?.redoContext?.isPaidRedo);
  const paymentRouteReady = paidRedo || selectedPaymentRoute === 'manual' || canUseWorldpay;
  const paidRedoAmountDifference = activeOrder?.redoContext?.isPaidRedo && redoSourceOrder
    ? Math.round((orderRevenue(activeOrder) - redoSourceOrder.payment.amount) * 100) / 100
    : 0;
  const paidRedoAmountMatches = !activeOrder?.redoContext?.isPaidRedo || Math.abs(paidRedoAmountDifference) < 0.005;
  const redoPriceResolutionReady = paidRedoAmountMatches
    || activeOrder?.redoContext?.priceResolution === 'absorb';
  const readyForPayment = prescriptionReady && quoteGateComplete && paymentRouteReady && redoPriceResolutionReady && dispensingFeeValid;
  const paymentGate = activeOrder ? [
    ...readiness,
    { label: requiresLiveCuraleafEvidence ? 'Live Curaleaf price and stock quote verified' : 'Curaleaf quote optional in training', complete: quoteGateComplete },
    { label: 'Dispensing charge is £0–£15', complete: dispensingFeeValid },
    { label: paidRedo ? 'Original verified payment route retained' : selectedPaymentRoute === 'worldpay' ? 'Worldpay merchant connection verified' : 'Pharmacy-managed payment route selected', complete: paymentRouteReady },
    ...(activeOrder.redoContext?.isPaidRedo ? [{ label: 'Replacement price decision recorded', complete: redoPriceResolutionReady }] : []),
  ] : [];
  const outstandingPaymentGates = paymentGate.filter(item => !item.complete);
  const patientLinked = Boolean(patient);
  const patientReady = patientLinked && canCreateOrderForPatient(patient);
  const readyForProducts = selectedRx?.entryMode === 'clinic'
    ? Boolean(selectedRx.clinicScanId)
    : Boolean(
      selectedRx?.copyFileName
      && selectedRx.prescriber.trim()
      && selectedRx.serialNumber?.trim()
      && selectedRx.issueDate
      && selectedRx.prescriberPin?.trim()
      && prescriptionDateIsCurrent(selectedRx.issueDate, selectedRx.expiryDate)
      && serialAvailability.allowed
      && !serialAvailability.pending,
    );
  const draftBasketItems = activeOrder
    ? activeOrder.prescriptions.flatMap(rx => rx.items.map(item => ({ ...item, rxId: rx.id })))
    : [];
  const draftBasketCount = draftBasketItems.length;
  const draftBasketTotal = activeOrder ? orderRevenue(activeOrder) : 0;
  // Curaleaf's own tax on the pharmacy's purchase is a supplier-side figure and is
  // deliberately not surfaced to staff, so only wholesale and delivery come through.
  const draftBasketCosts = activeOrder && wholesaleKnown && quoteCurrent && quoteSummary
    ? { wholesale: orderCost(activeOrder), delivery: quoteSummary.shippingPrice }
    : null;
  const quotedMedicinePence = quotedSignature === currentQuoteSignature
    ? quoteMedicineTotalPence(latestQuote, draftBasketItems)
    : null;
  const quotedPatientTotals = quotedMedicinePence == null || !activeOrder
    ? null
    : {
      medicine: quotedMedicinePence / 100,
      total: quotedMedicinePence / 100 + activeOrder.dispensingFee + activeOrder.pharmacyDelivery,
    };
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

  const wizard = useCreateOrderWizard({
    activeOrderId: activeOrder?.id ?? null,
    selectedRxId,
    patientReady,
    prescriptionAuthenticated,
    prescriptionReady,
    readyForProducts,
    draftBasketCount,
    readyForPayment,
    selectedRx,
    isReplacement: Boolean(activeOrder?.redoContext),
  });

  const applyGuidedRoute = (mode: 'clinic' | 'manual') => {
    if (!activeOrder || !selectedRx) return;
    setEditingClinicFormularyRxId(null);
    dispatch({ type: 'SET_RX_ENTRY_MODE', orderId: activeOrder.id, rxId: selectedRx.id, mode });
    wizard.commitRouteChoice();
    setConfirmingRouteSwitch(null);
    wizard.setLockNotice(null);
  };

  const chooseGuidedRoute = (mode: 'clinic' | 'manual') => {
    if (!activeOrder || !selectedRx) return;
    setEditingClinicFormularyRxId(null);
    if (selectedRx.entryMode === mode) {
      wizard.commitRouteChoice();
      setConfirmingRouteSwitch(null);
      wizard.setLockNotice(null);
      return;
    }
    const hasWork = Boolean(
      selectedRx.clinicScanId
      || selectedRx.copyFileName
      || selectedRx.serialNumber?.trim()
      || selectedRx.items.length,
    );
    if (hasWork) {
      setConfirmingRouteSwitch(mode);
      return;
    }
    applyGuidedRoute(mode);
  };

  const stageTitle = wizardStageTitle({
    focusedStep: wizard.focusedStep,
    rxSubStep: wizard.progress.rxSubStep,
    entryMode: selectedRx?.entryMode,
    paidRedo,
  });
  const nextHint = wizardNextHint({
    progress: wizard.progress,
    patientLinked,
    patientEligible: canCreateOrderForPatient(patient),
    entryMode: selectedRx?.entryMode,
    readyForProducts,
    draftBasketCount,
  });

  const advanceStep = () => {
    const next = Math.min(wizard.focusedStep + 1, wizard.progress.furthestUnlocked) as WizardStep;
    if (next > wizard.focusedStep) wizard.goToStep(next);
  };

  const activeOrderRef = activeOrder ? orderReference(activeOrder) : '';

  const initials = patientInitials;
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
    setLatestQuote(null);
    setQuoteCheckedAt(null);
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
        const pricingQuote = latestQuote;
        const quoteItems = Array.isArray(pricingQuote?.items) ? pricingQuote.items : [];
        const lineItems = activeOrder.prescriptions.flatMap(rx => rx.items.map(item => {
          const quoted = quoteItems.find(entry => entry.packId === item.productId);
          const quotedPatientPence = quoted
            ? Math.round(Number(quoted.patientPackPrice) * 100)
            : 0;
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
            unitPricePence: quotedPatientPence > 0 ? quotedPatientPence : Math.round((item.retail || 0) * 100),
            wholesalePackPrice: quoted?.wholesalePackPrice,
            wholesalePackPricePence,
          };
        }));
        const dispensingFeePence = Math.round((activeOrder.dispensingFee || 0) * 100);
        const pharmacyDeliveryPence = Math.round((activeOrder.pharmacyDelivery || 0) * 100);
        const medicineTotalPence = quoteMedicineTotalPence(pricingQuote, draftBasketItems)
          ?? Math.max(0, Math.round(orderRevenue(activeOrder) * 100) - dispensingFeePence - pharmacyDeliveryPence);
        const totalPence = medicineTotalPence + dispensingFeePence + pharmacyDeliveryPence;
        const shippingPence = pricingQuote
          ? Math.round(Number(pricingQuote.shippingPrice || 0) * 100)
          : undefined;
        const wholesaleProductPence = lineItems.reduce((sum, item) => sum + (item.wholesalePackPricePence || 0) * item.quantity, 0);

        const persisted = activeOrder.backendId ? { id: activeOrder.backendId } : await createPortalOrder({
          organisationId: state.currentOrganisationId,
          draftId: activeOrder.draftId,
          patientId: activeOrder.patientId!,
          paymentRoute: selectedPaymentRoute,
          medicineTotalPence,
          dispensingFeePence,
          pharmacyDeliveryPence,
          totalPence,
          pricingQuote: pricingQuote ?? undefined,
          prePaymentQuote: pricingQuote && quoteCheckedAt ? {
            checkedAt: quoteCheckedAt,
            basketFingerprint: currentQuoteSignature,
            quote: pricingQuote,
          } : undefined,
          quoteSnapshot: pricingQuote ? {
            phase: 'PRE_PAYMENT',
            checkedAt: quoteCheckedAt,
            basketFingerprint: currentQuoteSignature,
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
              priceResolution: activeOrder.redoContext.priceResolution === 'absorb' ? 'absorb' : undefined,
            },
          } : {}),
        });
        if (!activeOrder.backendId) {
          dispatch({ type: 'SET_ORDER_BACKEND_ID', orderId: activeOrder.id, backendId: persisted.id, orderNumber: 'orderNumber' in persisted ? persisted.orderNumber : undefined });
          if ('lineItems' in persisted) dispatch({
            type: 'SYNC_ORDER_PATIENT_PRICES',
            orderId: activeOrder.id,
            items: quoteItems.length
              ? quoteItems.map(item => ({ productId: item.packId, patientPrice: Number(item.patientPackPrice) }))
              : persisted.lineItems.map(item => ({ productId: item.productId, patientPrice: item.unitPricePence / 100 })),
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
        : await getCuraleafQuote(state.currentOrganisationId, currentQuoteItems);
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
        setLatestQuote(null);
        setQuoteCheckedAt(null);
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
      setLatestQuote(quote);
      setQuoteCheckedAt(new Date().toISOString());
      setQuoteSummary({ shippingPrice: Number(quote.shippingPrice) || 0 });
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
      setLatestQuote(null);
      setQuoteCheckedAt(null);
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
    const shouldQuote = Boolean(
      automaticQuoteOrderId
      && hasCurrentQuoteItems
      && isApiConfigured
      && (prescriptionReady || (hasCurrentQuoteItems && !activeOrder?.redoContext)),
    );
    if (!shouldQuote) return;
    const timeoutId = window.setTimeout(() => {
      void automaticQuoteRef.current({ silent: true });
    }, 500);
    return () => window.clearTimeout(timeoutId);
  }, [activeOrder?.redoContext, automaticQuoteOrderId, currentQuoteSignature, hasCurrentQuoteItems, prescriptionReady, state.currentOrganisationId, state.workspaceMode]);

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
    // Linking is obvious from the panel itself; only the non-obvious reassignment needs a notice.
    if (replacingPatient) {
      dispatch({ type: 'ADD_TOAST', message: 'Draft reassigned. The prescription already entered was kept.', toastType: 'success' });
    }
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
    if (!activeOrder || Math.abs(paidRedoAmountDifference) < 0.005) return;
    dispatch({ type: 'SET_REDO_PRICE_RESOLUTION', orderId: activeOrder.id, resolution: 'absorb' });
    dispatch({ type: 'ADD_TOAST', message: `The pharmacy will absorb the ${money(Math.abs(paidRedoAmountDifference))} difference. The patient’s verified payment stays unchanged.`, toastType: 'info' });
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
        <div className="rx-patient-combobox" onBlur={event => { if (mode === 'link') return; if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPatientSearchOpen(false); }}>
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
          {patientSearchOpen || mode === 'link' ? (
            <div id={`rx-patient-results-${activeOrder.id}`} className={`rx-patient-results${mode === 'link' ? ' rx-patient-results--inline' : ''}`} role="listbox" aria-label="Matching approved patients">
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


  const rxDispatch = activeOrder && selectedRx ? {
    onPrescriberChange: (value: string) => dispatch({ type: 'SET_RX_PRESCRIBER', orderId: activeOrder.id, rxId: selectedRx.id, prescriber: value }),
    onMetadataChange: (field: string, value: string) => dispatch({ type: 'SET_RX_METADATA', orderId: activeOrder.id, rxId: selectedRx.id, updates: { [field]: value } }),
    onUnlockInheritedSerial: () => dispatch({
      type: 'SET_RX_METADATA',
      orderId: activeOrder.id,
      rxId: selectedRx.id,
      updates: { serialInherited: false, serialNumber: undefined, issueDate: undefined, expiryDate: undefined },
    }),
    onAddItem: (item: import('../../context/AppContext').LineItem) => dispatch({ type: 'ADD_ITEM_TO_RX', orderId: activeOrder.id, rxId: selectedRx.id, item }),
    onRemoveItem: (productId: string) => dispatch({ type: 'REMOVE_ITEM_FROM_RX', orderId: activeOrder.id, rxId: selectedRx.id, productId }),
    onUpdateQuantity: (productId: string, qty: number) => dispatch({ type: 'UPDATE_ITEM_QTY', orderId: activeOrder.id, rxId: selectedRx.id, productId, qty }),
    onUpdateUnits: (productId: string, unitsNeededCount: number) => dispatch({ type: 'UPDATE_ITEM_UNITS', orderId: activeOrder.id, rxId: selectedRx.id, productId, unitsNeededCount }),
  } : null;

  return (
    <div className="page-body rx-workbench rx-workbench--guided">
      {isLocalPortalPreview ? (
        <p className="rx-guided-preview-banner" role="status">
          Local training preview. Synthetic barcode and quotes stay on this machine.
        </p>
      ) : null}

      <DraftSessionBar
        draftOrders={draftOrders}
        activeOrderId={state.activeOrderId}
        organisationPatients={organisationPatients}
        confirmingDraftDeleteId={confirmingDraftDeleteId}
        onSelectDraft={orderId => dispatch({ type: 'SET_ACTIVE_ORDER', orderId })}
        onNewDraft={() => dispatch({ type: 'NEW_ORDER' })}
        onRequestDelete={setConfirmingDraftDeleteId}
        onConfirmDelete={orderId => void deleteDraft(orderId)}
        onCancelDelete={() => setConfirmingDraftDeleteId(null)}
        initials={initials}
      />

      {!activeOrder ? (
        <div className="empty-state">
          <FileText size={32} />
          <h3>No active prescription</h3>
          <p className="empty-desc">Start a prescription, link an approved patient and add the supplied prescription records.</p>
        </div>
      ) : (
        <div className="rx-create-layout">
          <div className="rx-create-layout__main">
            <OrderStepper progress={wizard.progress} focusedStep={wizard.focusedStep} onStepClick={wizard.goToStep} />

              <header className="rx-guided__stage-head">
              <p className="section-label">Step {wizard.focusedStep} of 4</p>
              <h2 key={wizard.focusedStep} ref={wizard.stageHeadingRef} tabIndex={-1}>{stageTitle}</h2>
              </header>

            {wizard.lockNotice ? <p className="rx-guided__lock-notice" role="status">{wizard.lockNotice}</p> : null}

            <div className="rx-create-step-live" aria-live="polite" aria-atomic="true">
              {wizard.focusedStep === 1 ? (
                <>
                  <Step1PatientPanel
                    patient={patient}
                    changingPatient={changingPatient}
                    patientLocked={wizard.progress.patientLocked}
                    patientSearch={renderPatientSearch(patient ? 'change' : 'link')}
                    onBeginPatientChange={beginPatientChange}
                    onRequestDeleteDraft={() => setConfirmingDraftDeleteId(activeOrder.id)}
                    initials={initials}
                  />
          {patient && !canCreateOrderForPatient(patient) ? (
            <ProviderStatusNotice title="This patient cannot start an order" detail="The linked patient is no longer approved or referred. Change the patient, or wait until their record is eligible again." />
          ) : null}
                </>
          ) : null}

              {activeOrder.redoContext && patient ? (
                <ReplacementBanner
                  activeOrder={activeOrder}
                  activeOrderRef={activeOrderRef}
                  redoSourceOrder={redoSourceOrder}
                  medicineCount={activeOrder.prescriptions.flatMap(rx => rx.items).length}
                />
              ) : patient && !activeOrder.redoContext && unresolvedOrdersForPatient.length > 0 ? (
                <UnresolvedOrdersPanel
                  entries={unresolvedOrdersForPatient}
                  selectedOrderId={selectedUnresolvedOrderId}
                  onSelect={setSelectedUnresolvedOrderId}
                  onApply={handleRedoPrescription}
                />
                        ) : null}

              {wizard.focusedStep === 2 && selectedRx && rxDispatch ? (
                <Step2PrescriptionPanel
                  selectedRx={selectedRx}
                  rxSubStep={wizard.progress.rxSubStep}
                  routeChosen={wizard.progress.routeChosen}
                  isLocalPreview={isLocalPortalPreview}
                  workspaceMode={state.workspaceMode}
                  catalogue={state.catalogue}
                  scanError={scanError}
                  uploadingRxId={uploadingRxId}
                  readingRxId={readingRxId}
                  fileRemovalBusyRxId={fileRemovalBusyRxId}
                  confirmingFileRemoveRxId={confirmingFileRemoveRxId}
                  confirmingRouteSwitch={confirmingRouteSwitch}
                  onChooseRoute={chooseGuidedRoute}
                  onApplyRouteSwitch={applyGuidedRoute}
                  onCancelRouteSwitch={() => setConfirmingRouteSwitch(null)}
                  onAttachFile={file => void attachPrescriptionFile(selectedRx.id, file)}
                  onSyntheticScan={() => applySyntheticClinicScan(selectedRx.id)}
                  onRetryBarcode={() => void readClinicBarcode(selectedRx.id, selectedRx.fileId!)}
                  onRequestRemoveFile={() => setConfirmingFileRemoveRxId(selectedRx.id)}
                  onConfirmRemoveFile={() => void removePrescriptionFile(selectedRx.id)}
                  onCancelRemoveFile={() => setConfirmingFileRemoveRxId(null)}
                  serialFieldError={serialAvailability.pending ? null : serialOccupancyFieldError(serialAvailability.reason, selectedRx.serialInherited)}
                  {...rxDispatch}
                />
                  ) : null}

              {wizard.focusedStep === 3 && selectedRx && rxDispatch ? (
                <Step3FormularyPanel
                  selectedRx={selectedRx}
                            catalogue={state.catalogue}
                  catalogueLoading={state.catalogueLoading}
                  catalogueError={state.catalogueError}
                  onRetryCatalogue={() => dispatch({ type: 'REQUEST_CATALOGUE_REFRESH' })}
                  editingClinicFormulary={editingClinicFormularyRxId === selectedRx?.id}
                  onToggleEditFormulary={() => setEditingClinicFormularyRxId(selectedRx?.id ?? null)}
                  onSaveFormulary={() => setEditingClinicFormularyRxId(null)}
                  {...rxDispatch}
                />
                  ) : null}

              {wizard.focusedStep === 4 ? (
                <Step4CheckoutPanel
                  activeOrder={activeOrder}
                  activeOrderRef={activeOrderRef}
                  redoSourceOrder={redoSourceOrder}
                  paidRedo={paidRedo}
                  paidRedoAmountMatches={paidRedoAmountMatches}
                  paidRedoAmountDifference={paidRedoAmountDifference}
                  wholesaleKnown={wholesaleKnown}
                  pharmacyDeliveryCurrentlyEnabled={organisation.pharmacyDeliveryEnabled}
                  workspaceMode={state.workspaceMode}
                  quoteAvailable={quoteAvailable}
                  quoteBusy={quoteBusy}
                  quoteCurrent={quoteCurrent}
                  quoteError={quoteError}
                  quoteCheckedAt={quoteCheckedAt}
                  quoteSummary={quoteSummary}
                  quotedPatientTotals={quotedPatientTotals}
                  currentQuoteItemsCount={currentQuoteItems.length}
                  draftBasketBlockedCount={draftBasketBlockedCount}
                  draftBasketWarningCount={draftBasketWarningCount}
                  selectedPaymentRoute={selectedPaymentRoute}
                  canUseWorldpay={canUseWorldpay}
                  worldpayStatusReady={worldpayStatusReady}
                  readyForPayment={readyForPayment}
                  outstandingPaymentGates={outstandingPaymentGates}
                  checkoutBusy={checkoutBusy}
                  onRefreshQuote={() => void refreshQuote()}
                  onSetDispensingFee={amount => dispatch({ type: 'SET_ORDER_DISPENSING_FEE', orderId: activeOrder.id, amount })}
                  onSetPharmacyDelivery={amount => dispatch({ type: 'SET_ORDER_PHARMACY_DELIVERY', orderId: activeOrder.id, amount })}
                  onChooseAbsorbDifference={chooseAbsorbDifference}
                  onCancelReplacement={() => setConfirmingDraftDeleteId(activeOrder.id)}
                  onSetPaymentRoute={paymentRoute => dispatch({ type: 'SET_ORDER_PAYMENT_ROUTE', orderId: activeOrder.id, paymentRoute })}
                  onSubmit={() => void createPaymentRequest()}
                />
                    ) : null}
                  </div>

            {nextHint ? <p className="rx-guided__next-hint" role="status">{nextHint}</p> : null}
                    </div>

          <OrderSummaryRail
            progress={wizard.progress}
            patient={patient}
            focusedStep={wizard.focusedStep}
            draftBasketCount={draftBasketCount}
            quotedPatientTotals={quotedPatientTotals}
            draftBasketCosts={draftBasketCosts}
            dispensingFee={activeOrder.dispensingFee}
            pharmacyDelivery={activeOrder.pharmacyDelivery}
            draftBasketItems={draftBasketItems}
            draftBasketIssues={draftBasketIssues}
            draftBasketBlockedCount={draftBasketBlockedCount}
            canEditBasketItems={canEditBasketItems}
            selectedRxId={selectedRx?.id ?? null}
            onStepClick={wizard.goToStep}
            onContinue={advanceStep}
            continueDisabled={wizard.focusedStep >= wizard.progress.furthestUnlocked}
            onEditQuantity={(rxId, productId, qty) => dispatch({ type: 'UPDATE_ITEM_QTY', orderId: activeOrder.id, rxId, productId, qty })}
            onRemoveItem={(rxId, productId) => dispatch({ type: 'REMOVE_ITEM_FROM_RX', orderId: activeOrder.id, rxId, productId })}
          />
                    </div>
                  )}

      {activeOrder ? (
        <DraftBasketSheet
          open={mobileSheetOpen}
          onToggle={() => setMobileSheetOpen(open => !open)}
          progress={wizard.progress}
          draftBasketCount={draftBasketCount}
          draftBasketTotal={quotedPatientTotals?.total ?? draftBasketTotal}
          draftBasketBlockedCount={draftBasketBlockedCount}
          draftBasketWarningCount={draftBasketWarningCount}
        />
            ) : null}
          </div>
  );
}
