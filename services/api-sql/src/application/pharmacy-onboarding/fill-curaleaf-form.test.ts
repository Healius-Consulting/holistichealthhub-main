import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import type { PharmacyOnboardingFields } from '../../domain/pharmacy-onboarding/request.js';
import { LICENCE_NOT_APPLICABLE, fillCuraleafAccountForm } from './fill-curaleaf-form.js';

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
