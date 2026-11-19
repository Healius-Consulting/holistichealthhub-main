import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { londonLongDate } from '../../domain/pharmacy-onboarding/request.js';
import {
  applicationWebsite,
  tidyCompanyNumber,
  withGphc,
  type WorldpayAnswers,
} from '../../domain/worldpay-application/answers.js';
import { renderQuestionnairePdf, type Section } from '../pharmacy-onboarding/worldpay-pdf.js';

/**
 * The submitted application as Worldpay know it: their questionnaire's order and labels
 * (spec Appendix B). Built once at submission; the PDF and spreadsheet are attached to
 * WP-01 and kept until the retention job removes them.
 */

export const SCHEME_QUESTIONS = [
  'Will sales be limited to the UK only? If not, please specify which countries.',
  'Please confirm that no sales can be made to the U.S.',
  'Please confirm: a. You are licensed in all jurisdictions where you operate. b. You have controls in place to ensure you only dispense and ship prescription or controlled drugs where legally permitted. c. You do not export prescription drugs to countries where it is not allowed.',
  'Please confirm your agreement to the following annual registration fees: a. MasterCard: $1000 USD for transactions where the card is not present. b. Visa: $950 USD for transactions where the card is not present. This fee will be waived if you are accredited with an approved accreditation (e.g. GPhC, LegitScript, etc.) Worldpay will pass these fees to the merchant once registered with both MasterCard and Visa. *fees are charged per legal entity rather than per outlet so this customer will only incur the fee once.',
  'If online consultations are offered, please confirm who provides the service. Please include the name of the provider and confirm whether they are affiliated with your business in any way (e.g., ownership, shared management, branding, or contractual relationship).',
] as const;

export const DECLARATION_STATEMENTS = (legalName: string) => [
  `I confirm that the information in this application is accurate and complete, and that I am authorised to give it on behalf of ${legalName}.`,
  'I consent to Holistic Health Hub passing this information to Worldpay for our merchant account application. Holistic Health Hub uses it for no other purpose.',
];

export interface ApplicationMeta {
  reference: string;
  submittedAt: Date;
  signerName: string;
  signerPosition: string;
}

const ukDate = (iso: string) => {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : iso;
};
const pounds = (value: number | undefined) => (value === undefined ? '' : `£${value.toLocaleString('en-GB', { maximumFractionDigits: 2 })}`);
const pct = (value: number | undefined) => (value === undefined ? '' : `${value}%`);
const sortCode = (value: string) => {
  const digits = value.replace(/\D/g, '');
  return digits.length === 6 ? `${digits.slice(0, 2)}-${digits.slice(2, 4)}-${digits.slice(4)}` : value;
};
const londonDateTime = (date: Date) => date.toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function principalHeading(answers: WorldpayAnswers) {
  if (answers.business.businessType === 'Sole trader') return 'Owner';
  if (answers.business.businessType === 'Partnership') return 'Partner';
  return 'Principal';
}

function roleText(roles: string[], businessType: string) {
  if (businessType === 'Sole trader') return 'Owner';
  if (businessType === 'Partnership') return 'Partner';
  return roles.map(role => (role === 'director' ? 'Director' : 'Shareholder')).join(' and ');
}

export function applicationSections(answers: WorldpayAnswers, meta: ApplicationMeta): Section[] {
  const b = answers.business;
  const f = answers.financials;
  const t = answers.transactions;
  const company = b.businessType === 'Limited company' || b.businessType === 'PLC' || b.businessType === 'LLP';
  const heading = principalHeading(answers);
  const principals = answers.principals.map((p, index): Section => ({
    title: answers.principals.length > 1 ? `${heading} ${index + 1}` : heading,
    rows: [
      ['Role', roleText(p.roles, b.businessType)],
      ['Title', p.title === 'Other' ? p.titleOther : p.title],
      ['First name(s)', p.firstNames],
      ['Surname', p.surname],
      ['Date of birth', ukDate(p.dateOfBirth)],
      ['Nationality', p.nationality],
      ['Home address (incl postcode)', p.homeAddress],
      ['Country of residence', p.countryOfResidence],
      ['Years at current address', p.yearsAtAddress === undefined ? '' : String(p.yearsAtAddress)],
      ['Previous address if less than 3 above', p.previousAddress],
      ['Mobile Number', p.mobile],
      ['Email Address', p.email],
      ['Shareholding %', p.shareholding === undefined ? '' : `${p.shareholding}%`],
    ],
  }));
  const how = (t.faceToFace ?? 0) + (t.phone ?? 0) + (t.internet ?? 0);
  const when = (t.immediate ?? 0) + (t.oneToThreeDays ?? 0) + (t.threeToFiveDays ?? 0) + (t.fivePlusDays ?? 0);
  const scheme = [answers.scheme.s01, answers.scheme.s02, answers.scheme.s03, answers.scheme.s04, answers.scheme.s05];
  const [accurate, consent] = DECLARATION_STATEMENTS(b.legalName);

  return [
    {
      title: 'About your Business',
      rows: [
        ['Legal name of business', b.legalName],
        ['Trading name of business', b.tradingName],
        ['Contact name', b.contactName],
        ['Contact position', b.contactPosition],
        ['Contact phone number', b.contactPhone],
        ['Contact email', b.contactEmail || b.businessEmail],
        ['Business type', b.businessType],
        ['Registration no', company ? tidyCompanyNumber(b.companyNumber) : 'Not applicable'],
        ['Registered address', b.registeredAddress],
        ['Nature of business', [b.natureOfBusiness, b.businessDescription].filter(Boolean).join('. ')],
        ['Pharmacy GPhC Number', b.gphcNumber],
        ['Trading address (incl postcode)', b.tradingAddress],
        ['Landline phone number', b.landline],
        ['Mobile phone number', b.mobile],
        ['Business email address', b.businessEmail],
        ['Website address', applicationWebsite(answers)],
        ['VAT registration no', b.vatNumber.replace(/\s+/g, '').toUpperCase() || 'Not VAT registered'],
        ['Date business commenced trading', ukDate(b.tradingSince)],
      ],
    },
    ...principals,
    {
      title: 'Nature of transactions',
      rows: [
        ['What Terminal Connection do you require?', t.terminalConnection],
        ['% taken face to face with customers', pct(t.faceToFace)],
        ['% taken over the phone with customers', pct(t.phone)],
        ['% taken via the internet (e-commerce)', pct(t.internet)],
        ['Total', `${how}%`],
        ['% where customers pay & receive goods/services immediately', pct(t.immediate)],
        ['% where customers pay & receive in 1-3 days', pct(t.oneToThreeDays)],
        ['% where customers pay & receive in 3-5 days', pct(t.threeToFiveDays)],
        ['% where customers pay & receive in 5+ days', pct(t.fivePlusDays)],
        ['Total', `${when}%`],
      ],
    },
    {
      title: 'Financials',
      rows: [
        ['Annual business turnover', f.turnoverBand === 'Over £5m' && f.turnoverFigure ? pounds(f.turnoverFigure) : f.turnoverBand],
        ['Expected card payments through this account, £ per year', pounds(f.expectedCardPayments)],
        ["Average transaction value (£'s)", pounds(f.averageTransaction)],
        ['Do you wish to take AMEX', 'No'],
        ['Name of bank', f.bankName],
        ['Name on account', f.accountName],
        ['Account no', f.accountNumber.replace(/\s+/g, '')],
        ['Sort code', sortCode(f.sortCode)],
      ],
    },
    {
      title: 'Visa/Mastercard Additional Information',
      rows: SCHEME_QUESTIONS.map((question, index): [string, string] => [`${index + 1}. ${question}`, withGphc(scheme[index] ?? '', b.gphcNumber)]),
    },
    {
      title: 'Declaration',
      rows: [
        [accurate ?? '', 'Confirmed'],
        [consent ?? '', 'Confirmed'],
        ['Name', meta.signerName],
        ['Position', meta.signerPosition],
        ['Date and time', londonDateTime(meta.submittedAt)],
      ],
    },
  ];
}

export function applicationFileBase(answers: WorldpayAnswers, reference: string) {
  const name = answers.business.legalName.replace(/[^A-Za-z0-9 &'-]+/g, '').trim().replace(/\s+/g, ' ').slice(0, 80) || 'Pharmacy';
  return `Worldpay-application_${name}_${reference}`;
}

export function renderApplicationPdf(answers: WorldpayAnswers, meta: ApplicationMeta) {
  return renderQuestionnairePdf({
    title: `Worldpay application ${meta.reference} - ${answers.business.legalName}`,
    kicker: `WORLDPAY CARD PROCESSING APPLICATION · ${meta.reference}`,
    heading: answers.business.legalName,
    subline: `Trading as ${answers.business.tradingName}. Submitted through Holistic Health Hub on ${londonLongDate(meta.submittedAt)}.`,
  }, applicationSections(answers, meta));
}

const xml = (value: string) => value
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // XML 1.0 forbids most control characters.
  // oxlint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const TEMPLATE_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../../assets/worldpay/worldpay-questionnaire-template.xlsx');

/** Worldpay's own list values (the template's hidden Lists sheet uses en dashes). */
const TEMPLATE_TURNOVER: Record<string, string> = {
  'Under £500,000': 'Under £500,000',
  '£500,000 to £1m': '£500,000 – £1m',
  '£1m to £2m': '£1m – £2m',
  '£2m to £5m': '£2m – £5m',
  'Over £5m': 'Over £5m (type the figure)',
};
/** The first row of each principal block on the Questionnaire sheet (Title). */
const PRINCIPAL_ROWS = [33, 46, 59, 72];

type CellValue = string | number | null | undefined;

/** Days since 1899-12-30: how Excel stores a date. */
function excelDate(iso: string) {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return Math.round((Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

const columnIndex = (ref: string) => [...ref.replace(/\d+/g, '')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

/**
 * Writes one cell, keeping the template's style. Text goes in as an inline string,
 * numbers as numbers. A cell missing from its row is added in column order.
 */
export function setCell(sheet: string, ref: string, value: CellValue): string {
  if (value === null || value === undefined || value === '') return sheet;
  const cellPattern = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
  const existing = sheet.match(cellPattern);
  const style = existing?.[1]?.match(/ s="(\d+)"/)?.[0] ?? '';
  const cell = typeof value === 'number'
    ? `<c r="${ref}"${style}><v>${value}</v></c>`
    : `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
  if (existing) return sheet.replace(cellPattern, cell);
  const row = Number(ref.replace(/^[A-Z]+/, ''));
  const rowPattern = new RegExp(`(<row r="${row}"[^>]*>)([\\s\\S]*?)(</row>)`);
  const rowMatch = sheet.match(rowPattern);
  if (!rowMatch) {
    // No such row in the template: add it before the first row below it.
    const later = [...sheet.matchAll(/<row r="(\d+)"/g)].find(found => Number(found[1]) > row);
    const newRow = `<row r="${row}">${cell}</row>`;
    return later?.index !== undefined
      ? sheet.slice(0, later.index) + newRow + sheet.slice(later.index)
      : sheet.replace('</sheetData>', `${newRow}</sheetData>`);
  }
  const cells = rowMatch[2]!.match(/<c r="[A-Z]+\d+"[\s\S]*?(?:\/>|<\/c>)/g) ?? [];
  const at = cells.findIndex(other => columnIndex(other.match(/r="([A-Z]+)\d+"/)![1]!) > columnIndex(ref));
  const ordered = at < 0 ? [...cells, cell] : [...cells.slice(0, at), cell, ...cells.slice(at)];
  return sheet.replace(rowPattern, `$1${ordered.join('')}$3`);
}

/**
 * The application in Worldpay's own questionnaire (file 04, the HHH November 2026
 * edition): every answer in its yellow or grey cell, the branch on the Branches tab.
 * The template's totals and branch count are formulas, recalculated when opened.
 * It has four principal blocks; any further principals are named in the last one's
 * note cell and appear in full in the PDF.
 */
export async function renderApplicationXlsx(answers: WorldpayAnswers, meta: ApplicationMeta) {
  const zip = await JSZip.loadAsync(await readFile(TEMPLATE_PATH));
  const sheetFile = zip.file('xl/worksheets/sheet1.xml');
  const branchesFile = zip.file('xl/worksheets/sheet2.xml');
  if (!sheetFile || !branchesFile) throw new Error('The Worldpay questionnaire template is missing a sheet.');
  let sheet = await sheetFile.async('string');
  let branches = await branchesFile.async('string');
  const b = answers.business;
  const f = answers.financials;
  const t = answers.transactions;
  const company = b.businessType === 'Limited company' || b.businessType === 'PLC' || b.businessType === 'LLP';
  const fraction = (value: number | undefined) => (value === undefined ? null : value / 100);
  const write = (ref: string, value: CellValue) => { sheet = setCell(sheet, ref, value); };

  write('C6', answers.existingAccount === 'card_machine' ? 'Yes' : 'No');
  write('C11', b.legalName);
  write('C12', b.tradingName);
  write('C13', b.contactName);
  write('C14', b.contactPosition);
  write('C15', b.contactPhone);
  // Row 16 is blank in the template; Appendix B puts the contact email here.
  write('A16', 'Contact email:');
  write('C16', b.contactEmail || b.businessEmail);
  write('C17', b.businessType);
  write('C18', company ? tidyCompanyNumber(b.companyNumber) : 'Not applicable');
  write('C19', b.registeredAddress);
  write('C21', [b.natureOfBusiness, b.businessDescription].filter(Boolean).join('. '));
  write('C22', b.gphcNumber);
  write('C23', b.tradingAddress);
  write('C24', b.landline);
  write('C25', b.mobile);
  write('C26', b.businessEmail);
  write('C27', applicationWebsite(answers));
  write('C28', b.vatNumber.replace(/\s+/g, '').toUpperCase() || 'Not VAT registered');
  write('C29', excelDate(b.tradingSince) ?? b.tradingSince);

  answers.principals.slice(0, PRINCIPAL_ROWS.length).forEach((p, index) => {
    const top = PRINCIPAL_ROWS[index]!;
    const rows = [
      p.title === 'Other' ? p.titleOther : p.title,
      p.firstNames,
      p.surname,
      excelDate(p.dateOfBirth) ?? p.dateOfBirth,
      p.nationality,
      p.homeAddress,
      p.countryOfResidence,
      p.yearsAtAddress ?? null,
      p.previousAddress,
      p.mobile,
      p.email,
      fraction(p.shareholding),
    ];
    rows.forEach((value, offset) => write(`C${top + offset}`, value));
    // The template has no role row: say it in the blank row above each block.
    write(`A${top - 1}`, `Principal ${index + 1}: ${roleText(p.roles, b.businessType)}`);
  });
  const extra = answers.principals.slice(PRINCIPAL_ROWS.length);
  if (extra.length) {
    write('H83', `Also: ${extra.map(p => `${p.firstNames} ${p.surname}`.trim()).join('; ')} (see the PDF application for their details)`);
  }

  write('C88', t.terminalConnection);
  write('C89', fraction(t.faceToFace));
  write('C90', fraction(t.phone));
  write('C91', fraction(t.internet));
  write('C96', fraction(t.immediate));
  write('C97', fraction(t.oneToThreeDays));
  write('C98', fraction(t.threeToFiveDays));
  write('C99', fraction(t.fivePlusDays));

  write('C105', f.turnoverBand === 'Over £5m' && f.turnoverFigure ? f.turnoverFigure : TEMPLATE_TURNOVER[f.turnoverBand] ?? f.turnoverBand);
  write('C106', f.expectedCardPayments ?? null);
  write('C107', f.averageTransaction ?? null);
  write('C108', 'No');
  write('C110', f.bankName);
  write('C111', f.accountName);
  write('C112', f.accountNumber.replace(/\s+/g, ''));
  write('C113', sortCode(f.sortCode));

  const scheme = [answers.scheme.s01, answers.scheme.s02, answers.scheme.s03, answers.scheme.s04, answers.scheme.s05];
  ['C117', 'C121', 'C125', 'C132', 'C141'].forEach((ref, index) => write(ref, withGphc(scheme[index] ?? '', b.gphcNumber)));

  write('C159', 'Confirmed');
  write('C160', 'Confirmed');
  write('C162', meta.signerName);
  write('C163', meta.signerPosition);
  write('C164', Math.floor((meta.submittedAt.getTime() - Date.UTC(1899, 11, 30)) / 86_400_000));
  write('A2', `Holistic Health Hub partner pharmacies · Application ${meta.reference}`);

  branches = setCell(branches, 'B5', b.tradingName);
  branches = setCell(branches, 'C5', b.tradingAddress);
  branches = setCell(branches, 'D5', b.gphcNumber);
  branches = setCell(branches, 'E5', 'No');

  zip.file('xl/worksheets/sheet1.xml', sheet);
  zip.file('xl/worksheets/sheet2.xml', branches);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
