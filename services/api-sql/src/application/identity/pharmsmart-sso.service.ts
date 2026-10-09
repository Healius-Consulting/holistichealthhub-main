import { HttpError } from '../../domain/common/errors.js';
import {
  choosePharmsmartAccount,
  issuePharmsmartSetupTicket,
  matchPharmacyByGphc,
  parsePharmsmartPharmacyInfo,
  pharmsmartDisplayName,
  pharmsmartSetupGaps,
  readPharmsmartSetupTicket,
  type PharmsmartSetupGap,
  type PharmsmartStaffCandidate,
} from '../../domain/identity/pharmsmart-sso.js';
import type { AppendAuditInput } from '../../repositories/ports/identity.port.js';

export type PharmsmartRedeemContext = {
  requestId: string | null;
  ipHash: string | null;
};

type PharmacyLink = {
  id: string;
  gphcNumber: string;
  primaryContactUid?: string | null;
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
  };

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
    listStaff: (organisationId: string) => Promise<PharmsmartStaffCandidate[]>;
    findEmailOwner: (email: string) => Promise<PharmsmartStaffCandidate | 'unlinked' | null>;
    adoptAccount: (staff: PharmsmartStaffCandidate, displayName: string) => Promise<void>;
    createAccount: (input: { email: string; displayName: string; organisationId: string }) => Promise<string>;
    createCustomToken: (uid: string, claims: { pharmsmartSso: true }) => Promise<string>;
    audit: (input: AppendAuditInput) => Promise<void>;
    setupSecret: string;
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
        return {
          status: 'welcome',
          email: info.email,
          firstName: info.firstName,
          lastName: info.lastName,
        };
      }
      await this.refuse(null, matched.reason, context);
      throw new HttpError(403, 'This pharmacy is not on Holistic Health Hub yet. Sign in with the pharmacy account if it has already been invited.', 'PHARMACY_NOT_LINKED');
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
    if (!pharmacies.some(pharmacy => pharmacy.id === claims.organisationId)) {
      await this.refuse(null, 'NOT_FOUND', context);
      throw new HttpError(403, 'This pharmacy is not on Holistic Health Hub yet. Sign in with the pharmacy account if it has already been invited.', 'PHARMACY_NOT_LINKED');
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
