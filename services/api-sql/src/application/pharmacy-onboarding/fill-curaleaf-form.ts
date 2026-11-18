import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
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
/** The grey of the form's answer cells, sampled from the template. */
const CELL_GREY = rgb(242 / 255, 242 / 255, 242 / 255);
const SIZE = 10;
const LEADING = 12;
const SCRIPT_SIZE = 16;
/** Helvetica's capital height and Times Italic's, as a share of the font size. */
const CAP = 0.718;
const SCRIPT_CAP = 0.662;
/** Text starts this far into a cell, as the template's own labels do. */
const INSET_X = 8.8;

type Cell = { bottom: number; top: number };

/** The answer column's cells, measured from the template (x 171.2 to 545.9). */
const ANSWER_LEFT = 171.2 + INSET_X;
const ANSWER_RIGHT = 545.9 - INSET_X;
export const CURALEAF_CELLS = {
  pharmacistName: { bottom: 712.4, top: 755.9 },
  pharmacyName: { bottom: 662.1, top: 711.6 },
  registeredCompanyName: { bottom: 610.3, top: 660.6 },
  invoiceAddress: { bottom: 530.7, top: 609.5 },
  deliveryAddress: { bottom: 450.4, top: 529.2 },
  emails: { bottom: 301, top: 337.8 },
  phones: { bottom: 262.7, top: 299.5 },
  fax: { bottom: 243.2, top: 262 },
  signature: { bottom: 206.4, top: 242.5 },
} satisfies Record<string, Cell>;

/**
 * The licence lines are printed as a label, then a blank underline of underscores.
 * The answer is written in place of the underline, on the label's baseline, so it
 * reads as a filled-in form rather than text drawn over a line.
 */
/** All three licence answers start here, the earliest underline, so they line up. */
export const CURALEAF_LICENCE_X = 267.8;
export const CURALEAF_LICENCE_LINES = [
  { key: 'gphc', baseline: 438.4, underline: { left: 277.4, right: 373.3 } },
  { key: 'wda', baseline: 406.9, underline: { left: 278.9, right: 374.8 } },
  { key: 'controlledDrug', baseline: 374.6, underline: { left: 267.8, right: 375.7 } },
] as const;

export type CuraleafPlacedText = { text: string; x: number; y: number; size: number; font: 'regular' | 'script' };
export type CuraleafCover = { x: number; y: number; width: number; height: number };


/**
 * A registered community pharmacy holds neither licence, so both lines say so and
 * "Supply valid copy" is left blank. Whatever the form was sent with is ignored.
 */
export const LICENCE_NOT_APPLICABLE = 'N/A \u2014 registered community pharmacy';

/** Latin-1 plus the dashes and ellipsis Helvetica's WinAnsi encoding can draw. */
function clean(value: string) {
  return value.replace(/[^\u0020-\u00ff\u2013\u2014\u2026]/g, '?').replace(/\s+/g, ' ').trim();
}

type Measure = (text: string, size: number) => number;

function wrap(text: string, width: Measure, size: number, maxWidth: number, maxLines: number) {
  const words = clean(text).split(' ').filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (width(next, size) <= maxWidth) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  // The last line that fits is shortened rather than dropped silently.
  if (lines.length === maxLines && words.join(' ') !== lines.join(' ')) {
    lines[maxLines - 1] = fit(`${lines[maxLines - 1]} …`, width, size, maxWidth);
  }
  return lines;
}

function fit(text: string, width: Measure, size: number, maxWidth: number) {
  const value = clean(text);
  if (width(value, size) <= maxWidth) return value;
  let trimmed = value;
  while (trimmed.length > 1 && width(`${trimmed}…`, size) > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed.trimEnd()}…`;
}

/**
 * An address breaks between its comma-separated parts, so a postcode or street stays
 * whole ("Leeds, LS3 1HS", never "LS3" then "1HS"). A part too long for a line on its
 * own is word-wrapped.
 */
export function wrapAddress(text: string, width: Measure, size: number, maxWidth: number, maxLines: number) {
  const parts = clean(text).split(/\s*,\s*/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const [index, part] of parts.entries()) {
    const piece = index < parts.length - 1 ? `${part},` : part;
    const next = line ? `${line} ${piece}` : piece;
    if (width(next, size) <= maxWidth) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    if (width(piece, size) <= maxWidth) {
      line = piece;
    } else {
      const words = wrap(piece, width, size, maxWidth, maxLines);
      lines.push(...words.slice(0, -1));
      line = words.at(-1) ?? '';
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = fit(`${kept[maxLines - 1]} …`, width, size, maxWidth);
  return kept;
}

/** The most lines that fit in a cell with 4pt clear above and below. */
function linesThatFit(cell: Cell) {
  return Math.max(1, Math.floor((cell.top - cell.bottom - 8 - SIZE * CAP) / LEADING) + 1);
}

/** Baselines for `count` lines, centred on the cell by their capitals. */
function centredBaselines(cell: Cell, count: number, size = SIZE, cap = CAP) {
  const blockHeight = (count - 1) * LEADING + size * cap;
  const firstBaseline = (cell.top + cell.bottom) / 2 + blockHeight / 2 - size * cap;
  return Array.from({ length: count }, (_, index) => firstBaseline - index * LEADING);
}

/** Where each answer goes. Kept apart from drawing so the placements can be tested. */
export function layoutCuraleafForm(
  fields: PharmacyOnboardingFields,
  signedAt: Date,
  measure: { regular: Measure; script: Measure },
): { texts: CuraleafPlacedText[]; covers: CuraleafCover[] } {
  const texts: CuraleafPlacedText[] = [];
  const covers: CuraleafCover[] = [];
  const width = ANSWER_RIGHT - ANSWER_LEFT;

  const block = (lines: string[], cell: Cell) => {
    centredBaselines(cell, lines.length).forEach((y, index) => texts.push({ text: lines[index]!, x: ANSWER_LEFT, y, size: SIZE, font: 'regular' }));
  };
  const wrapped = (text: string, cell: Cell) => block(wrap(text, measure.regular, SIZE, width, linesThatFit(cell)), cell);
  const single = (text: string) => fit(text, measure.regular, SIZE, width);

  wrapped(fields.pharmacistName, CURALEAF_CELLS.pharmacistName);
  wrapped(fields.pharmacyName, CURALEAF_CELLS.pharmacyName);
  wrapped(fields.registeredCompanyName, CURALEAF_CELLS.registeredCompanyName);
  const address = (text: string, cell: Cell) => block(wrapAddress(text, measure.regular, SIZE, width, linesThatFit(cell)), cell);
  address(fields.invoiceAddress, CURALEAF_CELLS.invoiceAddress);
  address(fields.deliveryAddress, CURALEAF_CELLS.deliveryAddress);
  block([single(fields.pharmacyEmail), single(fields.accountsEmail)], CURALEAF_CELLS.emails);
  block([single(fields.pharmacyPhone), single(fields.accountsPhone)], CURALEAF_CELLS.phones);
  block([single(fields.faxNumber?.trim() || '\u2014')], CURALEAF_CELLS.fax);

  const licence = { gphc: fields.gphcNumber, wda: LICENCE_NOT_APPLICABLE, controlledDrug: LICENCE_NOT_APPLICABLE };
  for (const line of CURALEAF_LICENCE_LINES) {
    // Hide the printed underscores (they sit just below the baseline), then write the answer there.
    covers.push({ x: line.underline.left - 1, y: line.baseline - 4, width: line.underline.right - line.underline.left + 2, height: 5 });
    texts.push({ text: fit(licence[line.key], measure.regular, SIZE, ANSWER_RIGHT - CURALEAF_LICENCE_X), x: CURALEAF_LICENCE_X, y: line.baseline, size: SIZE, font: 'regular' });
  }

  const signature = CURALEAF_CELLS.signature;
  const signed = fit(fields.pharmacistName.trim() || fields.signatureName, measure.script, SCRIPT_SIZE, 240);
  const [baseline] = centredBaselines(signature, 1, SCRIPT_SIZE, SCRIPT_CAP);
  texts.push({ text: signed, x: ANSWER_LEFT, y: baseline!, size: SCRIPT_SIZE, font: 'script' });
  texts.push({ text: londonLongDate(signedAt), x: ANSWER_LEFT + measure.script(signed, SCRIPT_SIZE) + 14, y: baseline!, size: SIZE, font: 'regular' });
  return { texts, covers };
}

export async function fillCuraleafAccountForm(fields: PharmacyOnboardingFields, signedAt: Date) {
  const pdf = await PDFDocument.load(readFileSync(TEMPLATE_PATH));
  const page = pdf.getPages()[0];
  if (!page) throw new Error('The Curaleaf account form has no page.');
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const script = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const { texts, covers } = layoutCuraleafForm(fields, signedAt, {
    regular: (text, size) => font.widthOfTextAtSize(text, size),
    script: (text, size) => script.widthOfTextAtSize(text, size),
  });
  for (const cover of covers) page.drawRectangle({ ...cover, color: CELL_GREY });
  for (const text of texts) {
    page.drawText(text.text, { x: text.x, y: text.y, size: text.size, font: text.font === 'script' ? script : font, color: INK });
  }
  return Buffer.from(await pdf.save());
}
