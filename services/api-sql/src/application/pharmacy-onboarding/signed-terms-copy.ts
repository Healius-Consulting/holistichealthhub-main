import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

/**
 * The signed copy of the Partner Terms: the uploaded PDF exactly as published, with one
 * page added at the end that records who signed it, for which pharmacy and company,
 * when, and which version. It stands on its own as the record the pharmacy keeps.
 */

export type SignatureDetails = {
  pharmacyName: string;
  registeredCompanyName: string;
  gphcPremisesNumber: string | null;
  signerName: string;
  signerRole: string;
  signerGphcNumber: string | null;
  signerEmail: string;
  signedAt: string;
  termsVersion: string;
  acceptanceId: string;
};

const ROLE_LABEL: Record<string, string> = {
  SUPERINTENDENT_PHARMACIST: 'Superintendent pharmacist',
  PHARMACIST: 'Pharmacist',
  DIRECTOR: 'Director',
  PHARMACY_MANAGER: 'Pharmacy manager',
  OTHER: 'Other',
};

export function signerRoleLabel(role: string, other?: string | null) {
  if (role === 'OTHER' && other?.trim()) return other.trim();
  return ROLE_LABEL[role] ?? role.replaceAll('_', ' ').toLowerCase().replace(/^./, letter => letter.toUpperCase());
}

export function ukDateTime(iso: string) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London', timeZoneName: 'short',
  }).format(new Date(iso));
}

/** Splits text into lines that fit `width` at `size`. */
function wrap(text: string, font: PDFFont, size: number, width: number) {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width) line = next;
    else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Standard fonts only cover WinAnsi; anything else is replaced rather than failing the copy. */
function safe(text: string) {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

export async function stampSignedCopy(termsPdf: Uint8Array, details: SignatureDetails): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(termsPdf, { ignoreEncryption: true });
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page: PDFPage = pdf.addPage([595.28, 841.89]);
  const margin = 56;
  const width = page.getWidth() - margin * 2;
  const ink = rgb(0.12, 0.16, 0.15);
  const muted = rgb(0.35, 0.4, 0.38);
  let y = page.getHeight() - margin;

  const write = (text: string, options: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb>; gap?: number } = {}) => {
    const font = options.font ?? regular;
    const size = options.size ?? 11;
    for (const line of wrap(safe(text), font, size, width)) {
      page.drawText(line, { x: margin, y, size, font, color: options.color ?? ink });
      y -= size * 1.45;
    }
    y -= options.gap ?? 0;
  };

  write('Holistic Health Hub', { font: bold, size: 10, color: muted, gap: 6 });
  write('Partner Terms: signature record', { font: bold, size: 20, gap: 10 });
  write(`This page was added by the Holistic Health Hub platform when the Partner Terms (version ${details.termsVersion}) on the preceding pages were accepted electronically.`, { color: muted, gap: 18 });

  const rows: Array<[string, string]> = [
    ['Pharmacy', details.pharmacyName],
    ['Registered company', details.registeredCompanyName],
    ...(details.gphcPremisesNumber ? [['GPhC premises number', details.gphcPremisesNumber] as [string, string]] : []),
    ['Signed by', details.signerName],
    ['Role', details.signerRole],
    ...(details.signerGphcNumber ? [['Signer GPhC number', details.signerGphcNumber] as [string, string]] : []),
    ['Signer email', details.signerEmail],
    ['Signed on', ukDateTime(details.signedAt)],
    ['Terms version', details.termsVersion],
    ['Record reference', details.acceptanceId],
  ];
  for (const [label, value] of rows) {
    page.drawText(safe(label), { x: margin, y, size: 9, font: bold, color: muted });
    y -= 13;
    write(value || '-', { size: 12, gap: 8 });
  }

  y -= 8;
  write(`Declaration: the person named above confirmed that they are authorised to accept these Partner Terms on behalf of ${details.registeredCompanyName}, and typed their name as their signature.`, { size: 10, color: muted });
  return pdf.save();
}
