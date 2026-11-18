import {
  clickupCardFields,
  LEAD_SOURCE_ONBOARDING_PAGE,
  LEAD_SOURCE_PHARMSMART,
  postcodeFromAddress,
  type ClickupCardFields,
  type ClickupEvent,
} from '../../domain/clickup/clickup-events.js';
import { compactGphcNumber } from '../../domain/pharmacy-onboarding/request.js';
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
  held(request: { id: string; gphcNumber: string; decidedAt?: string | null }): Promise<void>;
  unheld(request: { id: string; gphcNumber: string }): Promise<void>;
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
  /** For the Not available status (not built yet): Existing Curaleaf — hold. */
  notAvailable(input: { gphcNumber: string; organisationId?: string | null; onboardingRequestId?: string | null }): Promise<void>;
  /** For Partner Terms acceptance (Step 3) to call: fills the Terms fields. */
  termsAccepted(input: {
    gphcNumber: string;
    organisationId?: string | null;
    onboardingRequestId?: string | null;
    acceptedAt: string;
    version: string;
    signerName: string;
  }): Promise<void>;
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

    held: request => bestEffort('hold', () => enqueue(
      'held',
      `${request.id}:${request.decidedAt ?? now().toISOString()}`,
      { gphcNumber: request.gphcNumber, onboardingRequestId: request.id },
    )),

    unheld: request => bestEffort('unhold', () => enqueue(
      'unheld',
      `${request.id}:${now().toISOString()}`,
      { gphcNumber: request.gphcNumber, onboardingRequestId: request.id },
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

    notAvailable: input => bestEffort('not available', () => enqueue(
      'not_available',
      `${cardKey(input.gphcNumber)}:${now().toISOString()}`,
      { gphcNumber: input.gphcNumber, branchId: input.organisationId, onboardingRequestId: input.onboardingRequestId },
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
  };
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
