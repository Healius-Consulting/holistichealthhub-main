import assert from 'node:assert/strict';
import test from 'node:test';
import { pharmacyFieldErrors, pharmacyFieldSummary, pharmacyLogoText } from '../src/utils/pharmacyFormErrors.ts';

test('server issues land on the box they belong to', () => {
  const { fields, unplaced } = pharmacyFieldErrors([
    { path: 'gphcNumber', message: 'String must contain at least 3 character(s)' },
    { path: 'websiteDomains.2', message: 'Too long' },
    { path: 'pharmacyEmail', message: 'Invalid email' },
  ]);
  assert.deepEqual(Object.keys(fields).sort(), ['gphcNumber', 'pharmacyEmail', 'websiteDomains']);
  assert.match(fields.gphcNumber ?? '', /GPhC number/);
  assert.deepEqual(unplaced, []);
});

test('fields with no box of their own point at the box they are built from', () => {
  const { fields } = pharmacyFieldErrors([
    { path: 'logoText', message: 'Invalid' },
    { path: 'address', message: 'Too short' },
  ]);
  assert.ok(fields.name);
  assert.ok(fields.addressLine1);
});

test('issues that match no box are kept for the banner', () => {
  const { fields, unplaced } = pharmacyFieldErrors([{ path: '', message: 'At least one pharmacy detail must be supplied.' }]);
  assert.deepEqual(fields, {});
  assert.deepEqual(unplaced, ['At least one pharmacy detail must be supplied.']);
});

test('the banner names the highlighted boxes in form order', () => {
  const { fields } = pharmacyFieldErrors([
    { path: 'postcode', message: 'x' },
    { path: 'gphcNumber', message: 'x' },
  ]);
  assert.equal(pharmacyFieldSummary(fields), 'Check the highlighted fields: GPhC number, Postcode.');
  assert.equal(pharmacyFieldSummary({}), '');
});

test('workspace initials are letters and digits only', () => {
  assert.equal(pharmacyLogoText('K & J Pharmacy'), 'KJ');
  assert.equal(pharmacyLogoText('Boots - Brighton'), 'BB');
  assert.equal(pharmacyLogoText('(Hartwell) Chemists'), 'HC');
  assert.equal(pharmacyLogoText('& -', 'EW'), 'EW');
});
