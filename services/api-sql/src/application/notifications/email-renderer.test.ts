import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isEmailTemplateCode, isPatientMessageKind, messageIdempotencyKey } from './message-kinds.js';
import { renderEmailTemplate } from './email-renderer.js';

describe('email template kinds', () => {
  it('recognises supported template codes', () => {
    assert.equal(isEmailTemplateCode('patient_referred'), true);
    assert.equal(isEmailTemplateCode('patient_payment_confirmation'), true);
    assert.equal(isEmailTemplateCode('patient_refunded'), true);
    assert.equal(isEmailTemplateCode('pharmacy_2fa_enabled'), true);
    assert.equal(isEmailTemplateCode('pharmacy_2fa_disabled'), true);
    assert.equal(isEmailTemplateCode('pharmacy_order_dispatched'), true);
    assert.equal(isEmailTemplateCode('nope'), false);
  });

  it('keeps patient template recognition narrow', () => {
    assert.equal(isPatientMessageKind('patient_referred'), true);
    assert.equal(isPatientMessageKind('patient_ready_for_collection'), true);
    assert.equal(isPatientMessageKind('patient_refunded'), true);
    assert.equal(isPatientMessageKind('pharmacy_payment_received'), false);
  });

  it('builds deterministic idempotency keys', () => {
    assert.equal(messageIdempotencyKey(['a', 1, 'b']), 'a:1:b');
  });
});

describe('email template renderer', () => {
  it('renders the patient referral introduction', () => {
    const rendered = renderEmailTemplate('patient_referred', {
      firstName: 'Avery',
      pharmacyName: 'Eastwood Health',
      pharmacyPhone: '01522 000 000',
      pharmacyGphcNumber: '9010203',
      pharmacyEmail: 'contact@eastwoodhealthpharmacy.co.uk',
      pharmacyAddress: 'Nottinghamshire',
    });
    assert.equal(rendered.subject, 'Eastwood Health: Your referral — what happens next');
    assert.match(rendered.text, /Curaleaf Clinic/);
    assert.match(rendered.text, /within two working days/i);
    assert.match(rendered.html, /Eastwood Health/);
    assert.match(rendered.html, /01522 000 000/);
    assert.match(rendered.html, /GPhC 9010203/);
    assert.doesNotMatch(rendered.html, /Avery Patel/);
  });

  it('closes an enquiry without repeating the reason back to the patient', () => {
    const rendered = renderEmailTemplate('patient_enquiry_declined', {
      firstName: 'Avery',
      variant: 'declined',
      pharmacyName: 'Eastwood Health',
      pharmacyPhone: '01522 000 000',
      pharmacyGphcNumber: '9010203',
    });
    assert.equal(rendered.subject, 'Eastwood Health: Your referral enquiry');
    assert.match(rendered.text, /not able to refer you/);
    assert.match(rendered.text, /It is not a diagnosis/);
    assert.match(rendered.text, /NHS 111/);
    // The subject is visible on a lock screen, so it must not say what was declined.
    assert.doesNotMatch(rendered.subject, /cannabis|psychosis|schizophrenia|eligib/i);
    assert.doesNotMatch(rendered.text, /psychosis|schizophrenia/i);
  });

  it('tells a patient who did not reply that nothing was decided', () => {
    const rendered = renderEmailTemplate('patient_enquiry_declined', {
      firstName: 'Avery',
      variant: 'incomplete',
      pharmacyName: 'Eastwood Health',
    });
    assert.match(rendered.text, /have not heard back/);
    assert.match(rendered.text, /Nothing has been decided about your eligibility/);
    assert.doesNotMatch(rendered.text, /not able to refer you/);
  });

  it('answers a withdrawal as the patient own decision', () => {
    const rendered = renderEmailTemplate('patient_enquiry_declined', {
      firstName: 'Avery',
      variant: 'withdrawn',
      pharmacyName: 'Eastwood Health',
    });
    assert.match(rendered.text, /As you asked/);
    assert.doesNotMatch(rendered.text, /not able to refer you/);
  });

  it('signs an unassigned enquiry as HHH rather than "the pharmacy"', () => {
    const rendered = renderEmailTemplate('patient_enquiry_declined', {
      firstName: 'Avery',
      variant: 'declined',
      pharmacyName: 'the pharmacy',
    });
    assert.equal(rendered.subject, 'Holistic Health Hub: Your referral enquiry');
    assert.doesNotMatch(rendered.text, /the pharmacy: /);
  });

  it('gives the pharmacy the referred patient, not a row id', () => {
    const rendered = renderEmailTemplate('pharmacy_new_patient_referred', {
      pharmacyName: 'Eastwood Health Pharmacy',
      caseReference: 'HHH-20260908-A1B2C3D4',
      firstName: 'Avery',
      surname: 'Mitchell',
      dob: '1988-03-14',
      mobile: '07700 900123',
      email: 'avery.mitchell@example.test',
    });
    assert.match(rendered.subject, /Avery Mitchell/);
    assert.match(rendered.text, /HHH-20260908-A1B2C3D4/);
    // Written the way the pharmacy stores a date of birth, so it can be checked against their record.
    assert.match(rendered.text, /14\/03\/1988/);
    assert.match(rendered.text, /07700 900123/);
    assert.match(rendered.html, /avery\.mitchell@example\.test/);
    // A UUID reaching the pharmacy is the bug this replaced.
    assert.doesNotMatch(rendered.text, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i);
  });

  it('renders a patient payment confirmation', () => {
    const rendered = renderEmailTemplate('patient_payment_confirmation', {
      firstName: 'Avery',
      amountPence: 12500,
      medicineTotalPence: 10_000,
      dispensingFeePence: 500,
      pharmacyDeliveryPence: 2_000,
      currency: 'GBP',
      orderNumber: 'ORD-123',
      receiptHash: 'a'.repeat(64),
      pharmacyName: 'Eastwood Health',
      organisationId: '6d0176bb-89a0-4e32-9bce-c934c9557c42',
      hasBrandLogo: 'true',
    });
    assert.match(rendered.subject, /Payment received/);
    assert.match(rendered.text, /Avery/);
    assert.match(rendered.html, /ORD-123/);
    assert.match(rendered.html, /Medicine/);
    assert.match(rendered.html, /Dispensing Cost/);
    assert.match(rendered.html, /Pharmacy Delivery/);
    assert.match(rendered.html, /cid:email-header-logo/);
    assert.match(rendered.html, /cid:email-curaleaf-logo/);
    assert.match(rendered.html, /Powered by/);
    assert.match(rendered.html, /View receipt/);
    assert.match(rendered.html, /holistichealthhub\.live\/receipt\/a{64}/);
  });

  it('sets the pharmacy name in type when no logo has been uploaded', () => {
    const rendered = renderEmailTemplate('patient_payment_confirmation', {
      firstName: 'Avery',
      amountPence: 12500,
      orderNumber: 'ORD-123',
      pharmacyName: 'Eastwood Health',
      organisationId: '6d0176bb-89a0-4e32-9bce-c934c9557c42',
    });
    // No pharmacy logo ships with the repository, so a known organisation id alone
    // must never produce one.
    assert.doesNotMatch(rendered.html, /cid:email-header-logo/);
    assert.match(rendered.html, /Eastwood Health/);
  });

  it('renders a pharmacy dispatch update', () => {
    const rendered = renderEmailTemplate('pharmacy_order_dispatched', {
      orderNumber: 'ORD-456',
      summary: 'A partial order has been dispatched.',
    });
    assert.match(rendered.subject, /Order dispatched update/);
    assert.match(rendered.text, /partial order/);
    assert.match(rendered.html, /ORD-456/);
  });

  it('renders patient payment awaiting, refunded, and ready emails', () => {
    const request = renderEmailTemplate('patient_payment_request', {
      firstName: 'Avery',
      amountPence: 8900,
      medicineTotalPence: 8_900,
      dispensingFeePence: 0,
      pharmacyDeliveryPence: 0,
      currency: 'GBP',
      orderNumber: 'ORD-890',
      paymentUrl: 'https://payments.example/pay',
      pharmacyName: 'North Pharmacy',
    });
    assert.match(request.subject, /Payment needed/);
    assert.match(request.html, /Pay now/);
    assert.match(request.html, /https:\/\/payments\.example\/pay/);
    assert.match(request.html, /ORD-890/);
    assert.doesNotMatch(request.html, /Dispensing Cost/);
    assert.doesNotMatch(request.html, /Pharmacy Delivery/);

    const legacyRequest = renderEmailTemplate('patient_payment_request', {
      firstName: 'Avery',
      amountPence: 9_500,
      medicineTotalPence: 8_500,
      dispensingFeePence: 500,
      pharmacyDeliveryPence: 0,
      currency: 'GBP',
      orderNumber: 'ORD-950',
      paymentUrl: 'https://payments.example/pay-legacy',
    });
    assert.match(legacyRequest.html, /Order reference/);
    assert.match(legacyRequest.html, /ORD-950/);
    assert.match(legacyRequest.html, /Delivery/);
    assert.match(legacyRequest.html, /£5\.00/);

    const refunded = renderEmailTemplate('patient_refunded', {
      firstName: 'Avery',
      amountPence: 8900,
      currency: 'GBP',
      orderNumber: 'ORD-890',
      receiptHash: 'b'.repeat(64),
    });
    assert.match(refunded.subject, /refunded/);
    assert.match(refunded.html, /ORD-890/);
    assert.match(refunded.html, /View receipt/);
    assert.match(refunded.html, /holistichealthhub\.live\/receipt\/b{64}/);
    assert.match(refunded.text, /Receipt: https:\/\/holistichealthhub\.live\/receipt\/b{64}/);

    const ready = renderEmailTemplate('patient_ready_for_collection', {
      firstName: 'Avery',
      orderNumber: 'ORD-890',
      pharmacyName: 'North Pharmacy',
    });
    assert.match(ready.subject, /ready to collect/);
    assert.match(ready.html, /North Pharmacy/);

    const partialReady = renderEmailTemplate('patient_ready_for_collection', {
      firstName: 'Avery',
      orderNumber: 'ORD-891',
      pharmacyName: 'North Pharmacy',
      readyPacks: 2,
      totalPacks: 5,
      partialReady: true,
    });
    assert.match(partialReady.subject, /Part of your prescription/);
    assert.match(partialReady.html, /2 of 5 packs/);
    assert.match(partialReady.html, /remaining packs are not ready yet/i);
    assert.doesNotMatch(partialReady.text, /Your order ORD-891 is ready to collect/);
  });

  it('renders staff signup, reset, and 2FA emails', () => {
    const invite = renderEmailTemplate('pharmacy_staff_invite', {
      pharmacyName: 'North Pharmacy',
      actionLink: 'https://portal.holistichealthhub.cc/reset-password?oobCode=invite',
    });
    assert.match(invite.subject, /Set up your Holistic Health Hub account/);
    assert.match(invite.html, /Set your password/);
    assert.match(invite.html, /This mailbox is not monitored/);

    const reset = renderEmailTemplate('pharmacy_password_reset', {
      actionLink: 'https://portal.holistichealthhub.cc/reset-password?oobCode=reset',
    });
    assert.match(reset.subject, /Reset your Holistic Health Hub password/);
    assert.match(reset.html, /Reset password/);

    const enabled = renderEmailTemplate('pharmacy_2fa_enabled', {});
    assert.match(enabled.subject, /Authenticator app added/);
    assert.match(enabled.html, /six-digit code/);

    const disabled = renderEmailTemplate('pharmacy_2fa_disabled', {});
    assert.match(disabled.subject, /Authenticator app removed/);
    assert.match(disabled.html, /set it up again/);
  });

  it('escapes interpolated HTML and drops non-http CTAs', () => {
    const rendered = renderEmailTemplate('patient_payment_request', {
      firstName: '<script>alert(1)</script>',
      orderNumber: 'ORD-1',
      paymentUrl: 'javascript:alert(1)',
    });
    assert.equal(rendered.html.includes('<script>alert(1)</script>'), false);
    assert.match(rendered.html, /&lt;script&gt;/);
    assert.equal(rendered.html.includes('javascript:alert'), false);
    assert.equal(rendered.html.includes('Pay now'), false);
  });

  it('shows full enquiry contact details', () => {
    const rendered = renderEmailTemplate('admin_new_enquiry_received', {
      firstName: 'Avery',
      surname: 'Patel',
      mobile: '07700900000',
      email: 'avery@example.com',
      caseReference: 'HHH-20260819-ABCDEF12',
      provisionalPharmacyName: 'Eastwood Health',
      sourceType: 'PHARMACY_QR',
    });
    assert.match(rendered.subject, /New enquiry received/);
    assert.match(rendered.html, /Avery Patel/);
    assert.match(rendered.html, /07700900000/);
    assert.match(rendered.html, /avery@example.com/);
    assert.match(rendered.html, /HHH-20260819-ABCDEF12/);
    assert.doesNotMatch(rendered.html, /A\*{4}/);
    assert.doesNotMatch(rendered.text, /masked/i);
    assert.match(rendered.html, /Open the portal/);
    assert.match(rendered.html, /cid:email-hhh-logo/);
    assert.match(rendered.html, /cid:email-curaleaf-logo/);
  });

  it('notifies the assigned pharmacy without patient contact details', () => {
    const rendered = renderEmailTemplate('pharmacy_new_enquiry_assigned', {
      pharmacyName: 'Eastwood Health',
      caseReference: 'HHH-20260819-ABCDEF12',
    });
    assert.match(rendered.subject, /New enquiry assigned/);
    assert.match(rendered.html, /HHH-20260819-ABCDEF12/);
    assert.match(rendered.html, /Eastwood Health/);
    assert.doesNotMatch(rendered.html, /07700900000/);
    assert.doesNotMatch(rendered.html, /avery@example.com/);
  });

  it('notifies the assigned pharmacy when HHH declines an enquiry', () => {
    const rendered = renderEmailTemplate('pharmacy_enquiry_declined', {
      pharmacyName: 'Eastwood Health',
      caseReference: 'HHH-20260819-ABCDEF12',
    });
    assert.match(rendered.subject, /declined/i);
    assert.match(rendered.html, /HHH-20260819-ABCDEF12/);
    assert.doesNotMatch(rendered.html, /07700900000/);
  });
});
