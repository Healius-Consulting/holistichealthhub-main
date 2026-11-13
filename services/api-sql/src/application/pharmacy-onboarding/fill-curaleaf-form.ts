import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { PharmacyOnboardingFields } from '../../domain/pharmacy-onboarding/request.js';
import { londonLongDate } from '../../domain/pharmacy-onboarding/request.js';

/**
 * The blank Curaleaf account form (ROK0001 revision 5) has no fillable fields.
 * Answers are drawn into the measured grey cells of
 * `assets/onboarding/curaleaf-healius-new-account-form.pdf`, which is a copy of
 * `public/onboarding/curaleaf-healius-new-account-form.pdf`.
 * Coordinates are PDF points, origin at the bottom left.
 */
const TEMPLATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../assets/onboarding/curaleaf-healius-new-account-form.pdf',
);

const INK = rgb(0.12, 0.16, 0.15);
const VALUE_X = 180;
const VALUE_RIGHT = 530;
const SIZE = 10;
const LEADING = 12;

type PlacedLine = { text: string; x: number; y: number; size?: number };

function clean(value: string) {
  return value.replace(/[^\u0020-\u00ff]/g, '?').replace(/\s+/g, ' ').trim();
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number, maxLines: number) {
  const words = clean(text).split(' ').filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

function fit(text: string, font: PDFFont, size: number, maxWidth: number) {
  const value = clean(text);
  if (font.widthOfTextAtSize(value, size) <= maxWidth) return value;
  let trimmed = value;
  while (trimmed.length > 1 && font.widthOfTextAtSize(`${trimmed}…`, size) > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed}…`;
}

function draw(page: PDFPage, font: PDFFont, lines: PlacedLine[]) {
  for (const line of lines) {
    const size = line.size ?? SIZE;
    page.drawText(line.text, { x: line.x, y: line.y, size, font, color: INK });
  }
}

export async function fillCuraleafAccountForm(fields: PharmacyOnboardingFields, signedAt: Date) {
  const pdf = await PDFDocument.load(readFileSync(TEMPLATE_PATH));
  const page = pdf.getPages()[0];
  if (!page) throw new Error('The Curaleaf account form has no page.');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const script = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const width = VALUE_RIGHT - VALUE_X;
  const block = (text: string, top: number, maxLines: number) => (
    wrap(text, font, SIZE, width, maxLines).map((line, index) => ({
      text: line,
      x: VALUE_X,
      y: top - index * LEADING,
    }))
  );

  draw(page, font, [
    ...block(fields.pharmacistName, 736, 2),
    ...block(fields.pharmacyName, 692, 2),
    ...block(fields.registeredCompanyName, 640, 2),
    ...block(fields.invoiceAddress, 590, 4),
    ...block(fields.deliveryAddress, 510, 4),
    { text: fit(fields.gphcNumber, font, SIZE, 120), x: 214, y: 438 },
    ...(fields.wdaNumber?.trim() ? [{ text: fit(fields.wdaNumber, font, SIZE, 120), x: 214, y: 406 }] : []),
    ...(fields.licenceDetails?.trim() ? [{ text: fit(fields.licenceDetails, font, SIZE, 250), x: 268, y: 374 }] : []),
    { text: fit(fields.pharmacyEmail, font, SIZE, width), x: VALUE_X, y: 326 },
    { text: fit(fields.accountsEmail, font, SIZE, width), x: VALUE_X, y: 312 },
    { text: fit(fields.pharmacyPhone, font, SIZE, width), x: VALUE_X, y: 288 },
    { text: fit(fields.accountsPhone, font, SIZE, width), x: VALUE_X, y: 274 },
    { text: fit(fields.faxNumber?.trim() || '—', font, SIZE, width), x: VALUE_X, y: 250 },
  ]);
  const signedName = fit(fields.pharmacistName.trim() || fields.signatureName, script, 16, 240);
  page.drawText(signedName, { x: VALUE_X, y: 220, size: 16, font: script, color: INK });
  page.drawText(londonLongDate(signedAt), {
    x: VALUE_X + script.widthOfTextAtSize(signedName, 16) + 14,
    y: 222,
    size: SIZE,
    font,
    color: INK,
  });

  return Buffer.from(await pdf.save());
}
