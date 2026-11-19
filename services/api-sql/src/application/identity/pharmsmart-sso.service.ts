import { HttpError } from '../../domain/common/errors.js';
import {
  choosePharmsmartAccount,
  issuePharmsmartSetupTicket,
  matchPharmacyByGphc,
  parsePharmsmartPharmacyInfo,
  pharmsmartDisplayName,
  pharmsmartSetupGaps,
  readPharmsmartSetupTicket,
  type PharmsmartPrefill,
  type PharmsmartSetupGap,
  type PharmsmartStaffCandidate,
} from '../../domain/identity/pharmsmart-sso.js';
import { compactGphcNumber, PHARMACY_ON_HOLD_MESSAGE, type PharmacyOnboardingStatus } from '../../domain/pharmacy-onboarding/request.js';
import { issuePharmsmartNamesTicket } from '../../domain/pharmacy-onboarding/terms.js';
import type { AppendAuditInput } from '../../repositories/ports/identity.port.js';
import type { OnboardingHoldReason } from '../../domain/pharmacy-onboarding/content.js';
import type { OnboardingAwaitingMessage, OnboardingHoldMessage } from '../pharmacy-onboarding/onboarding-content.js';
import { bestEffort, type ClickupHooks } from '../clickup/clickup-hooks.js';

export type PharmsmartRedeemContext = {
  requestId: string | null;
  ipHash: string | null;
};

type PharmacyLink = {
  id: string;
  gphcNumber: string;
  primaryContactUid?: string | null;
  /** ON_HOLD: the branch's onboarding is on hold, so no session is opened. */
  status?: string;
  name?: string;
};

export type PharmsmartLoginResult =
  | { status: 'ready'; customToken: string }
  | {
    status: 'setup';
    ticket: string;
    missing: PharmsmartSetupGap[];
    email: string | null;
    firstName: string | null;
    lastName: string | null;
  }
  | {
    status: 'welcome';
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    gphcNumber: string | null;
    pharmsmartPharmacyId: string | null;
    prefill: PharmsmartPrefill;
    /**
     * The GPhC's latest onboarding request, when it is still waiting (`pending`) or
     * held (`on_hold`): the page shows that instead of the forms. `terms_outstanding`
     * is a waiting request whose Partner Terms were never accepted: the page resumes
     * at the Terms step. Null shows the forms.
     */
    onboardingRequest: PharmsmartOnboardingRequestState;
    /**
     * The hold message for its reason, merged for the branch: set when the request is
     * on hold, and when an activated branch on hold signs in. Shown instead of the
     * forms or the account.
     */
    hold: OnboardingHoldMessage | null;
    /** The Awaiting activation wording, merged for the branch: set when the request is `pending`. */
    awaiting: OnboardingAwaitingMessage | null;
    /** Whether a new sign-up must accept the Partner Terms (they are switched on). Off: no Terms step. */
    termsRequired: boolean;
    /** The request to accept the Terms against, only when `terms_outstanding`. */
    termsRequest: { id: string; pharmacyName: string; registeredCompanyName: string } | null;
    /** Signed PharmSmart superintendent and manager names, for the Terms step's soft check. */
    pharmsmartTicket: string;
  };

export type PharmsmartOnboardingRequestState = 'pending' | 'on_hold' | 'terms_outstanding' | null;

type LatestOnboardingRequest = {
  id: string;
  status: PharmacyOnboardingStatus;
  termsAccepted: boolean;
  /**
   * The request still has to sign at sign-up: the Terms are on and its Curaleaf
   * application has not gone (a request sent while the Terms were off waits for the
   * login prompt after Activate instead). Omitted: treated as required.
   */
  signupTermsRequired?: boolean;
  pharmacyName: string;
  registeredCompanyName: string;
  holdReason?: OnboardingHoldReason | null;
};

function onboardingRequestState(request: LatestOnboardingRequest | null | undefined): PharmsmartOnboardingRequestState {
  if (request?.status === 'PENDING') return request.termsAccepted || request.signupTermsRequired === false ? 'pending' : 'terms_outstanding';
  if (request?.status === 'ON_HOLD') return 'on_hold';
  return null;
}

type Person = { email: string | null; firstName: string | null; lastName: string | null };

/**
 * Redeem a PharmSmart `?token=` on our server.
 * The GPhC selects the pharmacy. The person gets their own SSO account there.
 * A GPhC with no pharmacy account returns the onboarding guide and does not create a user.
 * Pharmacy operational mail stays on the pharmacy inbox.
 */
export class PharmsmartSsoService {
  constructor(private readonly deps: {
    fetchPharmacyInfo: (token: string) => Promise<string>;
    listOrganisations: () => Promise<PharmacyLink[]>;
    findLatestOnboardingRequest: (gphcNumber: string) => Promise<LatestOnboardingRequest | null>;
    listStaff: (organisationId: string) => Promise<PharmsmartStaffCandidate[]>;
    findEmailOwner: (email: string) => Promise<PharmsmartStaffCandidate | 'unlinked' | null>;
    adoptAccount: (staff: PharmsmartStaffCandidate, displayName: string) => Promise<void>;
    createAccount: (input: { email: string; displayName: string; organisationId: string }) => Promise<string>;
    createCustomToken: (uid: string, claims: { pharmsmartSso: true }) => Promise<string>;
    audit: (input: AppendAuditInput) => Promise<void>;
    setupSecret: string;
    /** 2.11 stage-1 record and ClickUp Interest card (application/clickup). Best effort: never fails sign-in. */
    recordFirstVisit?: ClickupHooks['firstVisit'];
    /** The hold page wording for a reason, merged with the branch name. */
    holdMessage: (reason: OnboardingHoldReason | null, branchName: string) => Promise<OnboardingHoldMessage>;
    /** The hold message for an activated branch on hold (its request's reason). */
    branchHoldMessage: (branch: { id: string; name?: string | null }) => Promise<OnboardingHoldMessage>;
    /** The Awaiting activation wording, merged with the branch name. Omitted: the page's own default. */
    awaitingMessage?: (branchName: string) => Promise<OnboardingAwaitingMessage>;
    /** Whether the Partner Terms are switched on. Omitted: off. */
    termsRequired?: () => Promise<boolean>;
  }) {}

  async redeem(token: string, context: PharmsmartRedeemContext): Promise<PharmsmartLoginResult> {
    let raw: string;
    try {
      raw = await this.deps.fetchPharmacyInfo(token);
    } catch {
      await this.refuse(null, 'UNAVAILABLE', context);
      throw new HttpError(502, 'PharmSmart could not be reached. Sign in with the pharmacy\'s Holistic Health Hub account.', 'PHARMSMART_UNAVAILABLE');
    }

    const info = parsePharmsmartPharmacyInfo(raw);
    if (info.status === 'expired') {
      await this.refuse(null, 'EXPIRED', context);
      throw new HttpError(401, 'This PharmSmart link has expired. Sign in with the pharmacy\'s Holistic Health Hub account.', 'PHARMSMART_TOKEN_EXPIRED');
    }
    if (info.status !== 'pharmacy') {
      await this.refuse(null, 'REJECTED', context);
      throw new HttpError(401, 'This PharmSmart link could not be used. Sign in with the pharmacy\'s Holistic Health Hub account.', 'PHARMSMART_TOKEN_REJECTED');
    }

    const pharmacies = await this.deps.listOrganisations();
    const matched = matchPharmacyByGphc(pharmacies, info.gphcNumber);
    if (matched.status !== 'matched') {
      if (matched.reason === 'NOT_FOUND') {
        await this.refuse(null, 'WELCOME', context);
        const gphcNumber = compactGphcNumber(info.gphcNumber);
        const request = gphcNumber ? await this.deps.findLatestOnboardingRequest(gphcNumber) : null;
        if (!request) await bestEffort('first visit', () => this.deps.recordFirstVisit?.({ gphcNumber, pharmsmartPharmacyId: info.pharmsmartPharmacyId, tradingName: info.prefill.pharmacyName }));
        const state = onboardingRequestState(request);
        const hold = state === 'on_hold' && request
          ? await this.deps.holdMessage(request.holdReason ?? null, request.pharmacyName)
          : null;
        // Wording is admin content; a read failure falls back to the page's own default.
        const awaiting = state === 'pending' && request && this.deps.awaitingMessage
          ? await this.deps.awaitingMessage(request.pharmacyName).catch(() => null)
          : null;
        return {
          status: 'welcome',
          email: info.email,
          firstName: info.firstName,
          lastName: info.lastName,
          gphcNumber: info.gphcNumber,
          pharmsmartPharmacyId: info.pharmsmartPharmacyId,
          prefill: info.prefill,
          onboardingRequest: state,
          hold,
          awaiting,
          termsRequired: await this.deps.termsRequired?.().catch(() => false) ?? false,
          termsRequest: state === 'terms_outstanding' && request
            ? { id: request.id, pharmacyName: request.pharmacyName, registeredCompanyName: request.registeredCompanyName }
            : null,
          pharmsmartTicket: this.namesTicket(gphcNumber ?? info.gphcNumber, info.prefill),
        };
      }
      await this.refuse(null, matched.reason, context);
      throw new HttpError(403, 'This pharmacy is not on Holistic Health Hub yet. Sign in with the pharmacy account if it has already been invited.', 'PHARMACY_NOT_LINKED');
    }

    // A branch on hold: no account and no session, only its hold message.
    const branch = pharmacies.find(pharmacy => pharmacy.id === matched.organisationId);
    if (branch?.status === 'ON_HOLD') {
      await this.refuse(branch.id, 'ON_HOLD', context);
      return {
        status: 'welcome',
        email: info.email,
        firstName: info.firstName,
        lastName: info.lastName,
        gphcNumber: info.gphcNumber,
        pharmsmartPharmacyId: info.pharmsmartPharmacyId,
        prefill: info.prefill,
        onboardingRequest: 'on_hold',
        hold: await this.deps.branchHoldMessage({ id: branch.id, name: branch.name ?? null }),
        awaiting: null,
        termsRequired: false,
        termsRequest: null,
        pharmsmartTicket: this.namesTicket(compactGphcNumber(info.gphcNumber) ?? info.gphcNumber, info.prefill),
      };
    }

    return this.openPerson(matched.organisationId, {
      email: info.email,
      firstName: info.firstName,
      lastName: info.lastName,
    }, info.pharmsmartPharmacyId, context);
  }

  async completeSetup(input: {
    ticket: string;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
  }, context: PharmsmartRedeemContext): Promise<PharmsmartLoginResult> {
    const claims = readPharmsmartSetupTicket(input.ticket, this.deps.setupSecret);
    if (!claims) {
      throw new HttpError(401, 'This PharmSmart sign-in has expired. Open the link from PharmSmart again.', 'PHARMSMART_TOKEN_EXPIRED');
    }
    const pharmacies = await this.deps.listOrganisations();
    const branch = pharmacies.find(pharmacy => pharmacy.id === claims.organisationId);
    if (!branch) {
      await this.refuse(null, 'NOT_FOUND', context);
      throw new HttpError(403, 'This pharmacy is not on Holistic Health Hub yet. Sign in with the pharmacy account if it has already been invited.', 'PHARMACY_NOT_LINKED');
    }
    // Put on hold since the PharmSmart link was opened: refused like a password sign-in.
    if (branch.status === 'ON_HOLD') {
      await this.refuse(branch.id, 'ON_HOLD', context);
      const hold = await this.deps.branchHoldMessage({ id: branch.id, name: branch.name ?? null }).catch(() => null);
      throw new HttpError(403, PHARMACY_ON_HOLD_MESSAGE, 'PHARMACY_ON_HOLD', { hold });
    }
    const person: Person = {
      email: claims.email ?? input.email ?? null,
      firstName: claims.firstName ?? input.firstName ?? null,
      lastName: claims.lastName ?? input.lastName ?? null,
    };
    const missing = pharmsmartSetupGaps(person);
    if (missing.length > 0) {
      throw new HttpError(400, 'Add the missing sign-in details.', 'PHARMSMART_SETUP_INCOMPLETE');
    }
    return this.openPerson(claims.organisationId, person, claims.pharmsmartPharmacyId, context);
  }

  private async openPerson(
    organisationId: string,
    person: Person,
    pharmsmartPharmacyId: string | null,
    context: PharmsmartRedeemContext,
  ): Promise<PharmsmartLoginResult> {
    const staff = await this.deps.listStaff(organisationId);
    const emailOwner = person.email ? await this.deps.findEmailOwner(person.email) : null;
    const choice = choosePharmsmartAccount({ organisationId, person, staff, emailOwner });

    if (choice.action === 'setup') {
      return {
        status: 'setup',
        ticket: issuePharmsmartSetupTicket({
          organisationId,
          pharmsmartPharmacyId,
          email: person.email,
          firstName: person.firstName,
          lastName: person.lastName,
        }, this.deps.setupSecret),
        missing: choice.missing,
        email: person.email,
        firstName: person.firstName,
        lastName: person.lastName,
      };
    }
    if (choice.action === 'blocked') {
      await this.refuse(organisationId, choice.reason, context);
      if (choice.reason === 'ACCOUNT_DISABLED') {
        throw new HttpError(403, 'This sign-in has been disabled. Contact an HHH administrator.', 'ACCOUNT_DISABLED');
      }
      throw new HttpError(409, 'This email already belongs to another Holistic Health Hub account.', 'EMAIL_IN_USE');
    }

    const displayName = pharmsmartDisplayName(person);
    let uid = choice.action === 'use' ? choice.uid : '';
    let created = false;
    if (choice.action === 'use') {
      const existing = staff.find(member => member.uid === uid) ?? (emailOwner && emailOwner !== 'unlinked' ? emailOwner : null);
      if (!existing) {
        await this.refuse(organisationId, 'NOT_FOUND', context);
        throw new HttpError(403, 'This pharmacy sign-in could not be opened.', 'PHARMACY_LOGIN_UNAVAILABLE');
      }
      await this.deps.adoptAccount(existing, displayName || existing.displayName);
    } else {
      if (!person.email || !displayName) {
        throw new HttpError(400, 'Add the missing sign-in details.', 'PHARMSMART_SETUP_INCOMPLETE');
      }
      uid = await this.deps.createAccount({ email: person.email, displayName, organisationId });
      created = true;
    }

    await this.deps.audit({
      organisationId,
      actorUid: uid,
      actorRole: 'PHARMACY_STAFF',
      event: created ? 'auth.pharmsmart_account_created' : 'auth.pharmsmart_redeemed',
      recordType: 'StaffUser',
      recordId: uid,
      requestId: context.requestId,
      ipHash: context.ipHash,
      surface: 'pharmacy',
      details: { pharmsmartPharmacyId, account: 'pharmsmart-sso' },
    });
    return { status: 'ready', customToken: await this.deps.createCustomToken(uid, { pharmsmartSso: true }) };
  }

  private namesTicket(gphcNumber: string, prefill: PharmsmartPrefill) {
    return issuePharmsmartNamesTicket({
      gphcNumber,
      people: [
        { firstName: prefill.superintendentFirstName ?? null, lastName: prefill.superintendentLastName ?? null },
        { firstName: prefill.managerFirstName ?? null, lastName: prefill.managerLastName ?? null },
      ],
    }, this.deps.setupSecret);
  }

  private async refuse(organisationId: string | null, reason: string, context: PharmsmartRedeemContext) {
    await this.deps.audit({
      organisationId,
      event: 'auth.pharmsmart_sso_refused',
      requestId: context.requestId,
      ipHash: context.ipHash,
      surface: 'pharmacy',
      details: { reason },
    });
  }
}
