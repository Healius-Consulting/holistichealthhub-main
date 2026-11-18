import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { POSTER_COPY } from './posterPackRules.ts';

/** Builds the poster pack's PDFs (brief 2.9). The rules and wording are in posterPackRules.ts. */

export type PosterFormat = 'a4-poster' | 'a5-leaflet' | 'a6-counter-card';

const MM = 72 / 25.4;

export const POSTER_FORMATS: readonly { id: PosterFormat; label: string; widthMm: number; heightMm: number; filename: string }[] = [
  { id: 'a4-poster', label: 'A4 poster', widthMm: 210, heightMm: 297, filename: 'a4-poster.pdf' },
  { id: 'a5-leaflet', label: 'A5 leaflet', widthMm: 148, heightMm: 210, filename: 'a5-leaflet.pdf' },
  { id: 'a6-counter-card', label: 'A6 counter card', widthMm: 105, heightMm: 148, filename: 'a6-counter-card.pdf' },
];

export type PosterImage = { bytes: Uint8Array; type: 'png' | 'jpg' };

/** PNG or JPEG by its first bytes; anything else (SVG, WebP) is left out and the name is printed instead. */
export function posterImageType(bytes: Uint8Array): PosterImage['type'] | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  return null;
}

export type PosterInput = {
  pharmacyName: string;
  address: string;
  /** The branch's primary brand colour, as #rrggbb. */
  primary: string;
  /** The eligibility QR as a PNG. */
  qr: Uint8Array;
  logo?: PosterImage | null;
};

function hexColour(value: string) {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  const hex = match ? match[1] : '0f766e';
  return rgb(parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255);
}

/** Splits text into lines that fit the width; Helvetica can't print characters outside WinAnsi, so those are dropped. */
export function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const printable = [...text].filter(char => { try { font.encodeText(char); return true; } catch { return false; } }).join('');
  const lines: string[] = [];
  let line = '';
  for (const word of printable.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

function drawCentred(page: PDFPage, lines: string[], font: PDFFont, size: number, top: number, colour = rgb(0.09, 0.13, 0.2)) {
  const { width } = page.getSize();
  let y = top;
  for (const line of lines) {
    y -= size * 1.25;
    page.drawText(line, { x: (width - font.widthOfTextAtSize(line, size)) / 2, y, size, font, color: colour });
  }
  return y;
}

async function drawPage(pdf: PDFDocument, format: typeof POSTER_FORMATS[number], input: PosterInput, images: { qr: PDFImage; logo: PDFImage | null }) {
  const width = format.widthMm * MM;
  const height = format.heightMm * MM;
  const page = pdf.addPage([width, height]);
  // Everything scales from the A4 layout, so the three sizes match.
  const scale = format.widthMm / 210;
  const margin = 16 * MM * scale;
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const primary = hexColour(input.primary);
  const inner = width - margin * 2;

  page.drawRectangle({ x: 0, y: height - 10 * MM * scale, width, height: 10 * MM * scale, color: primary });

  // Logo, or the pharmacy's name when there is no usable logo.
  let y = height - 10 * MM * scale - margin;
  if (images.logo) {
    const maxHeight = 22 * MM * scale;
    const fitted = images.logo.scaleToFit(inner * 0.6, maxHeight);
    page.drawImage(images.logo, { x: (width - fitted.width) / 2, y: y - fitted.height, width: fitted.width, height: fitted.height });
    y -= fitted.height + 6 * MM * scale;
  } else {
    y = drawCentred(page, wrapText(input.pharmacyName, bold, 22 * scale, inner), bold, 22 * scale, y) - 6 * MM * scale;
  }

  // The placeholder block HHH's wording replaces.
  const headlineSize = 26 * scale;
  const bodySize = 13 * scale;
  const headline = wrapText(POSTER_COPY.headline, bold, headlineSize, inner - 12 * MM * scale);
  const body = wrapText(POSTER_COPY.body, regular, bodySize, inner - 12 * MM * scale);
  const blockHeight = (headline.length * headlineSize + body.length * bodySize) * 1.25 + 16 * MM * scale;
  page.drawRectangle({
    x: margin, y: y - blockHeight, width: inner, height: blockHeight,
    borderColor: rgb(0.6, 0.64, 0.7), borderWidth: 1, borderDashArray: [4, 3], color: rgb(0.97, 0.96, 0.94),
  });
  let textTop = drawCentred(page, headline, bold, headlineSize, y - 6 * MM * scale);
  textTop = drawCentred(page, body, regular, bodySize, textTop - 3 * MM * scale, rgb(0.28, 0.33, 0.41));
  y -= blockHeight + 10 * MM * scale;

  // The QR fills what is left above the footer, with its quiet zone kept white.
  const footerHeight = 24 * MM * scale;
  const qrSize = Math.max(28 * MM, Math.min(inner * 0.62, y - footerHeight - 14 * MM * scale));
  page.drawImage(images.qr, { x: (width - qrSize) / 2, y: y - qrSize, width: qrSize, height: qrSize });
  y -= qrSize + 4 * MM * scale;
  drawCentred(page, [POSTER_COPY.scan], bold, 12 * scale, y, primary);

  // Footer: who the pharmacy is.
  const footerSize = 9.5 * scale;
  const footer = [...wrapText(input.pharmacyName, bold, footerSize, inner), ...wrapText(input.address, regular, footerSize, inner)];
  drawCentred(page, footer.slice(0, 3), regular, footerSize, margin + footerSize * 1.25 * Math.min(footer.length, 3), rgb(0.28, 0.33, 0.41));
}

/** One PDF per format, each a single page at its paper size. */
export async function buildPosterPdfs(input: PosterInput): Promise<{ format: PosterFormat; filename: string; bytes: Uint8Array }[]> {
  const out = [];
  for (const format of POSTER_FORMATS) {
    const pdf = await PDFDocument.create();
    pdf.setTitle(`${format.label} — ${input.pharmacyName}`);
    pdf.setCreator('Holistic Health Hub');
    pdf.setProducer('Holistic Health Hub');
    const qr = await pdf.embedPng(input.qr);
    const logo = input.logo ? await (input.logo.type === 'png' ? pdf.embedPng(input.logo.bytes) : pdf.embedJpg(input.logo.bytes)).catch(() => null) : null;
    await drawPage(pdf, format, input, { qr, logo });
    out.push({ format: format.id, filename: format.filename, bytes: await pdf.save() });
  }
  return out;
}
