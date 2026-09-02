export const PRESCRIPTION_FILE_ACCEPT = 'application/pdf,.pdf,image/jpeg,.jpg,.jpeg,image/png,.png';
export const MAX_PRESCRIPTION_FILE_BYTES = 16_000_000;
export const PRESCRIPTION_SIGNATURE_PREFIX_BYTES = 1024;

export function isPersistedPrescriptionFileId(fileId: string | null | undefined): fileId is string {
  const trimmed = fileId?.trim() ?? '';
  return trimmed.length > 0 && !trimmed.startsWith('training-file-');
}

/** Staff can open a stored copy until the prescription is collected, cancelled, or archived. */
export function orderPrescriptionCopyViewable(fileId: string | null | undefined, unavailable: boolean): boolean {
  if (unavailable) return false;
  return Boolean(fileId?.trim());
}

export type PrescriptionContentType = 'application/pdf' | 'image/jpeg' | 'image/png';

const MIME_ALIASES: Record<string, PrescriptionContentType> = {
  'application/pdf': 'application/pdf',
  'application/x-pdf': 'application/pdf',
  'application/acrobat': 'application/pdf',
  'application/vnd.pdf': 'application/pdf',
  'text/pdf': 'application/pdf',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/x-png': 'image/png',
};

export function contentTypeFromFilename(filename: string): PrescriptionContentType | null {
  const extension = filename.split('.').pop()?.toLowerCase() ?? '';
  if (extension === 'pdf') return 'application/pdf';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'png') return 'image/png';
  return null;
}

export function contentTypeFromDeclaredType(value: string): PrescriptionContentType | null {
  return MIME_ALIASES[(value ?? '').split(';')[0]!.trim().toLowerCase()] ?? null;
}

export function contentTypeFromSignature(bytes: Uint8Array): PrescriptionContentType | null {
  if (hasPdfHeader(bytes)) return 'application/pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  return null;
}

export async function resolvePrescriptionContentType(file: Pick<File, 'name' | 'type' | 'slice'>): Promise<PrescriptionContentType> {
  const prefix = new Uint8Array(await file.slice(0, PRESCRIPTION_SIGNATURE_PREFIX_BYTES).arrayBuffer());
  const sniffed = contentTypeFromSignature(prefix);
  if (sniffed) return sniffed;

  const declared = contentTypeFromDeclaredType(file.type) ?? contentTypeFromFilename(file.name);
  if (declared) {
    throw new Error('The selected file is not a valid PDF, JPG or PNG prescription.');
  }
  throw new Error('Use a PDF, JPG or PNG prescription file.');
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, PRESCRIPTION_SIGNATURE_PREFIX_BYTES);
  for (let index = 0; index <= end - 4; index += 1) {
    if (bytes[index] === 0x25 && bytes[index + 1] === 0x50 && bytes[index + 2] === 0x44 && bytes[index + 3] === 0x46) {
      return true;
    }
  }
  return false;
}
