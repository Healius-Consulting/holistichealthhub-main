import assert from 'node:assert/strict';
import test from 'node:test';
import { PATIENT_PRICE_LABEL, WHOLESALE_LABEL, formatMargin } from '../src/utils/pricing.ts';

/**
 * These are the exact strings the pharmacy signed off on. They are asserted
 * literally so a well-meaning tidy-up of a label on one screen fails here
 * rather than quietly leaving the surfaces disagreeing with each other.
 */
test('the staff money vocabulary is fixed', () => {
  assert.equal(WHOLESALE_LABEL, 'Wholesale (excl. VAT)');
  assert.equal(PATIENT_PRICE_LABEL, 'Patient price');
});

test('a margin reads as signed cash with its percentage', () => {
  assert.equal(formatMargin(24.5, 100), '+£24.50 (25%)');
  assert.equal(formatMargin(0, 100), '+£0.00 (0%)');
});

test('a loss-making line is shown as a loss, not as a small win', () => {
  assert.equal(formatMargin(-12.34, 100), '−£12.34 (-12%)');
});

test('an unquoted line reads as pending rather than as zero margin', () => {
  assert.equal(formatMargin(null, 100), 'Pending');
  assert.equal(formatMargin(Number.NaN, 100), 'Pending');
});

test('a zero-revenue basis cannot produce a divide-by-zero percentage', () => {
  assert.equal(formatMargin(5, 0), '+£5.00 (0%)');
});

test('the percentage is of revenue, so dispensing-inclusive totals stay honest', () => {
  // £60 patient total (£50 medicines + £10 dispensing) against £40 wholesale.
  assert.equal(formatMargin(60 - 40, 60), '+£20.00 (33%)');
});
