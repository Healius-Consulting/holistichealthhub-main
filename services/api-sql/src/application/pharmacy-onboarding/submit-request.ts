import { randomUUID } from 'node:crypto';
import { HttpError } from '../../domain/common/errors.js';
import { normaliseGphcNumber } from '../../domain/identity/pharmsmart-sso.js';
import {
  compactGphcNumber,
  londonCalendarDate,
  type PharmacyOnboardingFields,
  type PharmacyOnboardingRequestRecord,
} from '../../domain/pharmacy-onboarding/request.js';
import type { SqlPharmacyOnboardingRepository } from '../../repositories/sql/pharmacy-onboarding.sql.js';
import { emailAliasDomain } from '../notifications/email-catalog.js';
import { fillCuraleafAccountForm } from './fill-curaleaf-form.js';
import { licenceContentType, licenceStorageName, safeDownloadName } from './licence-file.js';

type FileStore = {
  saveObject(storagePath: string, bytes: Buffer, contentType: string): Promise<void>;
  deleteFile(storagePath: string): Promise<void>;
};

export const ALREADY_RECEIVED_MESSAGE = 'We already have the Curaleaf account form for this pharmacy. There is nothing more to send: we will email the pharmacy when its account is ready to use.';

export function onHoldMessage() {
  return `Your account could not be created at this point in time. Please email us at onboarding@${emailAliasDomain()} for more details.`;
}

export type SubmitPharmacyOnboardingInput = {
  fields: PharmacyOnboardingFields;
  licence?: { filename: string; declaredType: string | null; bytes: Buffer } | null;
  now?: Date;
};

export async function submitPharmacyOnboardingRequest(
  repo: Pick<SqlPharmacyOnboardingRepository, 'listOrganisationGphcNumbers' | 'listArchivedOrganisationGphcNumbers' | 'findByIdempotencyKey' | 'findOpenByGphc' | 'list' | 'insert'>,
  files: FileStore,
  input: SubmitPharmacyOnboardingInput,
): Promise<PharmacyOnboardingRequestRecord> {
  const gphcNumber = compactGphcNumber(input.fields.gphcNumber);
  if (!gphcNumber) {
    throw new HttpError(400, 'Enter the GPhC number.', 'INVALID_INPUT');
  }
  const fields = { ...input.fields, gphcNumber };
  const existing = await repo.findByIdempotencyKey(fields.idempotencyKey);
  if (existing) return existing;

  const organisations = await repo.listOrganisationGphcNumbers();
  const onPlatform = organisations.find(organisation => normaliseGphcNumber(organisation.gphcNumber) === gphcNumber);
  if (onPlatform?.status === 'LIVE') {
    throw new HttpError(409, 'This pharmacy is already on Holistic Health Hub. Sign in with the pharmacy account.', 'GPHC_ALREADY_ON_PLATFORM');
  }
  // An activated pharmacy still waiting on Curaleaf: a second form is a repeat.
  if (onPlatform) {
    throw new HttpError(409, ALREADY_RECEIVED_MESSAGE, 'ONBOARDING_ALREADY_RECEIVED');
  }
  const archived = await repo.listArchivedOrganisationGphcNumbers();
  if (archived.some(organisation => normaliseGphcNumber(organisation.gphcNumber) === gphcNumber)) {
    throw new HttpError(409, 'An earlier application for this GPhC number was declined. Email spatel@healiusconsulting.com to talk it through.', 'APPLICATION_DECLINED');
  }
  const open = await repo.findOpenByGphc(gphcNumber);
  if (open && open.idempotencyKey !== fields.idempotencyKey) {
    if (open.status === 'ON_HOLD') throw new HttpError(409, onHoldMessage(), 'ONBOARDING_ON_HOLD');
    throw new HttpError(409, ALREADY_RECEIVED_MESSAGE, 'ONBOARDING_ALREADY_RECEIVED');
  }
  const pharmacyEmail = fields.pharmacyEmail.trim().toLowerCase();
  const sameInbox = (await repo.list(200)).find(row =>
    row.status === 'PENDING'
    && row.pharmacyEmail.trim().toLowerCase() === pharmacyEmail
    && row.idempotencyKey !== fields.idempotencyKey
  );
  if (sameInbox) {
    throw new HttpError(409, ALREADY_RECEIVED_MESSAGE, 'ONBOARDING_ALREADY_RECEIVED');
  }

  const licence = input.licence && input.licence.bytes.length > 0 ? input.licence : null;
  const contentType = licence ? licenceContentType(licence.bytes, licence.declaredType) : null;
  const now = input.now ?? new Date();
  const id = randomUUID();
  const licenceStoragePath = contentType ? `pharmacy-onboarding/${id}/${licenceStorageName(contentType)}` : '';
  const filledFormStoragePath = `pharmacy-onboarding/${id}/curaleaf-account.pdf`;
  const signedOn = londonCalendarDate(now);
  const pdf = await fillCuraleafAccountForm(fields, now);
  if (licence && contentType) await files.saveObject(licenceStoragePath, licence.bytes, contentType);
  try {
    await files.saveObject(filledFormStoragePath, pdf, 'application/pdf');
  } catch (error) {
    if (licenceStoragePath) await files.deleteFile(licenceStoragePath);
    throw error;
  }

  const record: PharmacyOnboardingRequestRecord = {
    id,
    status: 'PENDING',
    pharmacistName: fields.pharmacistName,
    pharmacyName: fields.pharmacyName,
    registeredCompanyName: fields.registeredCompanyName,
    invoiceAddress: fields.invoiceAddress,
    deliveryAddress: fields.deliveryAddress,
    gphcNumber,
    pharmacyEmail: fields.pharmacyEmail,
    accountsEmail: fields.accountsEmail,
    pharmacyPhone: fields.pharmacyPhone,
    accountsPhone: fields.accountsPhone,
    faxNumber: fields.faxNumber?.trim() || null,
    signatureName: fields.pharmacistName.trim(),
    signedOn,
    licenceStoragePath,
    licenceContentType: contentType ?? '',
    licenceFilename: licence && contentType ? safeDownloadName(licence.filename, licenceStorageName(contentType)) : '',
    filledFormStoragePath,
    organisationId: null,
    declineReason: null,
    decidedAt: null,
    decidedByUid: null,
    idempotencyKey: fields.idempotencyKey,
    createdAt: now.toISOString(),
  };

  try {
    await repo.insert({
      id: record.id,
      pharmacistName: record.pharmacistName,
      pharmacyName: record.pharmacyName,
      registeredCompanyName: record.registeredCompanyName,
      invoiceAddress: record.invoiceAddress,
      deliveryAddress: record.deliveryAddress,
      gphcNumber: record.gphcNumber,
      pharmacyEmail: record.pharmacyEmail,
      accountsEmail: record.accountsEmail,
      pharmacyPhone: record.pharmacyPhone,
      accountsPhone: record.accountsPhone,
      faxNumber: record.faxNumber,
      signatureName: record.signatureName,
      signedOn: record.signedOn,
      licenceStoragePath: record.licenceStoragePath,
      licenceContentType: record.licenceContentType,
      licenceFilename: record.licenceFilename,
      filledFormStoragePath: record.filledFormStoragePath,
      idempotencyKey: record.idempotencyKey,
    });
  } catch (error) {
    if (licenceStoragePath) await files.deleteFile(licenceStoragePath);
    await files.deleteFile(filledFormStoragePath);
    throw error;
  }
  return record;
}
