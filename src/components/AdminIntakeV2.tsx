import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Building2, CheckCircle2, ClipboardList, Copy, Globe, Inbox, LoaderCircle, QrCode, RefreshCw, Search, Send, Stethoscope, User, UserX, type LucideIcon } from 'lucide-react';
import { DECLINE_REASONS, decideV2ProgrammeOnboarding, getAdminGeneralIntake, getAdminIntakeDetail, getAdminPharmacyReferralIntake, getAssignmentCandidates, reassignIntake, updateIntakeFollowUp, withdrawV2Intake, type DeclineReason, type PatientAgreementChannel } from '../shared/api';
import { HOLISTIC_HEALTH_HUB_ALLOCATION_LABEL, workspaceClassificationLabel, type DuplicateRecordMatch, type V2EligibilityQueueItem } from '../shared/contracts';
import { isLocalPortalPreview } from '../dev/localPortalPreview';
import { useApp } from '../context/AppContext';
import { CopyButton, CopyFact, Fact, RecordCard, RecordSectionNav, useRecordSections } from './admin/RecordParts';
import { onboardingStatusLabel, onboardingStatusPillClass } from '../utils/onboardingStatus';
import { compactPatientName } from '../utils/patientName';
import { formatPatientDob } from '../utils/patientDob';
import { formatUkDate, formatUkDateTime } from '../utils/ukDates';

type Detail = Record<string, unknown>;
type ReviewStatus = 'not_started' | 'due' | 'attempted' | 'in_progress' | 'completed' | 'unable_to_contact';
type QueueFilter = 'all' | 'website' | 'qr';
type IntakeSection = 'patient' | 'eligibility' | 'pharmacy' | 'review' | 'referral';
type ReferralOutcome = 'complete' | 'declined' | 'rejected';

/** The open enquiry is one page; these are its sections, in order. */
const INTAKE_SECTIONS: { id: IntakeSection; label: string }[] = [
  { id: 'patient', label: 'Patient' },
  { id: 'eligibility', label: 'Eligibility' },
  { id: 'pharmacy', label: 'Pharmacy' },
  { id: 'review', label: 'Review' },
  { id: 'referral', label: 'Referral' },
];
const assignmentReasons = ['patient_preference', 'capacity', 'delivery_or_collection', 'geographic_coverage', 'service_compatibility', 'administrative_correction'] as const;
const words = (value: unknown) => String(value ?? '').replaceAll('_', ' ');
const dateTime = (value: unknown) => formatUkDateTime(value == null ? null : String(value), 'Not recorded');
const shortDate = (value: unknown) => formatUkDate(value == null ? null : String(value));
const sameId = (left: string, right: string) => left.replaceAll('-', '').toLowerCase() === right.replaceAll('-', '').toLowerCase();
const isWebsite = (record: V2EligibilityQueueItem) => record.sourceType === 'general_hhh_website';

const REVIEW_META: Record<string, { label: string; tone: string }> = {
  not_started: { label: 'Not started', tone: 'neutral' },
  due: { label: 'Follow-up due', tone: 'warning' },
  attempted: { label: 'Contact attempted', tone: 'warning' },
  in_progress: { label: 'In progress', tone: 'curaleaf-review' },
  completed: { label: 'Review complete', tone: 'paid' },
  unable_to_contact: { label: 'Unable to contact', tone: 'danger' },
};

const previewGeneral: V2EligibilityQueueItem = {
  id: 'preview-general', caseReference: 'HHH-PREVIEW-001', patientDisplayName: 'Avery Morgan',
  submittedAt: '2026-08-16T08:40:00.000Z', displayStatus: 'Awaiting HHH referral',
  assignmentStatus: 'awaiting_hhh_allocation', pharmacyReviewStatus: 'not_opened', outcomeStatus: 'open',
  version: 2, legacy: false, sourceType: 'general_hhh_website', assignedOrganisationId: null,
  postcode: 'SW1A 1AA', followUpStatus: 'in_progress', nextFollowUpAt: null, destinationLocked: false,
  duplicateOf: [
    { kind: 'patient', id: 'preview-patient', organisationId: 'preview-pharmacy', organisationName: 'Primary Branch', stage: 'HHH approved', name: 'Avery Morgan', email: 'preview.patient@example.test', date: '2026-08-10T09:00:00.000Z', matchedOn: 'email' },
    { kind: 'application', id: 'preview-withdrawn', organisationId: 'preview-pharmacy', organisationName: 'Primary Branch', stage: 'Withdrawn', name: 'Avery Morgan', email: 'preview.patient@example.test', date: '2026-08-12T09:00:00.000Z', matchedOn: 'email' },
  ],
};
const previewDedicated: V2EligibilityQueueItem = {
  id: 'preview-dedicated', caseReference: 'HHH-PREVIEW-002', patientDisplayName: 'Jordan Taylor',
  submittedAt: '2026-08-16T09:15:00.000Z', displayStatus: 'Awaiting HHH referral',
  assignmentStatus: 'provisional', pharmacyReviewStatus: 'not_opened', outcomeStatus: 'open',
  version: 3, legacy: false, sourceType: 'future_pharmacy_qr', sourceOrganisationId: 'preview-pharmacy',
  assignedOrganisationId: 'preview-pharmacy', postcode: 'NG16 3AA', followUpStatus: 'in_progress',
  nextFollowUpAt: null, destinationLocked: false,
};
const previewCandidates: Detail[] = [
  { id: 'preview-pharmacy', name: 'Primary Branch', gphcNumber: 'TRAINING-PRIMARY', address: '12 Park Row, Leeds', postcode: 'LS1 5HD', phone: '0113 000 0000', email: 'primary@example.test' },
  { id: 'preview-pharmacy-2', name: 'Alternate Pharmacy', gphcNumber: 'TRAINING-ALTERNATE', address: '4 King Street, Manchester', postcode: 'M2 4LQ', phone: '0161 000 0000', email: 'alternate@example.test' },
];

function previewDetail(record: V2EligibilityQueueItem): Detail {
  const dedicated = record.sourceType !== 'general_hhh_website';
  return {
    ...record,
    assignmentVersion: record.version,
    pharmacyAccessStatus: 'withheld',
    destinationLocked: false,
    sourceOrganisationName: dedicated ? 'Primary Branch' : null,
    assignedOrganisationName: dedicated ? 'Primary Branch' : null,
    effectiveAssignedOrganisationId: record.assignedOrganisationId,
    dob: '1991-04-12', email: 'preview.patient@example.test', mobile: '07000 000 000',
    conditions: ['chronic_pain', 'sleep_disorders'], primaryCondition: 'chronic_pain',
    triedTwoTreatments: true, psychosisExclusion: false,
    referralConsent: true, dataSharingConsent: true,
  };
}

const REVIEW_OPTIONS: Array<{ id: ReviewStatus; hint: string }> = [
  { id: 'not_started', hint: 'Nobody has contacted them yet.' },
  { id: 'due', hint: 'A call or email is due.' },
  { id: 'attempted', hint: 'Tried to reach them, no reply yet.' },
  { id: 'in_progress', hint: 'Talking to them now.' },
  { id: 'completed', hint: 'Checks done. Unlocks Referral.' },
  { id: 'unable_to_contact', hint: 'Tried and could not reach them.' },
];

function postcodeArea(value: unknown) {
  const match = /^\s*([a-z]{1,2})\d/i.exec(String(value ?? ''));
  return match ? match[1]!.toUpperCase() : null;
}

const isOpenStage = (stage: string) => stage === 'New' || stage === 'Under HHH review';

function duplicateMatches(value: unknown): DuplicateRecordMatch[] {
  return Array.isArray(value) ? value as DuplicateRecordMatch[] : [];
}

function reviewMeta(status: unknown) {
  const key = String(status || 'not_started').toLowerCase();
  return REVIEW_META[key] ?? { label: words(key), tone: 'neutral' };
}

interface AdminIntakeV2Props {
  /** Opens a record that lives outside the intake queue — a patient row or a closed application — in the register. */
  onOpenRecord?: (match: DuplicateRecordMatch) => void;
  /** Where the page header shows this page's headline figures. */
  summarySlot?: HTMLElement | null;
}

export default function AdminIntakeV2({ onOpenRecord, summarySlot = null }: AdminIntakeV2Props = {}) {
  const { state: appState } = useApp();
  const [general, setGeneral] = useState<V2EligibilityQueueItem[]>([]);
  const [referrals, setReferrals] = useState<V2EligibilityQueueItem[]>([]);
  const [selected, setSelected] = useState<V2EligibilityQueueItem | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [candidates, setCandidates] = useState<Detail[]>([]);
  const [candidateQuery, setCandidateQuery] = useState('');
  const [destination, setDestination] = useState('');
  const [reason, setReason] = useState<(typeof assignmentReasons)[number]>('patient_preference');
  const [allocationNote, setAllocationNote] = useState('');
  // Moving an enquiry away from the pharmacy it is already with needs the patient's
  // agreement on record (Terms 5.2); the server refuses the move without it.
  const [agreementChannel, setAgreementChannel] = useState<PatientAgreementChannel | ''>('');
  const [onboardingNote, setOnboardingNote] = useState('');
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawNote, setWithdrawNote] = useState('');
  const [declineReason, setDeclineReason] = useState<DeclineReason | ''>('');
  const [existingClinicAccount, setExistingClinicAccount] = useState(false);
  const [referralOutcome, setReferralOutcome] = useState<ReferralOutcome>('complete');
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus>('not_started');
  const [queueQuery, setQueueQuery] = useState('');
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('all');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const listRowsRef = useRef<HTMLDivElement>(null);
  const [listOverflow, setListOverflow] = useState({ top: false, bottom: false });

  const recordReady = Boolean(selected && detail && !detailLoading);
  const { activeSection, goToSection, reset: resetSections } = useRecordSections(INTAKE_SECTIONS, {
    prefix: 'intake-section',
    navSelector: '.admin-intake-nav',
    enabled: recordReady,
    resetKey: selected?.id,
  });

  const load = useCallback(async () => {
    setLoading(true);
    if (isLocalPortalPreview) {
      setGeneral([previewGeneral]);
      setReferrals([previewDedicated]);
      setLoading(false);
      return;
    }
    try {
      const [generalResult, referralResult] = await Promise.all([getAdminGeneralIntake(), getAdminPharmacyReferralIntake()]);
      setGeneral(generalResult.records);
      setReferrals(referralResult.records);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'The HHH intake queue could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const applyDetail = (next: Detail) => {
    const currentReason = String(next.assignmentReason ?? 'patient_preference');
    setDetail(next);
    setDestination(String(next.effectiveAssignedOrganisationId ?? ''));
    setReason(assignmentReasons.includes(currentReason as (typeof assignmentReasons)[number])
      ? currentReason as (typeof assignmentReasons)[number]
      : 'patient_preference');
    setReviewStatus(String(next.followUpStatus ?? 'not_started').toLowerCase() as ReviewStatus);
    setDeclineReason('');
    setReferralOutcome('complete');
  };

  const open = async (record: V2EligibilityQueueItem) => {
    setSelected(record);
    setDetail(null);
    setDetailLoading(true);
    setCandidateQuery('');
    setAllocationNote('');
    setOnboardingNote('');
    setWithdrawOpen(false);
    setWithdrawNote('');
    setExistingClinicAccount(false);
    setReferralOutcome('complete');
    resetSections();
    setMessage('');
    try {
      if (isLocalPortalPreview) {
        applyDetail(previewDetail(record));
        setCandidates(previewCandidates);
      } else {
        const [next, candidateResult] = await Promise.all([
          getAdminIntakeDetail(record.id),
          getAssignmentCandidates(record.id),
        ]);
        applyDetail(next);
        setCandidates(candidateResult.records);
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'The protected intake record could not be loaded.');
    } finally {
      setDetailLoading(false);
    }
  };

  // A duplicate still in the queue is opened in place; anything else lives in the register.
  const openDuplicate = (match: DuplicateRecordMatch) => {
    if (match.kind === 'application' && isOpenStage(match.stage)) {
      const record = [...general, ...referrals].find(item => sameId(item.id, match.id));
      if (record) { void open(record); return; }
      setMessage('That application is not in the loaded queue. Refresh the queue and try again.');
      return;
    }
    onOpenRecord?.(match);
  };

  const refreshDetail = async () => {
    if (!selected || isLocalPortalPreview) return detail;
    const next = await getAdminIntakeDetail(selected.id);
    applyDetail(next);
    return next;
  };

  const saveDestination = async () => {
    if (!selected || !detail || !destination) return;
    setBusy(true);
    setMessage('');
    try {
      if (!isLocalPortalPreview) {
        await reassignIntake(selected.id, {
          destinationOrganisationId: destination,
          reasonCode: reason,
          note: allocationNote.trim() || null,
          expectedVersion: Number(detail.assignmentVersion ?? selected.version),
          patientAgreementChannel: agreementChannel || null,
        });
        await Promise.all([refreshDetail(), load()]);
      } else {
        applyDetail({ ...detail, effectiveAssignedOrganisationId: destination, assignedOrganisationId: destination, assignedOrganisationName: candidates.find(candidate => candidate.id === destination)?.name, assignmentVersion: Number(detail.assignmentVersion ?? 0) + 1 });
      }
      setAllocationNote('');
      setAgreementChannel('');
      goToSection(reviewComplete ? 'referral' : 'review');
      setMessage('Pending destination updated. The previous pharmacy can no longer see this enquiry; it now appears for the new pharmacy.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'The pending destination could not be changed.');
    } finally {
      setBusy(false);
    }
  };

  const saveReview = async () => {
    if (!selected || !detail) return;
    setBusy(true);
    setMessage('');
    try {
      if (!isLocalPortalPreview) {
        await updateIntakeFollowUp(selected.id, {
          expectedVersion: Number(detail.assignmentVersion ?? selected.version),
          followUpStatus: reviewStatus,
        });
        await refreshDetail();
      } else {
        applyDetail({ ...detail, followUpStatus: reviewStatus, assignmentVersion: Number(detail.assignmentVersion ?? 0) + 1 });
      }
      if (reviewStatus === 'completed') goToSection('referral');
      setMessage('HHH review status saved.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'The HHH review status could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const decideOnboarding = async (decision: 'approved' | 'declined') => {
    if (!selected || !detail) return;
    if (decision === 'declined' && !declineReason) {
      setMessage('Choose a reason before declining. It is never shown to the patient, but it decides which email they receive.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      if (!isLocalPortalPreview) {
        await decideV2ProgrammeOnboarding(selected.id, {
          expectedVersion: Number(detail.assignmentVersion ?? selected.version),
          decision,
          notes: onboardingNote.trim() || null,
          ...(decision === 'declined' ? { reason: declineReason as DeclineReason } : {}),
          ...(decision === 'approved' && existingClinicAccount ? { existingClinicAccount: true } : {}),
        });
        setSelected(null);
        setDetail(null);
        await load();
      }
      setMessage(decision === 'approved'
        ? existingClinicAccount
          ? 'Referral completed for an existing Curaleaf Clinic account. The pharmacy still sees them as referred, and the existing-account email has been sent.'
          : 'Referral completed. The patient record is now visible only to the currently assigned pharmacy.'
        : 'Application declined and removed from the active intake queue. The patient has been emailed.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'The onboarding decision could not be recorded.');
    } finally {
      setBusy(false);
    }
  };

  const recordWithdrawal = async () => {
    if (!selected || !detail) return;
    setBusy(true);
    setMessage('');
    try {
      if (!isLocalPortalPreview) {
        await withdrawV2Intake(selected.id, {
          expectedVersion: Number(detail.assignmentVersion ?? selected.version),
          notes: withdrawNote.trim() || null,
        });
        setSelected(null);
        setDetail(null);
        await load();
      }
      setWithdrawOpen(false);
      setWithdrawNote('');
      setMessage('Withdrawal recorded and removed from the active intake queue. The patient has been emailed.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'The withdrawal could not be recorded.');
    } finally {
      setBusy(false);
    }
  };

  const allRecords = useMemo(() => [...general, ...referrals]
    .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt)), [general, referrals]);
  const sourceRecords = useMemo(() => {
    if (queueFilter === 'website') return allRecords.filter(isWebsite);
    if (queueFilter === 'qr') return allRecords.filter(record => !isWebsite(record));
    return allRecords;
  }, [allRecords, queueFilter]);
  const filteredRecords = useMemo(() => {
    const query = queueQuery.trim().toLowerCase();
    return !query ? sourceRecords : sourceRecords.filter(record => `${record.patientDisplayName} ${record.caseReference} ${record.postcode ?? ''}`.toLowerCase().includes(query));
  }, [sourceRecords, queueQuery]);
  const websiteRows = filteredRecords.filter(isWebsite);
  const qrRows = filteredRecords.filter(record => !isWebsite(record));
  const inProgressCount = allRecords.filter(record => ['due', 'attempted', 'in_progress'].includes(String(record.followUpStatus || ''))).length;

  const syncListOverflow = useCallback(() => {
    const el = listRowsRef.current;
    if (!el) {
      setListOverflow({ top: false, bottom: false });
      return;
    }
    const top = el.scrollTop > 6;
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 6;
    setListOverflow(current => current.top === top && current.bottom === bottom ? current : { top, bottom });
  }, []);

  useEffect(() => {
    const el = listRowsRef.current;
    syncListOverflow();
    if (!el) return;
    el.addEventListener('scroll', syncListOverflow, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncListOverflow);
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', syncListOverflow);
      observer?.disconnect();
    };
  }, [syncListOverflow, filteredRecords.length, queueFilter, loading]);

  const currentDestinationId = String(detail?.effectiveAssignedOrganisationId ?? '');
  const screeningFlag = String(detail?.screeningFlag ?? '') || null;
  const duplicates = duplicateMatches(detail?.duplicateOf ?? selected?.duplicateOf);
  // Mirrors the server's rule: agreement is needed only when a pharmacy already holds the enquiry.
  const movingFromPharmacy = Boolean(detail?.assignedOrganisationId);
  const destinationSaved = Boolean(currentDestinationId) && sameId(destination, currentDestinationId);
  // Whether the enquiry is already saved with a pharmacy, regardless of an unsaved pick.
  const hasDestination = Boolean(currentDestinationId);
  const reviewComplete = detail?.followUpStatus === 'completed';
  const sourceName = String(detail?.sourceOrganisationName ?? (detail?.sourceType === 'general_hhh_website' ? 'Main HHH website' : 'Original QR pharmacy'));
  const destinationName = String(detail?.assignedOrganisationName ?? candidates.find(candidate => candidate.id === currentDestinationId)?.name ?? 'Not assigned');
  const selectedReview = reviewMeta(selected?.followUpStatus);
  const destinationPharmacy = useMemo(() => {
    if (!currentDestinationId) return null;
    const organisation = appState.organisations.find(item => sameId(item.id, currentDestinationId));
    const candidate = candidates.find(item => sameId(String(item.id), currentDestinationId));
    const text = (...values: unknown[]) => values.map(value => (value == null ? '' : String(value).trim())).find(Boolean) || null;
    return {
      name: text(organisation?.name, candidate?.name, detail?.assignedOrganisationName) ?? 'Pharmacy',
      gphc: text(organisation?.gphcNumber, candidate?.gphcNumber),
      postcode: text(organisation?.postcode, candidate?.postcode),
      phone: text(organisation?.pharmacyPhone, organisation?.mainContactPhone, candidate?.phone),
      email: text(organisation?.pharmacyEmail, organisation?.mainContactEmail, candidate?.email),
    };
  }, [appState.organisations, candidates, currentDestinationId, detail?.assignedOrganisationName]);
  const pickedCandidate = candidates.find(candidate => sameId(String(candidate.id), destination));
  const pickedName = pickedCandidate ? String(pickedCandidate.name) : 'the chosen pharmacy';
  // Postcode area is the letters before the first digit (LS1 5HD → LS).
  const patientArea = postcodeArea(detail?.postcode ?? selected?.postcode);
  const candidateRows = useMemo(() => {
    const query = candidateQuery.trim().toLowerCase();
    const rows = candidates.map(candidate => {
      const id = String(candidate.id);
      const organisation = appState.organisations.find(item => sameId(item.id, id));
      const postcode = String(organisation?.postcode ?? candidate.postcode ?? '').trim() || null;
      const classification = String(candidate.workspaceClassification ?? '');
      return {
        id,
        name: String(candidate.name ?? organisation?.name ?? 'Pharmacy'),
        gphc: String(candidate.gphcNumber ?? organisation?.gphcNumber ?? '').trim() || null,
        postcode,
        address: String(candidate.address ?? organisation?.address ?? ''),
        current: Boolean(currentDestinationId) && sameId(id, currentDestinationId),
        sameArea: Boolean(patientArea) && postcodeArea(postcode) === patientArea,
        kind: classification === 'allocation_holding' || classification === 'training' ? workspaceClassificationLabel(classification) : null,
      };
    });
    return rows
      .filter(row => !query || `${row.name} ${row.gphc ?? ''} ${row.postcode ?? ''} ${row.address}`.toLowerCase().includes(query))
      .sort((left, right) => Number(right.current) - Number(left.current) || Number(right.sameArea) - Number(left.sameArea) || left.name.localeCompare(right.name));
  }, [appState.organisations, candidateQuery, candidates, currentDestinationId, patientArea]);
  const canRefer = reviewComplete && destinationSaved;
  const queueLabel = queueFilter === 'website' ? 'Website' : queueFilter === 'qr' ? 'QR links' : 'Intake queue';
  const chooseOutcome = (outcome: ReferralOutcome) => {
    setReferralOutcome(outcome);
    if (outcome === 'complete' || declineReason) return;
    const flag = String(detail?.screeningFlag ?? '');
    if (flag === 'TREATMENTS_NOT_TRIED') setDeclineReason('ELIGIBILITY_NOT_MET');
    if (flag === 'PSYCHOSIS_HISTORY') setDeclineReason('PSYCHIATRIC_EXCLUSION');
  };

  return (
    <div className="page-body order-crm patient-crm admin-intake-crm">
      {summarySlot ? createPortal(
      <section className="order-crm-summary" aria-label="HHH intake summary">
        <div className="order-crm-summary__tiles">
          <SummaryMetric label="Open" value={String(allRecords.length)} detail="Enquiries awaiting HHH referral" icon={Inbox} tone="primary" />
          <SummaryMetric label="Website" value={String(general.length)} detail="Main HHH site forms" icon={Globe} tone="primary" />
          <SummaryMetric label="QR links" value={String(referrals.length)} detail="Pharmacy dedicated links" icon={QrCode} tone="primary" />
          <SummaryMetric label="In review" value={String(inProgressCount)} detail="Follow-up due or in progress" icon={ClipboardList} tone="warning" />
        </div>
      </section>,
        summarySlot,
      ) : null}

      <section className="order-crm-controls admin-filter-bar">
        <div className="order-crm-search">
          <Search size={15} />
          <input
            type="search"
            value={queueQuery}
            onChange={event => setQueueQuery(event.target.value)}
            placeholder="Search name, case reference or postcode"
            aria-label="Search intake patients"
          />
        </div>
        <div className="order-crm-filters" role="group" aria-label="Filter intake by source">
          {([
            { key: 'all' as const, label: 'All', count: allRecords.length },
            { key: 'website' as const, label: 'Website', count: general.length },
            { key: 'qr' as const, label: 'QR links', count: referrals.length },
          ]).map(filter => (
            <button
              type="button"
              key={filter.key}
              className={queueFilter === filter.key ? 'active' : ''}
              aria-pressed={queueFilter === filter.key}
              onClick={() => setQueueFilter(filter.key)}
            >
              <span>{filter.label}</span><strong>{filter.count}</strong>
            </button>
          ))}
        </div>
      </section>

      {message ? <div className="banner" role="status" aria-live="polite">{message}</div> : null}

      <div className="order-crm-workspace">
        <aside className={`order-crm-list${listOverflow.top ? ' is-overflow-top' : ''}${listOverflow.bottom ? ' is-overflow-bottom' : ''}`} aria-label="Patients awaiting HHH review">
          <header>
            <span><small>{queueLabel}</small><strong>{filteredRecords.length} result{filteredRecords.length === 1 ? '' : 's'}</strong></span>
            <button type="button" className="btn btn-sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={14} className={loading ? 'spin' : ''} aria-hidden="true" />
              Refresh
            </button>
          </header>
          <div className="order-crm-list__scroller">
            <div className="order-crm-list__rows" ref={listRowsRef}>
              {loading ? (
                <div className="order-crm-empty"><LoaderCircle className="spin" size={26} /><strong>Loading protected queue</strong><span>HHH can see every open enquiry.</span></div>
              ) : filteredRecords.length === 0 ? (
                <div className="order-crm-empty"><CheckCircle2 size={26} /><strong>No patients waiting</strong><span>Try another filter or search term.</span></div>
              ) : queueFilter === 'all' ? (
                <>
                  <IntakeListGroup label="Main website" detail="holistichealthhub.live forms" records={websiteRows} selectedId={selected?.id ?? null} onSelect={record => void open(record)} />
                  <IntakeListGroup label="QR links" detail="Pharmacy dedicated links" records={qrRows} selectedId={selected?.id ?? null} onSelect={record => void open(record)} />
                </>
              ) : (
                filteredRecords.map(record => (
                  <IntakeListRow key={record.id} record={record} selected={selected?.id === record.id} onSelect={() => void open(record)} />
                ))
              )}
            </div>
          </div>
        </aside>

        <main className="order-crm-detail">
          {!selected ? (
            <div className="order-crm-empty order-crm-empty--detail">
              <ClipboardList size={38} />
              <strong>Select a patient</strong>
              <span>Form answers, pharmacy assignment and referral stay on this record. The current destination pharmacy can see this enquiry until you refer or move it.</span>
            </div>
          ) : detailLoading || !detail ? (
            <div className="order-crm-empty order-crm-empty--detail">
              <LoaderCircle className="spin" size={28} />
              <strong>Loading authorised form</strong>
              <span>Contact details open only after the record is selected.</span>
            </div>
          ) : (
            <article className={`order-crm-record order-crm-record--${selectedReview.tone}`}>
              <header className="order-crm-record__header">
                <div className="order-crm-record__hero">
                  <div className="order-crm-record__identity">
                    <span className={`order-crm-record__stage order-tone--${selectedReview.tone}`} aria-hidden="true">
                      {isWebsite(selected) ? <Globe size={20} /> : <QrCode size={20} />}
                    </span>
                    <div className="order-crm-record__titles">
                      <strong>{selected.patientDisplayName}</strong>
                      <span className="order-crm-record__ref">{selected.caseReference} · {String(detail.postcode ?? selected.postcode ?? 'No postcode')}</span>
                      <em>Submitted {dateTime(selected.submittedAt)}</em>
                    </div>
                  </div>
                  <span className={`order-stage-pill order-tone--${selectedReview.tone}`}>{selectedReview.label}</span>
                </div>
                <div className="order-crm-record__toolbar">
                  <div className="order-crm-record__value">
                    <small>Destination</small>
                    <strong>{hasDestination ? destinationName : 'Pending'}</strong>
                    {hasDestination && destinationPharmacy?.postcode ? (
                      <span className="admin-intake-copy admin-intake-header-postcode">
                        <span>{destinationPharmacy.postcode}</span>
                        <CopyButton text={destinationPharmacy.postcode} label="Pharmacy postcode" />
                      </span>
                    ) : null}
                    <span className="order-crm-record__opened">{reviewComplete ? 'Review complete' : 'Review still open'}</span>
                  </div>
                  <div className="order-crm-record__actions" role="group" aria-label="Enquiry actions">
                    <button type="button" className="btn btn-sm admin-decline-button" aria-expanded={withdrawOpen} onClick={() => setWithdrawOpen(value => !value)}>
                      <UserX size={13} aria-hidden="true" /> Withdraw
                    </button>
                  </div>
                </div>
              </header>

              <RecordSectionNav sections={INTAKE_SECTIONS} active={activeSection} onSelect={goToSection} className="admin-intake-nav" label={`${selected.patientDisplayName} sections`} />

              <div className="patient-crm-detail__body pharmacy-dashboard admin-intake-record">
                {withdrawOpen ? (
                  <section className="admin-request-decline" aria-labelledby="intake-withdraw-title">
                    <h3 id="intake-withdraw-title">Record that {compactPatientName(selected.patientDisplayName)} withdrew</h3>
                    <p>Use this when they do not want to continue, including after the first conversation. They are emailed and the enquiry leaves the queue. This cannot be undone.</p>
                    <textarea className="input" rows={2} value={withdrawNote} onChange={event => setWithdrawNote(event.target.value)} aria-label="Note, kept with the record" placeholder="Note, kept with the record (optional)" />
                    <div className="admin-request-decline__actions">
                      <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setWithdrawOpen(false)}>Cancel</button>
                      <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => void recordWithdrawal()}>{busy ? 'Recording…' : 'Record withdrawal'}</button>
                    </div>
                  </section>
                ) : null}
                <section id="intake-section-patient" className="pharmacy-dashboard__section" aria-labelledby="intake-heading-patient">
                  <h3 id="intake-heading-patient" className="pharmacy-dashboard__heading">Patient</h3>
                  {duplicates.length ? (
                    <section className="admin-intake-duplicates" aria-label="Possible duplicate entry">
                      <p>
                        <Copy size={14} aria-hidden="true" />
                        <strong>Duplicate entry.</strong>{' '}
                        {duplicates.length === 1 ? 'One other record' : `${duplicates.length} other records`} look like the same person.
                      </p>
                      <ul>
                        {duplicates.map(match => (
                          <li key={`${match.kind}:${match.id}`}>
                            <span className={`pill ${onboardingStatusPillClass(match.stage)}`}>{onboardingStatusLabel(match.stage)}</span>
                            <span>
                              <strong>{match.kind === 'patient' ? 'Patient record' : 'Application'}{match.organisationName ? ` · ${match.organisationName}` : ''}</strong>
                              <small>{match.name} · last updated {shortDate(match.date)} · matched on {match.matchedOn === 'email' ? 'email address' : 'name and date of birth'}</small>
                            </span>
                            {match.kind === 'patient' || !isOpenStage(match.stage) ? (onOpenRecord ? <button type="button" className="btn btn-sm" onClick={() => openDuplicate(match)}>View record</button> : null)
                              : <button type="button" className="btn btn-sm" onClick={() => openDuplicate(match)}>Open in queue</button>}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                  <div className="pharmacy-details">
                    <RecordCard icon={User} title="Contact">
                      <dl className="pharmacy-details__list">
                        <CopyFact label="Date of birth" value={detail.dob == null ? null : formatPatientDob(String(detail.dob))} />
                        <CopyFact label="Postcode" value={detail.postcode} />
                        <CopyFact label="Email" value={detail.email} />
                        <CopyFact label="Mobile" value={detail.mobile} />
                      </dl>
                    </RecordCard>
                    <RecordCard icon={Inbox} title="Enquiry">
                      <dl className="pharmacy-details__list">
                        <Fact label="Case reference">{selected.caseReference}</Fact>
                        <Fact label="Came in through">{isWebsite(selected) ? 'Main HHH website' : <>QR link<small>{sourceName}</small></>}</Fact>
                        <Fact label="Submitted">{dateTime(selected.submittedAt)}</Fact>
                        <Fact label="Consent">{detail.referralConsent && detail.dataSharingConsent ? 'Referral and data sharing' : <mark>Not fully given</mark>}</Fact>
                      </dl>
                    </RecordCard>
                  </div>
                </section>

                <section id="intake-section-eligibility" className="pharmacy-dashboard__section" aria-labelledby="intake-heading-eligibility">
                  <h3 id="intake-heading-eligibility" className="pharmacy-dashboard__heading">Eligibility</h3>
                  <RecordCard icon={Stethoscope} title="Form answers" tag={screeningFlag ? <span className="order-stage-pill order-tone--warning">Screening flag</span> : <span className="order-stage-pill order-tone--paid">No flags</span>}>
                    {screeningFlag ? (
                      <p className="banner banner-amber admin-intake-flag" role="status">
                        <strong>Screening flag.</strong>{' '}
                        {screeningFlag === 'TREATMENTS_NOT_TRIED'
                          ? 'The patient answered that they have not tried two licensed treatments.'
                          : 'The patient reported a psychosis or schizophrenia diagnosis for themselves or immediate family.'}
                        {' '}This is a flag only. It does not decline the application.
                      </p>
                    ) : null}
                    <dl className="pharmacy-details__list">
                      <CopyFact label="Primary condition" value={detail.primaryCondition ? words(detail.primaryCondition) : null} />
                      <CopyFact label="Conditions" value={Array.isArray(detail.conditions) && detail.conditions.length ? detail.conditions.map(words).join(', ') : null} />
                      <CopyFact label="Two treatments tried" value={detail.triedTwoTreatments ? 'Yes' : 'No or not confirmed'} flagged={!detail.triedTwoTreatments} />
                      <CopyFact label="Psychosis history" value={detail.psychosisExclusion ? 'Reported' : 'Not reported'} flagged={Boolean(detail.psychosisExclusion)} />
                    </dl>
                  </RecordCard>
                </section>

                <section id="intake-section-pharmacy" className="pharmacy-dashboard__section" aria-labelledby="intake-heading-pharmacy">
                  <h3 id="intake-heading-pharmacy" className="pharmacy-dashboard__heading">Pharmacy</h3>
                  <div className="pharmacy-details">
                    <RecordCard
                      icon={Building2}
                      title={destinationPharmacy?.name ?? 'No pharmacy yet'}
                      subtitle={destinationPharmacy ? [destinationPharmacy.gphc ? `GPhC ${destinationPharmacy.gphc}` : null, destinationPharmacy.postcode].filter(Boolean).join(' · ') || 'GPhC and postcode not recorded' : 'Choose one to send the enquiry to'}
                      tag={<span className={`order-stage-pill order-tone--${hasDestination ? 'paid' : 'warning'}`}>{hasDestination ? 'Saved' : 'Not saved'}</span>}
                    >
                      <dl className="pharmacy-details__list">
                        {destinationPharmacy ? (
                          <>
                            <CopyFact label="GPhC" value={destinationPharmacy.gphc} />
                            <CopyFact label="Postcode" value={destinationPharmacy.postcode} />
                            <CopyFact label="Phone" value={destinationPharmacy.phone} />
                            <CopyFact label="Email" value={destinationPharmacy.email} />
                          </>
                        ) : null}
                        <Fact label="Came from">{sourceName}</Fact>
                      </dl>
                      <p className="admin-intake-note">The pharmacy it is with can see this enquiry until you refer it or move it. {HOLISTIC_HEALTH_HUB_ALLOCATION_LABEL} is always available as a holding place.</p>
                    </RecordCard>
                    <RecordCard icon={RefreshCw} title={hasDestination ? 'Move to another pharmacy' : 'Choose a pharmacy'} subtitle={`${candidateRows.length} of ${candidates.length} eligible${patientArea ? ` · ${patientArea} area first` : ''}`}>
                      <div className="admin-intake-form">
                        <div className="search-box admin-intake-picker__search">
                          <Search size={15} aria-hidden="true" />
                          <input type="search" value={candidateQuery} onChange={event => setCandidateQuery(event.target.value)} placeholder="Name, GPhC or postcode" aria-label="Filter eligible pharmacies" />
                        </div>
                        <div className="admin-intake-picker" role="radiogroup" aria-label="Eligible pharmacies">
                          {candidateRows.length ? candidateRows.map(row => {
                            const picked = sameId(destination, row.id);
                            return (
                              <button
                                key={row.id}
                                type="button"
                                role="radio"
                                aria-checked={picked}
                                className={`admin-intake-picker__row${picked ? ' is-on' : ''}`}
                                onClick={() => setDestination(row.current ? currentDestinationId : row.id)}
                              >
                                <span className="admin-intake-picker__radio" aria-hidden="true" />
                                <span className="admin-intake-picker__name">
                                  <strong>{row.name}</strong>
                                  <small>{[row.gphc ? `GPhC ${row.gphc}` : null, row.postcode].filter(Boolean).join(' · ') || 'GPhC and postcode not recorded'}</small>
                                </span>
                                <span className="admin-intake-picker__tags">
                                  {row.current ? <span className="order-stage-pill order-tone--paid">Now with</span> : null}
                                  {row.sameArea && !row.current ? <span className="order-stage-pill order-tone--curaleaf-review">Same area</span> : null}
                                  {row.kind ? <span className="order-stage-pill order-tone--neutral">{row.kind}</span> : null}
                                </span>
                              </button>
                            );
                          }) : <p className="admin-intake-picker__empty">{candidates.length ? 'No pharmacy matches that search.' : 'No eligible pharmacies were found.'}</p>}
                        </div>
                        {destination && !sameId(destination, currentDestinationId) ? (
                          <div className="admin-intake-picker__confirm">
                            <p><strong>{hasDestination ? 'Moving to' : 'Sending to'} {pickedName}</strong>{hasDestination ? <> from {destinationName}. {destinationName} will stop seeing the enquiry.</> : '.'}</p>
                            <label>Reason<select className="input" value={reason} onChange={event => setReason(event.target.value as typeof reason)}><option value="patient_preference">Patient preference</option><option value="capacity">Capacity</option><option value="delivery_or_collection">Delivery or collection needs</option><option value="geographic_coverage">Geographic coverage</option><option value="service_compatibility">Service compatibility</option><option value="administrative_correction">Administrative correction</option></select></label>
                            {movingFromPharmacy ? (
                              <label>How the patient agreed<select className="input" value={agreementChannel} onChange={event => setAgreementChannel(event.target.value as PatientAgreementChannel | '')} required>
                                <option value="">Choose how they agreed…</option>
                                <option value="phone">By phone</option>
                                <option value="email">By email</option>
                                <option value="sms">By text message</option>
                                <option value="in_person">In person</option>
                                <option value="not_applicable">N/A</option>
                              </select><small>Needed because it is already with {destinationName}.</small></label>
                            ) : null}
                            <label>Private HHH note (optional)<textarea className="input" rows={2} value={allocationNote} onChange={event => setAllocationNote(event.target.value)} /></label>
                            <div className="admin-intake-actions">
                              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { setDestination(currentDestinationId); setAgreementChannel(''); setAllocationNote(''); }}>Cancel</button>
                              <button type="button" className="btn btn-primary btn-sm" disabled={busy || (movingFromPharmacy && !agreementChannel)} onClick={() => void saveDestination()}>{hasDestination ? 'Move enquiry' : 'Save pharmacy'}</button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </RecordCard>
                  </div>
                </section>

                <section id="intake-section-review" className="pharmacy-dashboard__section" aria-labelledby="intake-heading-review">
                  <h3 id="intake-heading-review" className="pharmacy-dashboard__heading">Review</h3>
                  <RecordCard icon={ClipboardList} title="HHH review" subtitle="Only HHH sees this. Pharmacies do not." tag={<span className={`order-stage-pill order-tone--${reviewMeta(detail.followUpStatus).tone}`}>{reviewMeta(detail.followUpStatus).label}</span>}>
                    <div className="admin-intake-review" role="radiogroup" aria-label="HHH review status">
                      {REVIEW_OPTIONS.map(option => {
                        const saved = option.id === String(detail.followUpStatus ?? 'not_started');
                        return (
                          <button
                            key={option.id}
                            type="button"
                            role="radio"
                            aria-checked={reviewStatus === option.id}
                            className={`admin-intake-review__option is-${reviewMeta(option.id).tone}${reviewStatus === option.id ? ' is-on' : ''}`}
                            onClick={() => setReviewStatus(option.id)}
                          >
                            <span className="admin-intake-review__dot" aria-hidden="true" />
                            <strong>{reviewMeta(option.id).label}{saved ? <em>Current</em> : null}</strong>
                            <small>{option.hint}</small>
                          </button>
                        );
                      })}
                    </div>
                    <div className="admin-intake-review__footer">
                      <p className="admin-intake-note">
                        {reviewStatus === detail.followUpStatus
                          ? reviewComplete ? 'Review is complete, so the patient can be referred.' : 'Mark it Review complete once the checks are done. That unlocks Referral.'
                          : `Changing to ${reviewMeta(reviewStatus).label}.`}
                      </p>
                      <div className="admin-intake-actions">
                        {reviewStatus !== detail.followUpStatus ? (
                          <>
                            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setReviewStatus(String(detail.followUpStatus ?? 'not_started') as ReviewStatus)}>Undo</button>
                            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void saveReview()}>Save status</button>
                          </>
                        ) : reviewComplete ? (
                          <button type="button" className="btn btn-sm" onClick={() => goToSection('referral')}>Go to Referral</button>
                        ) : null}
                      </div>
                    </div>
                  </RecordCard>
                </section>

                <section id="intake-section-referral" className="pharmacy-dashboard__section" aria-labelledby="intake-heading-referral">
                  <h3 id="intake-heading-referral" className="pharmacy-dashboard__heading">Referral</h3>
                  <RecordCard icon={Send} title="Decision" tag={<span className={`order-stage-pill order-tone--${canRefer ? 'paid' : 'neutral'}`}>{canRefer ? 'Ready' : 'Waiting'}</span>}>
                    <div className="admin-intake-outcome" role="radiogroup" aria-label="Referral outcome">
                      <button type="button" role="radio" aria-checked={referralOutcome === 'complete'} className={referralOutcome === 'complete' ? 'is-on' : ''} onClick={() => chooseOutcome('complete')}>
                        <strong>Refer</strong>
                        <small>Mark them referred for the pharmacy.</small>
                      </button>
                      <button type="button" role="radio" aria-checked={referralOutcome === 'declined'} className={referralOutcome === 'declined' ? 'is-on' : ''} onClick={() => chooseOutcome('declined')}>
                        <strong>Decline</strong>
                        <small>Eligibility or clinical decision.</small>
                      </button>
                      <button type="button" role="radio" aria-checked={referralOutcome === 'rejected'} className={referralOutcome === 'rejected' ? 'is-on' : ''} onClick={() => chooseOutcome('rejected')}>
                        <strong>Reject</strong>
                        <small>Close the enquiry without a referral.</small>
                      </button>
                    </div>

                    {referralOutcome === 'complete' ? (
                      <div className="admin-intake-form">
                        <div className="admin-intake-clinic-choice" role="radiogroup" aria-label="Curaleaf account">
                          <button type="button" role="radio" aria-checked={!existingClinicAccount} className={!existingClinicAccount ? 'is-on' : ''} onClick={() => setExistingClinicAccount(false)}>
                            <strong>New Curaleaf account</strong>
                            <small>They register with the clinic. Sends the standard referral email.</small>
                          </button>
                          <button type="button" role="radio" aria-checked={existingClinicAccount} className={existingClinicAccount ? 'is-on is-curaleaf' : ''} onClick={() => setExistingClinicAccount(true)}>
                            <strong>Already with Curaleaf</strong>
                            <small>They keep their clinic login. Sends the existing-account email. No £50 fee.</small>
                          </button>
                        </div>
                        {!canRefer ? (
                          <ul className="admin-intake-checklist" aria-label="Before referring">
                            <li className={destinationSaved ? 'is-done' : ''}>
                              <CheckCircle2 size={14} aria-hidden="true" />
                              <span>Pharmacy saved</span>
                              {destinationSaved ? null : <button type="button" className="btn btn-sm" onClick={() => goToSection('pharmacy')}>Go to Pharmacy</button>}
                            </li>
                            <li className={reviewComplete ? 'is-done' : ''}>
                              <CheckCircle2 size={14} aria-hidden="true" />
                              <span>Review completed</span>
                              {reviewComplete ? null : <button type="button" className="btn btn-sm" onClick={() => goToSection('review')}>Go to Review</button>}
                            </li>
                          </ul>
                        ) : null}
                        <label>Onboarding note<textarea className="input" rows={2} value={onboardingNote} onChange={event => setOnboardingNote(event.target.value)} /></label>
                        <div className="admin-intake-actions">
                          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !canRefer} onClick={() => void decideOnboarding('approved')}><Send size={14} /> {existingClinicAccount ? 'Refer existing Curaleaf patient' : 'Refer and activate patient'}</button>
                        </div>
                      </div>
                    ) : (
                      <div className="admin-intake-form">
                        <label>Reason for {referralOutcome === 'rejected' ? 'rejection' : 'decline'}<select className="input" value={declineReason} onChange={event => setDeclineReason(event.target.value as DeclineReason | '')}><option value="">Choose a reason…</option>{DECLINE_REASONS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select><small>Never quoted to the patient. It only chooses which email they get.</small></label>
                        <label>Onboarding note<textarea className="input" rows={2} value={onboardingNote} onChange={event => setOnboardingNote(event.target.value)} /></label>
                        <div className="admin-intake-actions">
                          <button type="button" className="btn btn-sm admin-decline-button" disabled={busy || !declineReason} onClick={() => void decideOnboarding('declined')}>{referralOutcome === 'rejected' ? 'Reject application' : 'Decline application'}</button>
                        </div>
                      </div>
                    )}
                  </RecordCard>
                </section>
              </div>
            </article>
          )}
        </main>
      </div>
    </div>
  );
}

function SummaryMetric({ label, value, detail, icon: Icon, tone }: { label: string; value: string; detail: string; icon: LucideIcon; tone: string }) {
  return (
    <article className={`order-crm-metric order-crm-metric--${tone}`}>
      <span className="order-crm-metric__icon"><Icon size={16} /></span>
      <span><small>{label}</small><strong>{value}</strong><em>{detail}</em></span>
    </article>
  );
}

function IntakeListGroup({ label, detail, records, selectedId, onSelect }: {
  label: string;
  detail: string;
  records: V2EligibilityQueueItem[];
  selectedId: string | null;
  onSelect: (record: V2EligibilityQueueItem) => void;
}) {
  if (!records.length) return null;
  return (
    <section className="order-crm-list-group" aria-label={label}>
      <header><span><strong>{label}</strong><small>{detail}</small></span><b>{records.length}</b></header>
      {records.map(record => (
        <IntakeListRow key={record.id} record={record} selected={selectedId === record.id} onSelect={() => onSelect(record)} />
      ))}
    </section>
  );
}

function IntakeListRow({ record, selected, onSelect }: { record: V2EligibilityQueueItem; selected: boolean; onSelect: () => void }) {
  const meta = reviewMeta(record.followUpStatus);
  const SourceIcon = isWebsite(record) ? Globe : QrCode;
  return (
    <button
      type="button"
      className={`order-crm-row order-crm-row--${meta.tone}${selected ? ' selected' : ''}`}
      aria-pressed={selected}
      aria-label={`${compactPatientName(record.patientDisplayName)}, ${meta.label}`}
      onClick={onSelect}
    >
      <span className={`order-crm-row__stage order-tone--${meta.tone}`}><SourceIcon size={15} aria-hidden="true" /></span>
      <span className="order-crm-row__identity">
        <strong title={record.patientDisplayName}>{compactPatientName(record.patientDisplayName)}</strong>
        <span className={`order-stage-pill order-tone--${meta.tone}`}>{meta.label}</span>
        {record.screeningFlag ? <span className="order-stage-pill order-tone--warning">Screening flag</span> : null}
        {record.duplicateOf?.length ? <span className="order-stage-pill order-tone--curaleaf-review" title="Another record looks like the same person">Duplicate · {onboardingStatusLabel(record.duplicateOf[0].stage)}</span> : null}
      </span>
      <span className="order-crm-row__position">
        <strong>{record.postcode || 'No postcode'}</strong>
        <small>{record.caseReference} · {shortDate(record.submittedAt)}</small>
      </span>
    </button>
  );
}
