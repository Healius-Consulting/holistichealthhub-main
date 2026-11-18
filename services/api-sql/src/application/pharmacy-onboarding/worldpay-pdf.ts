import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { londonLongDate } from '../../domain/pharmacy-onboarding/request.js';
import { formatSortCode, type WorldpayForm } from '../../domain/pharmacy-onboarding/worldpay.js';

/**
 * A readable A4 copy of the Worldpay card processing questionnaire, in the same
 * order as Worldpay's spreadsheet so it can be forwarded or copied across as is.
 */

const PAGE = { width: 595.28, height: 841.89 };
const MARGIN = 48;
const LABEL_WIDTH = 190;
const VALUE_X = MARGIN + LABEL_WIDTH + 12;
const VALUE_WIDTH = PAGE.width - MARGIN - VALUE_X;
const SIZE = 9.5;
const LEADING = 13;

const INK = rgb(0.12, 0.16, 0.15);
const MUTED = rgb(0.36, 0.42, 0.39);
const GREEN = rgb(0.09, 0.25, 0.2);
const RULE = rgb(0.86, 0.89, 0.87);
const BAND = rgb(0.93, 0.95, 0.94);

type Row = [label: string, value: string];
export type Section = { title: string; rows: Row[] };

/** Standard PDF fonts only cover Latin-1, so anything else becomes '?'. */
function clean(value: string) {
  return value.replace(/[^ -ÿ]/g, '?').replace(/\s+/g, ' ').trim();
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number) {
  const words = clean(text).split(' ').filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= maxWidth || !line) {
      line = next;
      continue;
    }
    lines.push(line);
    line = word;
  }
  if (line) lines.push(line);
  return lines.length ? lines : ['Not given'];
}

const pct = (value: number) => `${value}%`;
const money = (value: string) => {
  const number = Number(value.replace(/[£,\s]/g, ''));
  return Number.isFinite(number) && value.trim() !== ''
    ? `£${number.toLocaleString('en-GB', { maximumFractionDigits: 2 })}`
    : value;
};
const ukDate = (iso: string) => {
  const [year, month, day] = iso.split('-');
  return year && month && day ? `${day}/${month}/${year}` : iso;
};

export function worldpaySections(form: WorldpayForm): Section[] {
  const principals = form.principals.map((person, index): Section => ({
    title: form.principals.length > 1 ? `Principal ${index + 1}` : 'Principal',
    rows: [
      ['Title', person.title],
      ['First name(s)', person.firstNames],
      ['Surname', person.surname],
      ['Date of birth', ukDate(person.dateOfBirth)],
      ['Nationality', person.nationality],
      ['Home address', person.homeAddress],
      ['Country of residence', person.countryOfResidence],
      ['Years at current address', person.yearsAtAddress],
      ['Previous address', person.previousAddress],
      ['Mobile number', person.mobile],
      ['Email address', person.email],
      ['Shareholding', person.shareholding.endsWith('%') ? person.shareholding : `${person.shareholding}%`],
    ],
  }));
  return [
    {
      title: 'About your business',
      rows: [
        ['Legal name of business', form.legalName],
        ['Trading name of business', form.tradingName],
        ['Contact name', form.contactName],
        ['Contact position', form.contactPosition],
        ['Contact phone number', form.contactPhone],
        ['Business type', form.businessType],
        ['Registration no', form.registrationNumber],
        ['Registered address', form.registeredAddress],
        ['Nature of business', form.natureOfBusiness],
        ['Pharmacy GPhC number', form.gphcNumber],
        ['Trading address', form.tradingAddress],
        ['Landline phone number', form.landline],
        ['Mobile phone number', form.mobile],
        ['Business email address', form.businessEmail],
        ['Website address', form.website],
        ['VAT registration no', form.vatNumber],
        ['Date business commenced trading', form.tradingSince],
      ],
    },
    ...principals,
    {
      title: 'Nature of transactions',
      rows: [
        ['Terminal connection', form.terminalConnection],
        ['Face to face with customers', pct(form.faceToFacePercent)],
        ['Over the phone with customers', pct(form.phonePercent)],
        ['Via the internet (e-commerce)', pct(form.internetPercent)],
        ['Pay and receive immediately', pct(form.immediatePercent)],
        ['Pay and receive in 1-3 days', pct(form.oneToThreeDaysPercent)],
        ['Pay and receive in 3-5 days', pct(form.threeToFiveDaysPercent)],
        ['Pay and receive in 5+ days', pct(form.fivePlusDaysPercent)],
      ],
    },
    {
      title: 'Financials',
      rows: [
        ['Annual business turnover', money(form.annualTurnover)],
        ['Annual card processing turnover', money(form.annualCardTurnover)],
        ['Average transaction value', money(form.averageTransaction)],
        ['Take AMEX', form.takeAmex],
        ['Name of bank', form.bankName],
        ['Name on account', form.accountName],
        ['Account no', form.accountNumber],
        ['Sort code', formatSortCode(form.sortCode)],
      ],
    },
    {
      title: 'Visa / Mastercard additional information',
      rows: [
        ['1. Sales limited to the UK only?', form.salesCountries],
        ['2. No sales can be made to the U.S.', form.noUsSales],
        ['3. Licensing and dispensing controls', form.complianceConfirmations],
        ['4. Annual registration fees', form.registrationFees],
        ['5. Online consultations', form.onlineConsultations],
      ],
    },
  ];
}

/** Where a row's text and rule go. Points from the page bottom, as PDF draws them. */
export type WorldpayLayoutOp =
  | { kind: 'band'; page: number; y: number; height: number; title: string }
  | { kind: 'text'; page: number; x: number; y: number; text: string; font: 'regular' | 'bold'; muted: boolean }
  | { kind: 'rule'; page: number; y: number };

/** Space above the first line's capitals and below the last line's descenders. */
const ROW_TOP_TO_BASELINE = 13;
const ROW_BOTTOM_PAD = 9;
const BAND_HEIGHT = 24;
/** The lowest a row may reach, clear of the footer. */
const FLOOR = MARGIN + 20;
/** A heading keeps at least this many of its rows with it, at the start of a section and when it continues. */
const KEEP_WITH_HEADING = 2;

function rowHeight(lines: number) {
  return ROW_TOP_TO_BASELINE + (lines - 1) * LEADING + ROW_BOTTOM_PAD;
}

/**
 * Lays the sections out from `top` down, page by page. Each row is a band of its own
 * with its rule along its bottom edge, so a rule never crosses text. A section that
 * runs onto a new page repeats its heading there, marked "continued".
 */
export function layoutWorldpaySections(
  sections: Section[],
  measure: { wrapLabel: (text: string) => string[]; wrapValue: (text: string) => string[] },
  top: number,
): WorldpayLayoutOp[] {
  const ops: WorldpayLayoutOp[] = [];
  let page = 0;
  let y = top;

  const heading = (title: string) => {
    ops.push({ kind: 'band', page, y: y - BAND_HEIGHT, height: BAND_HEIGHT, title });
    y -= BAND_HEIGHT + 6;
  };
  const newPage = () => {
    page += 1;
    y = PAGE.height - MARGIN;
  };

  for (const section of sections) {
    const rows = section.rows.map(([label, value]) => {
      const labelLines = measure.wrapLabel(label);
      const valueLines = measure.wrapValue(value || 'Not given');
      return { labelLines, valueLines, given: Boolean(value), height: rowHeight(Math.max(labelLines.length, valueLines.length)) };
    });
    const opening = BAND_HEIGHT + 6 + rows.slice(0, KEEP_WITH_HEADING).reduce((sum, row) => sum + row.height, 0);
    if (y - opening < FLOOR) newPage();
    heading(section.title);
    for (const [index, row] of rows.entries()) {
      // A section's last rows move together, so a "continued" heading never has just one row.
      const tail = rows.slice(index);
      const tailBreaks = index >= KEEP_WITH_HEADING && tail.length <= KEEP_WITH_HEADING
        && y - tail.reduce((sum, next) => sum + next.height, 0) < FLOOR;
      if (y - row.height < FLOOR || tailBreaks) {
        newPage();
        heading(`${section.title} (continued)`);
      }
      const baseline = y - ROW_TOP_TO_BASELINE;
      row.labelLines.forEach((text, index) => ops.push({ kind: 'text', page, x: MARGIN, y: baseline - index * LEADING, text, font: 'regular', muted: true }));
      row.valueLines.forEach((text, index) => ops.push({
        kind: 'text', page, x: VALUE_X, y: baseline - index * LEADING, text, font: row.given ? 'bold' : 'regular', muted: !row.given,
      }));
      y -= row.height;
      ops.push({ kind: 'rule', page, y });
    }
    y -= 14;
  }
  return ops;
}

export async function renderWorldpayPdf(form: WorldpayForm, submittedAt: Date) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Worldpay card processing questionnaire - ${clean(form.tradingName)}`);
  pdf.setAuthor('Holistic Health Hub');
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const first = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN;
  first.drawText('CARD PROCESSING QUESTIONNAIRE', { x: MARGIN, y, size: 8.5, font: bold, color: MUTED });
  y -= 24;
  first.drawText(clean(form.tradingName), { x: MARGIN, y, size: 20, font: bold, color: GREEN });
  y -= 18;
  first.drawText(clean(`Submitted to Holistic Health Hub on ${londonLongDate(submittedAt)} for Worldpay`), {
    x: MARGIN, y, size: SIZE, font: regular, color: MUTED,
  });
  y -= 22;

  const ops = layoutWorldpaySections(worldpaySections(form), {
    wrapLabel: text => wrap(text, regular, SIZE, LABEL_WIDTH),
    wrapValue: text => wrap(text, bold, SIZE, VALUE_WIDTH),
  }, y);
  const pages = [first];
  const pageFor = (index: number) => {
    while (pages.length <= index) pages.push(pdf.addPage([PAGE.width, PAGE.height]));
    return pages[index]!;
  };
  for (const op of ops) {
    const page = pageFor(op.page);
    if (op.kind === 'band') {
      page.drawRectangle({ x: MARGIN, y: op.y, width: PAGE.width - MARGIN * 2, height: op.height, color: BAND });
      page.drawText(clean(op.title), { x: MARGIN + 10, y: op.y + 8, size: 11, font: bold, color: GREEN });
    } else if (op.kind === 'text') {
      page.drawText(op.text, { x: op.x, y: op.y, size: SIZE, font: op.font === 'bold' ? bold : regular, color: op.muted ? MUTED : INK });
    } else {
      page.drawLine({ start: { x: MARGIN, y: op.y }, end: { x: PAGE.width - MARGIN, y: op.y }, thickness: 0.5, color: RULE });
    }
  }

  pages.forEach((each, index) => {
    each.drawText(clean(`Confidential: contains bank and identity details. Page ${index + 1} of ${pages.length}`), {
      x: MARGIN, y: MARGIN - 18, size: 7.5, font: regular, color: MUTED,
    });
  });
  return Buffer.from(await pdf.save());
}
