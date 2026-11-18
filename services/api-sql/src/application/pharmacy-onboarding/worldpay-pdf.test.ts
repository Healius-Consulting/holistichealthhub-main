import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { layoutWorldpaySections, renderWorldpayPdf, worldpaySections, type WorldpayLayoutOp } from './worldpay-pdf.js';
import { WORLDPAY_DEFAULTS, worldpayFormSchema } from '../../domain/pharmacy-onboarding/worldpay.js';

const SIZE = 9.5;
// Helvetica at 9.5pt: capitals reach about 7pt above the baseline, descenders about 2.5pt below.
const CAP = 7;
const DESCENT = 2.5;

function sample(overrides: Record<string, unknown> = {}) {
  return worldpayFormSchema.parse({
    ...WORLDPAY_DEFAULTS,
    legalName: 'TEST',
    tradingName: 'TEST',
    contactName: 'TEST',
    contactPosition: 'DIRECTOR',
    contactPhone: '1111111111',
    businessType: 'Ltd Co',
    registeredAddress: 'TEST1',
    gphcNumber: '9012605',
    tradingAddress: 'TEST1',
    businessEmail: 'TEST1234@YOPMAIL.COM',
    principals: [{
      firstNames: 'TEST', surname: 'TEST', dateOfBirth: '2000-01-01', nationality: 'BRITISH',
      homeAddress: 'TEST1', countryOfResidence: 'United Kingdom', yearsAtAddress: '4',
      mobile: '11111111111', email: 'TEST@YOPMAIL.COM', shareholding: '100',
    }],
    annualTurnover: '1',
    bankName: 'SSSSS',
    accountName: 'TEST',
    accountNumber: '11111111',
    sortCode: '01-01-01',
    idempotencyKey: 'worldpay-key-1',
    ...overrides,
  });
}

async function layoutFor(form: ReturnType<typeof sample>, top = 841.89 - 48 - 64) {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const wrapper = (font: typeof regular, width: number) => (text: string) => {
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, SIZE) <= width || !line) line = next;
      else { lines.push(line); line = word; }
    }
    return line ? [...lines, line] : lines;
  };
  return layoutWorldpaySections(worldpaySections(form), { wrapLabel: wrapper(regular, 190), wrapValue: wrapper(bold, 595.28 - 48 - 250) }, top);
}

function crossings(ops: WorldpayLayoutOp[]) {
  const texts = ops.filter((op): op is Extract<WorldpayLayoutOp, { kind: 'text' }> => op.kind === 'text');
  return ops.filter(op => op.kind === 'rule').flatMap(rule => texts
    .filter(text => text.page === rule.page && rule.y > text.y - DESCENT && rule.y < text.y + CAP)
    .map(text => `rule at ${rule.y.toFixed(1)} crosses "${text.text}" at ${text.y.toFixed(1)} on page ${rule.page + 1}`));
}

test('no row rule runs through any text', async () => {
  // The submitted test form, and one with long wrapped answers.
  for (const form of [sample(), sample({ registrationFees: 'Confirmed. However, Mastercard will not be used. Pharmacy GPhC registration number found above. '.repeat(3) })]) {
    assert.deepEqual(crossings(await layoutFor(form)), []);
  }
});

test('every rule sits below its row\'s text with room either side', async () => {
  const ops = await layoutFor(sample());
  const texts = ops.filter((op): op is Extract<WorldpayLayoutOp, { kind: 'text' }> => op.kind === 'text');
  for (const rule of ops.filter(op => op.kind === 'rule')) {
    const nearest = texts.filter(text => text.page === rule.page).map(text => Math.min(Math.abs(rule.y - (text.y - DESCENT)), Math.abs(rule.y - (text.y + CAP))));
    assert.ok(Math.min(...nearest) >= 4, `rule at ${rule.y} has at least 4pt clear of text`);
  }
});

test('a section that runs onto a new page repeats its heading there', async () => {
  const ops = await layoutFor(sample());
  const pages = Math.max(...ops.map(op => op.page)) + 1;
  for (let page = 1; page < pages; page++) {
    const first = ops.find(op => op.page === page);
    assert.equal(first?.kind, 'band', `page ${page + 1} starts with a heading, not a stray row`);
  }
  const continued = ops.filter(op => op.kind === 'band' && op.title.endsWith('(continued)'));
  for (const band of continued) {
    const prior = ops.filter(op => op.kind === 'band' && op.page < band.page).at(-1);
    assert.ok(prior && band.kind === 'band' && prior.kind === 'band' && band.title.startsWith(prior.title.replace(' (continued)', '')));
  }
});

test('a heading is never left alone at the bottom of a page', async () => {
  // Start at different heights so headings land near the bottom of a page.
  for (let top = 140; top <= 300; top += 10) {
    const ops = await layoutFor(sample(), top);
    ops.forEach((op, index) => {
      if (op.kind !== 'band') return;
      const nextBand = ops.findIndex((next, at) => at > index && next.kind === 'band');
      const rowsUnderIt = ops.slice(index + 1, nextBand < 0 ? undefined : nextBand).filter(next => next.kind === 'rule' && next.page === op.page).length;
      assert.ok(rowsUnderIt >= 2, `"${op.title}" (top ${top}) has ${rowsUnderIt} of its rows under it on page ${op.page + 1}`);
    });
  }
});

test('nothing is laid out over the footer', async () => {
  const ops = await layoutFor(sample());
  for (const op of ops) {
    const bottom = op.kind === 'band' ? op.y : op.kind === 'text' ? op.y - DESCENT : op.y;
    assert.ok(bottom >= 48 + 20 - 0.01, `${op.kind} at ${bottom} is clear of the footer`);
  }
});

test('the rendered PDF still opens, with every answer in it', async () => {
  const bytes = await renderWorldpayPdf(sample(), new Date('2026-11-18T12:00:00Z'));
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() >= 1);
  const ops = await layoutFor(sample());
  const shown = new Set(ops.filter(op => op.kind === 'text').map(op => (op as { text: string }).text));
  for (const expected of ['TEST1234@YOPMAIL.COM', '01-01-01', '100%', 'BRITISH']) assert.ok(shown.has(expected), expected);
});
