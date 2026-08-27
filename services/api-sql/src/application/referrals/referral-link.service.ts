import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { createHash, randomBytes } from 'node:crypto';
import { config } from '../../bootstrap/config.js';
import { HttpError } from '../../domain/common/errors.js';
import type { OrganisationRepositoryPort } from '../../repositories/ports/organisation.port.js';

const secretClient = new SecretManagerServiceClient();
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{12,160}$/;
const ELIGIBILITY_URL = 'https://holistichealthhub.live/eligibility';

function errorCode(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error
    ? Number((error as { code?: unknown }).code)
    : null;
}

function compactOrganisationId(organisationId: string) {
  const compact = organisationId.toLowerCase().replaceAll('-', '');
  if (!/^[a-f0-9]{32}$/.test(compact)) {
    throw new HttpError(400, 'The pharmacy identifier is invalid.', 'INVALID_ORGANISATION');
  }
  return compact;
}

export function referralTokenHash(rawToken: string) {
  return createHash('sha256').update(rawToken).digest('hex');
}

export function referralSecretId(organisationId: string) {
  return `hhh-referral-link-${compactOrganisationId(organisationId)}-europe-west2`;
}

export function buildEligibilityUrl(rawToken: string) {
  if (!TOKEN_PATTERN.test(rawToken)) {
    throw new HttpError(503, 'The pharmacy eligibility link is not configured safely.', 'REFERRAL_LINK_INVALID');
  }
  const url = new URL(ELIGIBILITY_URL);
  url.searchParams.set('token', rawToken);
  return url.toString();
}

function parseSecretPayload(raw: string | undefined) {
  try {
    const parsed = raw ? JSON.parse(raw) as { token?: unknown } : null;
    if (!parsed || typeof parsed.token !== 'string' || !TOKEN_PATTERN.test(parsed.token)) return null;
    return parsed.token;
  } catch {
    return null;
  }
}

export class ReferralLinkService {
  constructor(private readonly organisationRepo: OrganisationRepositoryPort) {}

  private resourceName(organisationId: string) {
    return `projects/${config.FIREBASE_PROJECT_ID}/secrets/${referralSecretId(organisationId)}`;
  }

  private async accessToken(organisationId: string) {
    try {
      const [version] = await secretClient.accessSecretVersion({
        name: `${this.resourceName(organisationId)}/versions/latest`,
      });
      const token = parseSecretPayload(version.payload?.data?.toString('utf8'));
      if (!token) {
        throw new HttpError(503, 'The pharmacy eligibility link is not configured safely.', 'REFERRAL_LINK_INVALID');
      }
      return token;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (errorCode(error) === 5) return null;
      throw new HttpError(503, 'The pharmacy eligibility link could not be accessed securely.', 'REFERRAL_LINK_UNAVAILABLE');
    }
  }

  private async assertActiveOwnership(organisationId: string, token: string) {
    const record = await this.organisationRepo.findReferralTokenByHash(referralTokenHash(token));
    if (!record || record.organisationId.replaceAll('-', '').toLowerCase() !== compactOrganisationId(organisationId)) {
      throw new HttpError(503, 'The pharmacy eligibility link does not match this pharmacy.', 'REFERRAL_LINK_MISMATCH');
    }
    if (record.revokedAt) {
      throw new HttpError(409, 'The pharmacy eligibility link has been revoked.', 'REFERRAL_LINK_REVOKED');
    }
  }

  async getEligibilityLink(organisationId: string) {
    const organisation = await this.organisationRepo.findOrganisationById(organisationId);
    if (!organisation || organisation.archivedAt) {
      throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
    }
    const token = await this.accessToken(organisationId);
    if (!token) {
      throw new HttpError(503, 'The pharmacy eligibility link has not been issued.', 'REFERRAL_LINK_NOT_ISSUED');
    }
    await this.assertActiveOwnership(organisationId, token);
    return buildEligibilityUrl(token);
  }

  async ensureEligibilityLink(params: {
    organisationId: string;
    createdByUid?: string | null;
    preferredToken?: string;
  }) {
    const organisation = await this.organisationRepo.findOrganisationById(params.organisationId);
    if (!organisation || organisation.archivedAt) {
      throw new HttpError(404, 'Pharmacy record not found.', 'NOT_FOUND');
    }

    let token = await this.accessToken(params.organisationId);
    if (token) {
      await this.assertActiveOwnership(params.organisationId, token);
      return { token, url: buildEligibilityUrl(token), created: false };
    }

    token = params.preferredToken ?? randomBytes(32).toString('hex');
    if (!TOKEN_PATTERN.test(token)) {
      throw new HttpError(400, 'The requested referral token format is invalid.', 'INVALID_REFERRAL_TOKEN');
    }

    const resourceName = this.resourceName(params.organisationId);
    let secretExists = false;
    try {
      const [secret] = await secretClient.getSecret({ name: resourceName });
      const labels = secret.labels ?? {};
      secretExists = true;
      if (labels['hhh-purpose'] !== 'referral-link' || labels['organisation'] !== compactOrganisationId(params.organisationId)) {
        throw new HttpError(503, 'The referral secret identity check failed.', 'REFERRAL_LINK_MISMATCH');
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (errorCode(error) !== 5) {
        throw new HttpError(503, 'The pharmacy eligibility link could not be created securely.', 'REFERRAL_LINK_UNAVAILABLE');
      }
    }

    if (!secretExists) {
      try {
        await secretClient.createSecret({
          parent: `projects/${config.FIREBASE_PROJECT_ID}`,
          secretId: referralSecretId(params.organisationId),
          secret: {
            replication: { automatic: {} },
            labels: {
              'hhh-purpose': 'referral-link',
              organisation: compactOrganisationId(params.organisationId),
            },
          },
        });
      } catch (error) {
        throw new HttpError(503, 'The pharmacy eligibility link could not be created securely.', 'REFERRAL_LINK_UNAVAILABLE');
      }
    }

    try {
      await secretClient.addSecretVersion({
        parent: resourceName,
        payload: { data: Buffer.from(JSON.stringify({ token }), 'utf8') },
      });
    } catch (error) {
      throw new HttpError(503, 'The pharmacy eligibility link could not be stored securely.', 'REFERRAL_LINK_UNAVAILABLE');
    }

    const hash = referralTokenHash(token);
    const existing = await this.organisationRepo.findReferralTokenByHash(hash);
    if (existing) {
      if (existing.organisationId.replaceAll('-', '').toLowerCase() !== compactOrganisationId(params.organisationId) || existing.revokedAt) {
        throw new HttpError(409, 'The generated eligibility token cannot be assigned to this pharmacy.', 'REFERRAL_TOKEN_CONFLICT');
      }
    } else {
      await this.organisationRepo.createReferralToken({
        organisationId: params.organisationId,
        tokenHash: hash,
        intakeVersion: 'v2',
        createdByUid: params.createdByUid ?? null,
      });
    }

    return { token, url: buildEligibilityUrl(token), created: true };
  }
}
