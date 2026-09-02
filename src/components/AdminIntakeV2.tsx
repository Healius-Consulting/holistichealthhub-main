import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ClipboardList, Globe, Inbox, LoaderCircle, LockKeyhole, MapPin, QrCode, RefreshCw, Search, Send, ShieldCheck, UserRound, type LucideIcon } from 'lucide-react';
import { decideV2ProgrammeOnboarding, getAdminGeneralIntake, getAdminIntakeDetail, getAdminPharmacyReferralIntake, getAssignmentCandidates, reassignIntake, updateIntakeFollowUp } from '../shared/api';
import { HOLISTIC_HEALTH_HUB_ALLOCATION_LABEL, workspaceClassificationLabel, type V2EligibilityQueueItem } from '../shared/contracts';
import { isLocalPortalPreview } from '../dev/localPortalPreview';
import { compactPatientName } from '../utils/patientName';

type Detail = Record<string, unknown>;
type ReviewStatus = 'not_started' | 'due' | 'attempted' | 'in_progress' | 'completed' | 'unable_to_contact';
type QueueFilter = 'all' | 'website' | 'qr';

const assignmentReasons = ['patient_preference', 'capacity', 'delivery_or_collection', 'geographic_coverage', 'service_compatibility', 'administrative_correction'] as const;
const words = (value: unknown) => String(value ?? '').replaceAll('_', ' ');
const dateTime = (value: unknown) => value ? new Date(String(value)).toLocaleString('en-GB') : 'Not recorded';
const shortDate = (value: unknown) => value ? new Date(String(value)).toLocaleDateString('en-GB') : '—';
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
  { id: 'preview-pharmacy', tradingName: 'Primary Branch', gphcNumber: 'TRAINING-PRIMARY', address: 'Leeds' },
  { id: 'preview-pharmacy-2', tradingName: 'Alternate Pharmacy', gphcNumber: 'TRAINING-ALTERNATE', address: 'Manchester' },
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

function reviewMeta(status: unknown) {
  const key = String(status || 'not_started').toLowerCase();
  return REVIEW_META[key] ?? { label: words(key), tone: 'neutral' };
}

export default function AdminIntakeV2() {
  const [general, setGeneral] = useState<V2EligibilityQueueItem[]>([]);
  const [referrals, setReferrals] = useState<V2EligibilityQueueItem[]>([]);
  const [selected, setSelected] = useState<V2EligibilityQueueItem | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [candidates, setCandidates] = useState<Detail[]>([]);
  const [candidateQuery, setCandidateQuery] = useState('');
  const [destination, setDestination] = useState('');
  const [reason, setReason] = useState<(typeof assignmentReasons)[number]>('patient_preference');
  const [allocationNote, setAllocationNote] = useState('');
  const [onboardingNote, setOnboardingNote] = useState('');
  const [reviewStatus, setReviewStatus] = useState<ReviewStatus>('not_started');
  const [queueQuery, setQueueQuery] = useState('');
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('all');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const listRowsRef = useRef<HTMLDivElement>(null);
  const [listOverflow, setListOverflow] = useState({ top: false, bottom: false });

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
  };

  const loadCandidates = async (caseId: string, query = '') => {
    if (isLocalPortalPreview) {
      const normalised = query.toLowerCase();
      setCandidates(previewCandidates.filter(candidate => !normalised || String(candidate.tradingName).toLowerCase().includes(normalised)));
      return;
    }
    setCandidates((await getAssignmentCandidates(caseId, query)).records);
  };

  const open = async (record: V2EligibilityQueueItem) => {
    setSelected(record);
    setDetail(null);
    setDetailLoading(true);
    setCandidateQuery('');
    setAllocationNote('');
    setOnboardingNote('');
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

  const refreshDetail = async () => {
    if (!selected || isLocalPortalPreview) return detail;
    const next = await getAdminIntakeDetail(selected.id);
    applyDetail(next);
    return next;
  };

  const findCandidates = async () => {
    if (!selected) return;
    setBusy(true);
    setMessage('');
    try {
      await loadCandidates(selected.id, candidateQuery);
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Eligible pharmacies could not be loaded.');
    } finally {
      setBusy(false);
    }
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
        });
        await Promise.all([refreshDetail(), load()]);
      } else {
        applyDetail({ ...detail, effectiveAssignedOrganisationId: destination, assignedOrganisationId: destination, assignedOrganisationName: candidates.find(candidate => candidate.id === destination)?.tradingName, assignmentVersion: Number(detail.assignmentVersion ?? 0) + 1 });
      }
      setAllocationNote('');
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
      setMessage('HHH review status saved.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'The HHH review status could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const decideOnboarding = async (decision: 'approved' | 'declined') => {
    if (!selected || !detail) return;
    setBusy(true);
    setMessage('');
    try {
      if (!isLocalPortalPreview) {
        await decideV2ProgrammeOnboarding(selected.id, {
          expectedVersion: Number(detail.assignmentVersion ?? selected.version),
          decision,
          notes: onboardingNote.trim() || null,
        });
        setSelected(null);
        setDetail(null);
        await load();
      }
      setMessage(decision === 'approved'
        ? 'Referral completed. The patient record is now visible only to the currently assigned pharmacy.'
        : 'Application declined and removed from the active intake queue.');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'The onboarding decision could not be recorded.');
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
  const destinationSaved = Boolean(currentDestinationId) && sameId(destination, currentDestinationId);
  const reviewComplete = detail?.followUpStatus === 'completed';
  const sourceName = String(detail?.sourceOrganisationName ?? (detail?.sourceType === 'general_hhh_website' ? 'Main HHH website' : 'Original QR pharmacy'));
  const destinationName = String(detail?.assignedOrganisationName ?? candidates.find(candidate => candidate.id === currentDestinationId)?.tradingName ?? 'Not assigned');
  const selectedReview = reviewMeta(selected?.followUpStatus);
  const canRefer = reviewComplete && destinationSaved;
  const queueLabel = queueFilter === 'website' ? 'Website' : queueFilter === 'qr' ? 'QR links' : 'Intake queue';

  return (
    <div className="page-body order-crm patient-crm admin-intake-crm">
      <section className="order-crm-summary" aria-label="HHH intake summary">
        <div className="order-crm-summary__tiles">
          <SummaryMetric label="Open" value={String(allRecords.length)} detail="Enquiries awaiting HHH referral" icon={Inbox} tone="primary" />
          <SummaryMetric label="Website" value={String(general.length)} detail="Main HHH site forms" icon={Globe} tone="primary" />
          <SummaryMetric label="QR links" value={String(referrals.length)} detail="Pharmacy dedicated links" icon={QrCode} tone="primary" />
          <SummaryMetric label="In review" value={String(inProgressCount)} detail="Follow-up due or in progress" icon={ClipboardList} tone="warning" />
        </div>
      </section>

      <section className="order-crm-controls">
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
                    <strong>{destinationSaved ? 'Assigned' : 'Pending'}</strong>
                    <span className="order-crm-record__opened">{destinationName}</span>
                  </div>
                  <div className="order-crm-record__actions" role="group" aria-label="Referral actions">
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy || !canRefer} aria-describedby={!canRefer ? 'admin-intake-refer-gate' : undefined} onClick={() => void decideOnboarding('approved')}>
                      {canRefer ? <Send size={14} aria-hidden="true" /> : <LockKeyhole size={14} aria-hidden="true" />}
                      Refer patient
                    </button>
                  </div>
                </div>
                {!canRefer ? (
                  <span id="admin-intake-refer-gate" className="patient-crm-gate">
                    {!destinationSaved ? 'Save the current pharmacy destination first.' : 'Mark the HHH review as completed first.'}
                  </span>
                ) : null}
              </header>

              <IntakeJourneyRail reviewComplete={Boolean(reviewComplete)} destinationSaved={destinationSaved} />

              <div className="patient-crm-detail__body">
                <section className="order-crm-alert order-crm-alert--neutral" aria-label="Referral boundary">
                  <ShieldCheck size={16} aria-hidden="true" />
                  <span>
                    <strong>Enquiries stay visible until referral</strong>
                    <small>Only the current destination pharmacy can see this person as an enquiry. Completing referral marks them referred for that pharmacy, including before Go live. Orders stay locked until the workspace is live.</small>
                  </span>
                </section>

                <div className="admin-v2-case__summary">
                  <section>
                    <h3><UserRound size={16} /> Patient and contact</h3>
                    <dl>
                      <div><dt>Date of birth</dt><dd>{String(detail.dob ?? '—')}</dd></div>
                      <div><dt>Postcode</dt><dd>{String(detail.postcode ?? '—')}</dd></div>
                      <div><dt>Email</dt><dd>{String(detail.email ?? '—')}</dd></div>
                      <div><dt>Mobile</dt><dd>{String(detail.mobile ?? '—')}</dd></div>
                    </dl>
                  </section>
                  <section>
                    <h3><ClipboardList size={16} /> Eligibility answers</h3>
                    <dl>
                      <div><dt>Primary condition</dt><dd>{words(detail.primaryCondition || '—')}</dd></div>
                      <div><dt>Conditions</dt><dd>{Array.isArray(detail.conditions) ? detail.conditions.map(words).join(', ') : '—'}</dd></div>
                      <div><dt>Two treatments</dt><dd>{detail.triedTwoTreatments ? 'Yes' : 'No / not confirmed'}</dd></div>
                      <div><dt>Psychosis exclusion</dt><dd>{detail.psychosisExclusion ? 'Reported' : 'Not reported'}</dd></div>
                    </dl>
                  </section>
                </div>

                <div className="admin-v2-intake__forms">
                  <section className="admin-v2-panel admin-v2-intake__assignment">
                    <header><span><MapPin size={16} /><strong>Current pharmacy assignment</strong></span><span className="pill pill-neutral">Pending</span></header>
                    <div className="admin-v2-intake__route">
                      <span><small>Original source</small><strong>{sourceName}</strong><p>Audit attribution only</p></span>
                      <span aria-hidden="true">→</span>
                      <span><small>Current destination</small><strong>{destinationName}</strong><p>Who can see this enquiry now</p></span>
                    </div>
                    <p>Accept the chosen or QR pharmacy, or move the enquiry before referral. Saving a new destination removes it from the previous pharmacy and gives it to the new one. {HOLISTIC_HEALTH_HUB_ALLOCATION_LABEL} remains available as a hidden destination.</p>
                    <div className="search-box"><Search size={15} /><input value={candidateQuery} onChange={event => setCandidateQuery(event.target.value)} placeholder="Search eligible pharmacies" aria-label="Search eligible pharmacies" /></div>
                    <button type="button" className="btn btn-sm" onClick={() => void findCandidates()} disabled={busy}>Search pharmacies</button>
                    <label>Pending destination<select className="input" value={destination} onChange={event => setDestination(event.target.value)}><option value="">Select a pharmacy</option>{candidates.map(candidate => {
                      const classification = String(candidate.workspaceClassification ?? '');
                      const extra = classification === 'allocation_holding' || classification === 'training' ? ` · ${workspaceClassificationLabel(classification)}` : '';
                      return <option key={String(candidate.id)} value={String(candidate.id)}>{String(candidate.tradingName)} · GPhC {String(candidate.gphcNumber ?? 'not recorded')}{extra}</option>;
                    })}</select></label>
                    <label>Reason<select className="input" value={reason} onChange={event => setReason(event.target.value as typeof reason)}><option value="patient_preference">Patient preference</option><option value="capacity">Capacity</option><option value="delivery_or_collection">Delivery or collection needs</option><option value="geographic_coverage">Geographic coverage</option><option value="service_compatibility">Service compatibility</option><option value="administrative_correction">Administrative correction</option></select></label>
                    <label>Private HHH note<textarea className="input" rows={3} value={allocationNote} onChange={event => setAllocationNote(event.target.value)} /></label>
                    <button type="button" className="btn" disabled={busy || !destination || sameId(destination, currentDestinationId)} onClick={() => void saveDestination()}>Move pending enquiry</button>
                  </section>

                  <section className="admin-v2-panel">
                    <header><span><ClipboardList size={16} /><strong>HHH review</strong></span></header>
                    <p>Update the administrative review status. This remains invisible to pharmacy staff.</p>
                    <label>Review status<select className="input" value={reviewStatus} onChange={event => setReviewStatus(event.target.value as ReviewStatus)}><option value="not_started">Not started</option><option value="due">Follow-up due</option><option value="attempted">Contact attempted</option><option value="in_progress">In progress</option><option value="completed">Completed</option><option value="unable_to_contact">Unable to contact</option></select></label>
                    <button type="button" className="btn" disabled={busy || reviewStatus === detail.followUpStatus} onClick={() => void saveReview()}>Save review status</button>
                  </section>

                  <section className="admin-v2-panel admin-v2-intake__activation">
                    <header><span><Send size={16} /><strong>Complete referral</strong></span></header>
                    <div className={`admin-v2-referral-gate ${canRefer ? 'is-ready' : ''}`}>
                      <span>{canRefer ? <CheckCircle2 size={17} /> : <LockKeyhole size={17} />}</span>
                      <div>
                        <strong>{canRefer ? 'Ready to refer' : 'Referral gate not complete'}</strong>
                        <small>{!destinationSaved ? 'Save the current pharmacy destination first.' : !reviewComplete ? 'Mark the HHH review as completed first.' : `The patient will be marked referred for ${destinationName}.`}</small>
                      </div>
                    </div>
                    <label>Onboarding decision note<textarea className="input" rows={3} value={onboardingNote} onChange={event => setOnboardingNote(event.target.value)} /></label>
                    <div className="admin-v2-intake__decision-actions">
                      <button type="button" className="btn btn-primary" disabled={busy || !canRefer} onClick={() => void decideOnboarding('approved')}><Send size={15} /> Refer and activate patient</button>
                      <button type="button" className="btn" disabled={busy} onClick={() => void decideOnboarding('declined')}>Decline application</button>
                    </div>
                  </section>
                </div>
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
      </span>
      <span className="order-crm-row__position">
        <strong>{record.postcode || 'No postcode'}</strong>
        <small>{record.caseReference} · {shortDate(record.submittedAt)}</small>
      </span>
    </button>
  );
}

function IntakeJourneyRail({ reviewComplete, destinationSaved }: { reviewComplete: boolean; destinationSaved: boolean }) {
  const steps: Array<{ label: string; state: 'complete' | 'active' | 'upcoming' }> = [
    { label: 'Received', state: 'complete' },
    { label: 'HHH review', state: reviewComplete ? 'complete' : 'active' },
    { label: 'Destination', state: destinationSaved ? 'complete' : reviewComplete ? 'active' : 'upcoming' },
    { label: 'Refer', state: reviewComplete && destinationSaved ? 'active' : 'upcoming' },
  ];
  return (
    <ol className="order-journey-rail order-journey-rail--premium" aria-label="Intake referral journey">
      {steps.map((step, index) => (
        <li key={step.label} className={step.state === 'complete' ? 'is-complete' : step.state === 'active' ? 'is-active' : 'is-upcoming'}>
          <span className="order-journey-rail__marker">{step.state === 'complete' ? <CheckCircle2 size={14} aria-hidden="true" /> : index + 1}</span>
          <span className="order-journey-rail__copy">
            <strong>{step.label}</strong>
            <small>{step.state === 'complete' ? 'Complete' : step.state === 'active' ? 'Current' : 'Next'}</small>
          </span>
        </li>
      ))}
    </ol>
  );
}