import { HttpError } from '../../domain/common/errors.js';
import { MAX_LICENCE_BYTES } from '../../domain/pharmacy-onboarding/request.js';
import {
  ALLOWED_PRESCRIPTION_CONTENT_TYPES,
  matchesDeclaredFileSignature,
  normalisedContentType,
  type AllowedPrescriptionContentType,
} from '../../providers/storage/upload-constraints.js';

const EXTENSION: Record<AllowedPrescriptionContentType, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
};

export function licenceContentType(bytes: Uint8Array, declared: string | null | undefined): AllowedPrescriptionContentType {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_LICENCE_BYTES) {
    throw new HttpError(400, 'The controlled drug licence must be a PDF, JPEG, or PNG of 4 MB or smaller.', 'LICENCE_INVALID');
  }
  const declaredType = normalisedContentType(declared);
  if (
    (ALLOWED_PRESCRIPTION_CONTENT_TYPES as readonly string[]).includes(declaredType)
    && matchesDeclaredFileSignature(bytes, declaredType)
  ) {
    return declaredType as AllowedPrescriptionContentType;
  }
  const detected = ALLOWED_PRESCRIPTION_CONTENT_TYPES.find(type => matchesDeclaredFileSignature(bytes, type));
  if (!detected) {
    throw new HttpError(400, 'The controlled drug licence must be a PDF, JPEG, or PNG.', 'LICENCE_INVALID');
  }
  return detected;
}

export function licenceStorageName(contentType: AllowedPrescriptionContentType) {
  return `controlled-drug-licence${EXTENSION[contentType]}`;
}

export function safeDownloadName(filename: string, fallback: string) {
  const cleaned = filename.replace(/[^\w.\- ]+/g, '').trim().slice(0, 120);
  return cleaned || fallback;
}
