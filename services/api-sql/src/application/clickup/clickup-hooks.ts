import {
  clickupCardFields,
  LEAD_SOURCE_ONBOARDING_PAGE,
  LEAD_SOURCE_PHARMSMART,
  postcodeFromAddress,
  type ClickupCardFields,
  type ClickupEvent,
} from '../../domain/clickup/clickup-events.js';
import { compactGphcNumber } from '../../domain/pharmacy-onboarding/request.js';
import { HOLD_REASON_LABEL, type OnboardingHoldReason } from '../../domain/pharmacy-onboarding/content.js';
import type { ClickupRepositoryPort, PharmacyOnboardingVisitRepositoryPort } from '../../repositories/ports/clickup.port.js';
import { SqlClickupRepository, SqlPharmacyOnboardingVisitRepository } from '../../repositories/sql/clickup.sql.js';

/**
 * The calls the rest of the platform makes to tell HHH's ClickUp board something
 * happened. Each one only queues an outbox row (syncClickupLondon sends it), and
 * none of them ever throws: a ClickUp or database hiccup here must never fail the
 * pharmacy's or admin's request.
 */
export interface ClickupHooks {
  /** 2.11: the first PharmSmart visit of a GPhC with no account and no request. Creates the Interest card. */
  firstVisit(visit: { gphcNumber: string | null; pharmsmartPharmacyId: string | null; tradingName: string | null | undefined }): Promise<void>;
  /** The onboarding forms were submitted: Awaiting activation. */
  requestSubmitted(request: {
    id: string;
    gphcNumber: string;
    pharmacyName: string;
    registeredCompanyName: string;
    deliveryAddress: string;
    invoiceAddress: string;
  }): Promise<void>;
  /**
   * A hold was set or its reason changed. Reason A (existing Curaleaf customer) goes to
   * "Existing Curaleaf — hold", B and C to On hold; a comment names the reason.
   */
  held(input: {
    id: string;
    gphcNumber: string;
    organisationId?: string | null;
    reason: OnboardingHoldReason;
    heldAt: string;
    /** Set when this changes the reason of a hold already in place. */
    previousReason?: OnboardingHoldReason | null;
  }): Promise<void>;
  /** The hold was lifted: back to Awaiting activation, or (with a branch) where an activated branch sits. */
  unheld(input: { id: string; gphcNumber: string; organisationId?: string | null }): Promise<void>;
  /** Activate made the branch: Awaiting Curaleaf, and the branch id goes on the card. */
  activated(result: {
    requestId: string;
    organisation: { id: string; gphcNumber: string; name: string; tradingName: string; address: string };
  }): Promise<void>;
  /** The Curaleaf connection was saved: PHAR code and/or API key entered, and maybe Live. */
  curaleafConnectionSaved(input: {
    organisation: BranchForClickup;
    pharCodeEntered: boolean;
    apiKeyEntered: boolean;
    wentLive: boolean;
  }): Promise<void>;
  /** For the go-live checklist (Step 5) to call when an item is ticked. */
  checklistProgress(input: { organisation: Pick<BranchForClickup, 'id' | 'gphcNumber' | 'classification'>; percent: number }): Promise<void>;
  /** For Partner Terms acceptance (Step 3) to call: fills the Terms fields. */
  termsAccepted(input: {
    gphcNumber: string;
    organisationId?: string | null;
    onboardingRequestId?: string | null;
    acceptedAt: string;
    version: string;
    signerName: string;
  }): Promise<void>;
  /** A Worldpay application was submitted: payment route Worldpay, and a comment with the reference. */
  worldpaySubmitted(input: {
    gphcNumber: string;
    organisationId?: string | null;
    onboardingRequestId?: string | null;
    reference: string;
    submittedAt: string;
  }): Promise<void>;
  /** The branch's Worldpay credentials validated: ticks Worldpay validated. */
  worldpayValidated(input: { gphcNumber: string; organisationId: string }): Promise<void>;
}

export type BranchForClickup = {
  id: string;
  gphcNumber: string;
  name: string;
  tradingName: string;
  postcode?: string | null;
  address?: string | null;
  defaultPaymentRoute?: string | null;
  classification?: string | null;
};

export type ClickupHooksDeps = {
  clickupRepo: Pick<ClickupRepositoryPort, 'enqueue'>;
  visitRepo: Pick<PharmacyOnboardingVisitRepositoryPort, 'findVisit' | 'insertVisit' | 'markSubmitted'>;
  now?: () => Date;
};

/** Run `work`, log and swallow anything it throws. For calling hooks from code that must not fail. */
export async function bestEffort(label: string, work: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(`ClickUp ${label} was not queued`, error instanceof Error ? error.message : 'unknown');
  }
}

/** Test and training pharmacies are not partners and never get a card. */
function isRealPharmacy(organisation: { gphcNumber: string; classification?: string | null }) {
  if (organisation.classification && organisation.classification !== 'STANDARD') return false;
  return !/^TRAINING-/i.test(organisation.gphcNumber ?? '');
}

function cardKey(gphcNumber: string | null | undefined) {
  if (!gphcNumber) return null;
  return compactGphcNumber(gphcNumber) ?? (gphcNumber.trim() || null);
}

export function clickupHooks(deps: ClickupHooksDeps): ClickupHooks {
  const now = () => (deps.now?.() ?? new Date());

  async function enqueue(event: ClickupEvent, idempotencyKey: string, fields: Partial<ClickupCardFields> & { gphcNumber: string }) {
    const gphcNumber = cardKey(fields.gphcNumber);
    if (!gphcNumber) return;
    await deps.clickupRepo.enqueue({
      gphcNumber,
      event,
      payload: clickupCardFields({ ...fields, gphcNumber }),
      idempotencyKey: `clickup:${event}:${idempotencyKey}`,
    });
  }

  function branchFields(organisation: BranchForClickup) {
    return {
      gphcNumber: organisation.gphcNumber,
      branchId: organisation.id,
      tradingName: organisation.name,
      legalEntity: organisation.tradingName,
      postcode: organisation.postcode || postcodeFromAddress(organisation.address),
      paymentRoute: organisation.defaultPaymentRoute ?? null,
    };
  }

  return {
    firstVisit: visit => bestEffort('first visit', async () => {
      const gphcNumber = cardKey(visit.gphcNumber);
      if (!gphcNumber) return;
      const written = await deps.visitRepo.insertVisit({
        gphcNumber,
        pharmsmartPharmacyId: visit.pharmsmartPharmacyId?.trim() || null,
        tradingName: visit.tradingName?.trim().slice(0, 200) || null,
      });
      if (!written.created && (await deps.visitRepo.findVisit(gphcNumber))?.submittedAt) return;
      // Keyed on the GPhC, so a repeat visit is a no-op, but a visit whose event failed to queue gets another go.
      await enqueue('interest', gphcNumber, {
        gphcNumber,
        pharmsmartPharmacyId: visit.pharmsmartPharmacyId,
        tradingName: visit.tradingName,
        leadSource: LEAD_SOURCE_PHARMSMART,
      });
    }),

    requestSubmitted: request => bestEffort('submission', async () => {
      const gphcNumber = cardKey(request.gphcNumber);
      if (!gphcNumber) return;
      const visit = await deps.visitRepo.findVisit(gphcNumber);
      if (visit && !visit.submittedAt) await deps.visitRepo.markSubmitted(gphcNumber, now().toISOString());
      await enqueue('submitted', request.id, {
        gphcNumber,
        onboardingRequestId: request.id,
        pharmsmartPharmacyId: visit?.pharmsmartPharmacyId,
        tradingName: request.pharmacyName,
        legalEntity: request.registeredCompanyName,
        postcode: postcodeFromAddress(request.deliveryAddress) ?? postcodeFromAddress(request.invoiceAddress),
        leadSource: visit ? LEAD_SOURCE_PHARMSMART : LEAD_SOURCE_ONBOARDING_PAGE,
      });
    }),

    held: input => bestEffort('hold', () => enqueue(
      input.reason === 'EXISTING_CURALEAF_CUSTOMER' ? 'held_existing_curaleaf' : 'held',
      `${input.id}:${input.heldAt}`,
      {
        gphcNumber: input.gphcNumber,
        onboardingRequestId: input.id,
        branchId: input.organisationId,
        comment: input.previousReason
          ? `Hold reason changed to ${HOLD_REASON_LABEL[input.reason]} (was ${HOLD_REASON_LABEL[input.previousReason]})`
          : `On hold: ${HOLD_REASON_LABEL[input.reason]}`,
      },
    )),

    unheld: input => bestEffort('unhold', () => enqueue(
      input.organisationId ? 'unheld_activated' : 'unheld',
      `${input.id}:${now().toISOString()}`,
      { gphcNumber: input.gphcNumber, onboardingRequestId: input.id, branchId: input.organisationId, comment: 'Hold lifted' },
    )),

    activated: result => bestEffort('activation', () => enqueue('activated', result.requestId, {
      ...branchFields(result.organisation),
      onboardingRequestId: result.requestId,
    })),

    curaleafConnectionSaved: input => bestEffort('Curaleaf connection', async () => {
      if (!isRealPharmacy(input.organisation)) return;
      const fields = branchFields(input.organisation);
      const at = now().toISOString();
      if (input.pharCodeEntered) await enqueue('phar_code_entered', `${input.organisation.id}:${at}`, fields);
      if (input.apiKeyEntered) await enqueue('api_key_entered', `${input.organisation.id}:${at}`, fields);
      if (input.wentLive) await enqueue('live', `${input.organisation.id}:${at}`, fields);
    }),

    checklistProgress: input => bestEffort('checklist', async () => isRealPharmacy(input.organisation) && enqueue(
      'checklist_progress',
      `${input.organisation.id}:${now().toISOString()}`,
      { gphcNumber: input.organisation.gphcNumber, branchId: input.organisation.id, checklistPercent: input.percent },
    )),

    termsAccepted: input => bestEffort('Terms acceptance', () => enqueue(
      'terms_accepted',
      `${cardKey(input.gphcNumber)}:${input.version}:${input.acceptedAt}`,
      {
        gphcNumber: input.gphcNumber,
        branchId: input.organisationId,
        onboardingRequestId: input.onboardingRequestId,
        termsAcceptedAt: input.acceptedAt,
        termsVersion: input.version,
        termsSigner: input.signerName,
      },
    )),
    worldpaySubmitted: input => bestEffort('Worldpay application', () => enqueue(
      'worldpay_submitted',
      `${cardKey(input.gphcNumber)}:${input.reference}`,
      {
        gphcNumber: input.gphcNumber,
        branchId: input.organisationId,
        onboardingRequestId: input.onboardingRequestId,
        paymentRoute: 'WORLDPAY',
        comment: `Worldpay application ${input.reference} submitted ${londonDay(input.submittedAt)}`,
      },
    )),
    worldpayValidated: input => bestEffort('Worldpay validated', () => enqueue(
      'worldpay_validated',
      `${cardKey(input.gphcNumber)}:${input.organisationId}`,
      { gphcNumber: input.gphcNumber, branchId: input.organisationId },
    )),
  };
}

function londonDay(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric' });
}

let shared: ClickupHooks | null = null;

/** The production hooks, on the SQL repositories. */
export function sqlClickupHooks(): ClickupHooks {
  shared ??= clickupHooks({
    clickupRepo: new SqlClickupRepository(),
    visitRepo: new SqlPharmacyOnboardingVisitRepository(),
  });
  return shared;
}
