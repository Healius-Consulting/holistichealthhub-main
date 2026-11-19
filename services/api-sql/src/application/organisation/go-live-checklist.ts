import { HttpError } from '../../domain/common/errors.js';
import {
  buildGoLiveChecklist,
  checklistDefinition,
  worldpayValidatedAt,
  type ChecklistTickRecord,
  type GoLiveChecklistView,
} from '../../domain/organisation/go-live-checklist.js';
import { compactGphcNumber } from '../../domain/pharmacy-onboarding/request.js';
import type { IntegrationConnectionRecord } from '../../repositories/ports/integration.port.js';
import type { OrganisationRecord } from '../../repositories/ports/organisation.port.js';
import type { ClickupHooks } from '../clickup/clickup-hooks.js';

export type GoLiveChecklistDeps = {
  findOrganisation(organisationId: string): Promise<OrganisationRecord | null>;
  checklistRepo: {
    listTicks(organisationId: string): Promise<ChecklistTickRecord[]>;
    saveTick(tick: ChecklistTickRecord): Promise<void>;
    /** When this branch signed the given Terms version (any version when omitted). */
    termsAcceptedAt(organisationId: string, documentId?: string | null): Promise<string | null>;
    /**
     * When the branch sent the Worldpay form. Today this reads the GPhC-keyed
     * PharmacyWorldpaySubmission note; a per-branch "form submitted" record plugs in here.
     */
    worldpayFormSubmittedAt(compactGphc: string, organisationId?: string): Promise<string | null>;
  };
  findWorldpayConnection(organisationId: string): Promise<IntegrationConnectionRecord | null>;
  /** Whether the Partner Terms are on, and the version to sign. Omitted: off. */
  partnerTerms?: () => Promise<{ on: boolean; documentId: string | null }>;
  clickup: Pick<ClickupHooks, 'checklistProgress'>;
  now?: () => Date;
};

async function organisationOrThrow(deps: GoLiveChecklistDeps, organisationId: string) {
  const organisation = await deps.findOrganisation(organisationId);
  if (!organisation) throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
  return organisation;
}

async function checklistFor(deps: GoLiveChecklistDeps, organisation: OrganisationRecord): Promise<GoLiveChecklistView> {
  const gphc = compactGphcNumber(organisation.gphcNumber);
  const terms = await deps.partnerTerms?.().catch(() => ({ on: false, documentId: null })) ?? { on: false, documentId: null };
  const [ticks, termsAcceptedAt, worldpayFormSubmittedAt, worldpay] = await Promise.all([
    deps.checklistRepo.listTicks(organisation.id),
    terms.on ? deps.checklistRepo.termsAcceptedAt(organisation.id, terms.documentId) : Promise.resolve(null),
    gphc ? deps.checklistRepo.worldpayFormSubmittedAt(gphc, organisation.id) : Promise.resolve(null),
    deps.findWorldpayConnection(organisation.id),
  ]);
  return buildGoLiveChecklist(organisation.id, {
    organisationStatus: organisation.status,
    worldpayEnabled: organisation.worldpayEnabled,
    termsAcceptedAt,
    termsRequired: terms.on,
    worldpayFormSubmittedAt,
    worldpayValidatedAt: worldpayValidatedAt(worldpay),
  }, ticks);
}

export async function loadGoLiveChecklist(deps: GoLiveChecklistDeps, organisationId: string): Promise<GoLiveChecklistView> {
  return checklistFor(deps, await organisationOrThrow(deps, organisationId));
}

/**
 * The pharmacy ticks or unticks one of its self-declared items. Items that tick
 * themselves, and the Worldpay form link, can't be ticked by hand. ClickUp is told
 * the new overall percentage; that never fails the tick.
 */
export async function setGoLiveChecklistItem(
  deps: GoLiveChecklistDeps,
  input: { organisationId: string; itemKey: string; done: boolean; uid: string },
): Promise<GoLiveChecklistView> {
  const definition = checklistDefinition(input.itemKey);
  if (!definition) throw new HttpError(404, 'That checklist item does not exist.', 'CHECKLIST_ITEM_NOT_FOUND');
  if (definition.kind !== 'self') {
    throw new HttpError(
      409,
      definition.kind === 'auto'
        ? 'This item ticks itself when the platform sees it done, so it cannot be ticked by hand.'
        : 'This item is done by sending the linked form.',
      'CHECKLIST_ITEM_NOT_SELF_DECLARED',
    );
  }
  const organisation = await organisationOrThrow(deps, input.organisationId);
  await deps.checklistRepo.saveTick({
    organisationId: organisation.id,
    itemKey: definition.key,
    status: input.done ? 'DONE' : 'OPEN',
    tickedByUid: input.uid,
    tickedAt: (deps.now?.() ?? new Date()).toISOString(),
  });
  const view = await checklistFor(deps, organisation);
  try {
    await deps.clickup.checklistProgress({ organisation, percent: view.percent });
  } catch {
    // The hooks already swallow their own errors; this is belt and braces.
  }
  return view;
}
