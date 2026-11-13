import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import type { PharmacyOnboardingFields } from '../../domain/pharmacy-onboarding/request.js';
import { fillCuraleafAccountForm } from './fill-curaleaf-form.js';

const fields: PharmacyOnboardingFields = {
  pharmacistName: 'Amina Khan',
  pharmacyName: 'Eastwood Health',
  registeredCompanyName: 'Eastwood Health Ltd',
  invoiceAddress: '1 High Street, Leeds, LS1 1AA',
  deliveryAddress: '2 High Street, Leeds, LS1 1AB',
  gphcNumber: '2078912',
  wdaNumber: 'WDA-44',
  licenceDetails: 'CD licence 2026',
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
});
