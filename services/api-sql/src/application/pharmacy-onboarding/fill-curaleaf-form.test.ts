import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { PharmacyOnboardingFields } from '../../domain/pharmacy-onboarding/request.js';
import { CURALEAF_CELLS, CURALEAF_LICENCE_LINES, CURALEAF_LICENCE_X, LICENCE_NOT_APPLICABLE, fillCuraleafAccountForm, layoutCuraleafForm, wrapAddress } from './fill-curaleaf-form.js';

/** Every string drawn on the page, read back from the content stream. */
async function drawnText(pdf: Buffer) {
  const document = await PDFDocument.load(pdf);
  const page = document.getPages()[0]!;
  const contents = page.node.Contents();
  const streams = contents && 'asArray' in contents ? (contents as unknown as { asArray(): unknown[] }).asArray() : [contents];
  const { inflateSync } = await import('node:zlib');
  const text: string[] = [];
  for (const ref of streams) {
    const stream = document.context.lookup(ref as never) as unknown as { getContents(): Uint8Array; dict: { toString(): string } };
    let bytes = Buffer.from(stream.getContents());
    if (/FlateDecode/.test(stream.dict.toString())) bytes = inflateSync(bytes);
    for (const match of bytes.toString('latin1').matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      text.push(Buffer.from(match[1]!, 'hex').toString('latin1'));
    }
  }
  return text;
}

const fields: PharmacyOnboardingFields = {
  pharmacistName: 'Amina Khan',
  pharmacyName: 'Eastwood Health',
  registeredCompanyName: 'Eastwood Health Ltd',
  invoiceAddress: '1 High Street, Leeds, LS1 1AA',
  deliveryAddress: '2 High Street, Leeds, LS1 1AB',
  gphcNumber: '2078912',
  pharmacyEmail: 'pharmacy@eastwood.test',
  accountsEmail: 'accounts@eastwood.test',
  pharmacyPhone: '0113 000 0000',
  accountsPhone: '0113 000 0001',
  faxNumber: '',
  signatureName: 'Amina Khan',
  idempotencyKey: 'idempotency-key-1',
};

describe('fillCuraleafAccountForm', () => {
  it('stamps the pharmacy answers onto the existing Curaleaf form', async () => {
    const pdf = await fillCuraleafAccountForm(fields, new Date('2026-11-13T12:00:00.000Z'));
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    const document = await PDFDocument.load(pdf);
    assert.equal(document.getPageCount(), 1);
    const page = document.getPages()[0];
    assert.ok(page);
    assert.ok((page.getWidth() ?? 0) > 500);
  });

  it('prints the licence lines as not applicable, ignoring any licence numbers sent', async () => {
    // An older onboarding page may still send licence numbers; they never reach the PDF.
    const stray = { ...fields, wdaNumber: 'WDA-44', licenceDetails: 'CD licence 2026' } as PharmacyOnboardingFields;
    const text = await drawnText(await fillCuraleafAccountForm(stray, new Date('2026-11-13T12:00:00.000Z')));
    const wording = Buffer.from(LICENCE_NOT_APPLICABLE.replace('\u2014', '\x97'), 'latin1').toString('latin1');
    assert.equal(text.filter(line => line === wording).length, 2);
    assert.equal(text.some(line => line.includes('WDA-44') || line.includes('CD licence 2026')), false);
    assert.ok(text.includes('Eastwood Health'));
  });
});

describe('layoutCuraleafForm', () => {
  const SIZE = 10;
  const CAP = 7.18;
  const DESCENT = 2.2;
  async function measures() {
    const pdf = await PDFDocument.create();
    const regular = await pdf.embedFont(StandardFonts.Helvetica);
    const script = await pdf.embedFont(StandardFonts.TimesRomanItalic);
    return { regular: (text: string, size: number) => regular.widthOfTextAtSize(text, size), script: (text: string, size: number) => script.widthOfTextAtSize(text, size) };
  }
  const long = {
    ...fields,
    pharmacyName: 'Eastwood Health Community Pharmacy and Wellbeing Centre of Excellence Headingley',
    invoiceAddress: 'Unit 4, Riverside Business Park, 112 Kirkstall Road, Leeds, West Yorkshire, LS3 1HS',
    deliveryAddress: 'The Old Bank Buildings, Second Floor Rear Entrance via Car Park, 2 High Street, Headingley, Leeds, West Yorkshire, LS6 3AB, United Kingdom',
    pharmacyEmail: 'a.very.long.pharmacy.inbox.address.for.the.whole.group@eastwood-health-and-wellbeing.co.uk',
  };

  it('keeps every answer inside its cell and clear of the cell edges', async () => {
    for (const input of [fields, long]) {
      const { texts } = layoutCuraleafForm(input, new Date('2026-11-18T12:00:00Z'), await measures());
      for (const text of texts.filter(each => each.font === 'regular' && each.y > 243 && each.x === 180)) {
        const cell = Object.values(CURALEAF_CELLS).find(each => text.y > each.bottom && text.y < each.top);
        assert.ok(cell, `"${text.text}" sits in a cell`);
        assert.ok(text.y + CAP <= cell.top - 3 && text.y - DESCENT >= cell.bottom + 3, `"${text.text}" is clear of its cell edges`);
        assert.ok(text.x + (await measures()).regular(text.text, SIZE) <= 545.9 - 8, `"${text.text}" fits the cell width`);
      }
    }
  });

  it('centres each answer vertically in its cell', async () => {
    const { texts } = layoutCuraleafForm(fields, new Date('2026-11-18T12:00:00Z'), await measures());
    for (const [name, cell] of Object.entries(CURALEAF_CELLS)) {
      const inCell = texts.filter(text => text.y > cell.bottom && text.y < cell.top && text.font === 'regular' && text.x === 180);
      if (!inCell.length) continue;
      const top = Math.max(...inCell.map(text => text.y)) + CAP;
      const bottom = Math.min(...inCell.map(text => text.y));
      assert.ok(Math.abs((cell.top - top) - (bottom - cell.bottom)) < 1, `${name} is centred`);
    }
  });

  it('writes the licence answers in place of the printed underlines, lined up', async () => {
    const { texts, covers } = layoutCuraleafForm(fields, new Date('2026-11-18T12:00:00Z'), await measures());
    for (const line of CURALEAF_LICENCE_LINES) {
      const cover = covers.find(each => each.y < line.baseline && each.y + each.height > line.baseline - 3);
      assert.ok(cover && cover.x <= line.underline.left && cover.x + cover.width >= line.underline.right, `${line.key} underline is covered`);
      const answer = texts.find(text => text.y === line.baseline);
      assert.equal(answer?.x, CURALEAF_LICENCE_X, `${line.key} answer starts on the shared edge`);
    }
    assert.deepEqual(texts.filter(text => CURALEAF_LICENCE_LINES.some(line => line.baseline === text.y)).map(text => text.text), [fields.gphcNumber, LICENCE_NOT_APPLICABLE, LICENCE_NOT_APPLICABLE]);
  });

  it('breaks addresses between their parts, never inside a postcode', async () => {
    const m = await measures();
    const lines = wrapAddress('Unit 4, Riverside Business Park, 112 Kirkstall Road, Leeds, West Yorkshire, LS3 1HS', m.regular, SIZE, 545.9 - 8.8 - 180, 6);
    assert.ok(lines.length >= 2);
    assert.ok(lines.some(line => line.endsWith('LS3 1HS')), lines.join(' | '));
    for (const line of lines.slice(0, -1)) assert.ok(line.endsWith(','), `"${line}" ends at a comma`);
    const capped = wrapAddress(long.deliveryAddress.repeat(3), m.regular, SIZE, 100, 3);
    assert.equal(capped.length, 3);
    assert.ok(capped[2]!.endsWith('…'), 'an address too long for the cell is shortened visibly');
  });
});
