import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';

/**
 * Builds the poster pack (brief 2.9) from HHH's templates in public/posters/: the blank
 * versions of their designs, with a white square left for the QR and a white box left
 * for the pharmacy's logo. The slots below were measured from HHH's filled examples
 * (PDF points, origin bottom left). If a template is replaced, re-measure them: the
 * page size check refuses a template whose size no longer matches.
 */

type Box = { x: number; y: number; width: number; height: number };
type PageSlots = { qr: Box | null; logo: Box };

export type PosterTemplateId = 'poster' | 'leaflet';

export type PosterTemplate = {
  id: PosterTemplateId;
  label: string;
  /** Under public/posters/. */
  file: string;
  /** In the download. */
  filename: string;
  /** The page's media box. The leaflet's starts 8.58 pt up, so slots are in its user space. */
  mediaBox: Box;
  pages: PageSlots[];
  /** Space between the logo box's edge and the logo. */
  logoPadding: number;
};

const POSTER_LOGO: Box = { x: 72.3, y: 36.5, width: 235.7, height: 127 };
const LEAFLET_LOGO: Box = { x: 26, y: 31.2, width: 91.8, height: 49.9 };

export const POSTER_TEMPLATES: readonly PosterTemplate[] = [
  {
    id: 'poster',
    label: 'A3 poster',
    file: 'hhh-poster-a3.pdf',
    filename: 'a3-poster.pdf',
    mediaBox: { x: 0, y: 0, width: 1190.55, height: 1683.78 },
    pages: [{ qr: { x: 772.3, y: 290, width: 269.4, height: 269.4 }, logo: POSTER_LOGO }],
    logoPadding: 12,
  },
  {
    id: 'leaflet',
    label: 'A5 leaflet',
    file: 'hhh-leaflet-a5.pdf',
    filename: 'a5-leaflet.pdf',
    mediaBox: { x: 0, y: 8.58, width: 419.25, height: 595.5 },
    // Front: QR and logo. Back: logo only ("scan the QR code on the front").
    pages: [
      { qr: { x: 284.5, y: 142.3, width: 87.7, height: 87.7 }, logo: LEAFLET_LOGO },
      { qr: null, logo: LEAFLET_LOGO },
    ],
    logoPadding: 5,
  },
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
  /** The eligibility QR as a PNG. */
  qr: Uint8Array;
  logo?: PosterImage | null;
  /** The blank templates' bytes, by id. */
  templates: Record<PosterTemplateId, Uint8Array>;
};

/** HHH's dark green, as on the templates' headings. */
const NAME_COLOUR = rgb(0.11, 0.36, 0.2);

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

/** The largest size (up to the box's limit) at which the name fits the box in at most three lines. */
export function fitName(name: string, font: PDFFont, box: { width: number; height: number }): { size: number; lines: string[] } {
  for (let size = Math.min(box.height * 0.42, 40); size >= 5; size -= 0.5) {
    const lines = wrapText(name, font, size, box.width);
    const fits = lines.length <= 3
      && lines.length * size * 1.15 <= box.height
      && lines.every(line => font.widthOfTextAtSize(line, size) <= box.width);
    if (fits) return { size, lines };
  }
  const size = 5;
  return { size, lines: wrapText(name, font, size, box.width).slice(0, 3) };
}

function inset(box: Box, by: number): Box {
  return { x: box.x + by, y: box.y + by, width: box.width - by * 2, height: box.height - by * 2 };
}

function drawLogo(page: PDFPage, logo: PDFImage, box: Box) {
  const fitted = logo.scaleToFit(box.width, box.height);
  page.drawImage(logo, {
    x: box.x + (box.width - fitted.width) / 2,
    y: box.y + (box.height - fitted.height) / 2,
    width: fitted.width,
    height: fitted.height,
  });
}

function drawName(page: PDFPage, name: string, font: PDFFont, box: Box) {
  const { size, lines } = fitName(name, font, box);
  const lineHeight = size * 1.15;
  // Centre the block, then each line, in the box.
  let baseline = box.y + (box.height + lines.length * lineHeight) / 2 - size;
  for (const line of lines) {
    page.drawText(line, { x: box.x + (box.width - font.widthOfTextAtSize(line, size)) / 2, y: baseline, size, font, color: NAME_COLOUR });
    baseline -= lineHeight;
  }
}

/** One PDF per template, with every page stamped. */
export async function buildPosterPdfs(input: PosterInput): Promise<{ id: PosterTemplateId; filename: string; bytes: Uint8Array }[]> {
  const out = [];
  for (const template of POSTER_TEMPLATES) {
    const pdf = await PDFDocument.load(input.templates[template.id]);
    const pages = pdf.getPages();
    if (pages.length !== template.pages.length) throw new Error(`The ${template.label} template has ${pages.length} pages, not ${template.pages.length}.`);
    pdf.setTitle(`${template.label} — ${input.pharmacyName}`);
    pdf.setCreator('Holistic Health Hub');
    pdf.setProducer('Holistic Health Hub');
    const qr = await pdf.embedPng(input.qr);
    const logo = input.logo
      ? await (input.logo.type === 'png' ? pdf.embedPng(input.logo.bytes) : pdf.embedJpg(input.logo.bytes)).catch(() => null)
      : null;
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    pages.forEach((page, index) => {
      const media = page.getMediaBox();
      const expected = template.mediaBox;
      if ([media.x - expected.x, media.y - expected.y, media.width - expected.width, media.height - expected.height].some(gap => Math.abs(gap) > 1)) {
        throw new Error(`The ${template.label} template's page box has changed (${[media.x, media.y, media.width, media.height].map(n => n.toFixed(1)).join(', ')}); re-measure its QR and logo slots.`);
      }
      const slots = template.pages[index]!;
      if (slots.qr) page.drawImage(qr, slots.qr);
      const logoBox = inset(slots.logo, template.logoPadding);
      if (logo) drawLogo(page, logo, logoBox);
      else drawName(page, input.pharmacyName, bold, logoBox);
    });
    out.push({ id: template.id, filename: template.filename, bytes: await pdf.save() });
  }
  return out;
}
