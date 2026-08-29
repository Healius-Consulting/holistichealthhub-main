import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ordersSource = readFileSync(new URL('../src/pages/Orders.tsx', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

test('the live order record uses one order-level Pharmacy placement rail', () => {
  assert.match(ordersSource, /<OrderPlacementRail order=\{order\}/);
  assert.match(ordersSource, /buildOrderStageRail\(order\)/);
  assert.doesNotMatch(ordersSource, /rail\.placement/);
  assert.match(ordersSource, /label="Prescription fulfilment" steps=\{rail\.dispensing\}/);
});

test('Curaleaf support controls never fall back to an HHH order reference as a PO', () => {
  assert.doesNotMatch(ordersSource, /purchaseOrderId[^\n]+\?\? orderReference/);
  assert.match(ordersSource, /No Curaleaf PO created yet/);
  assert.match(ordersSource, /Copy Curaleaf PO for prescription/);
});

test('order-list accessible names distinguish otherwise identical patients', () => {
  assert.match(ordersSource, /aria-label=\{`\$\{compactPatientName\(patientName\)\}, order \$\{listReference\}/);
  assert.match(ordersSource, /\$\{money\(workValue\)\}/);
  assert.match(ordersSource, /\$\{formatDate\(sourceOrder\.date\)\}/);
});

test('multi-prescription dialogs expose one accessible selected workflow', () => {
  assert.match(ordersSource, /function PrescriptionSwitcher/);
  assert.match(ordersSource, /role="tablist"/);
  assert.match(ordersSource, /selectedPrescriptionId/);
  assert.match(ordersSource, /selectedPrescription \? <PrescriptionCard/);
  assert.match(cssSource, /@media \(max-width: 640px\)[\s\S]+order-rx-switcher__tabs\{ display: none/);
});

test('handout confirmation is portalled above the order record stacking context', () => {
  assert.match(ordersSource, /handoutOrderId[\s\S]+createPortal\(/);
  assert.match(ordersSource, /document\.body/);
  assert.match(cssSource, /\.crm-dialog__scrim\{[\s\S]+z-index: 1400/);
  assert.match(cssSource, /\.order-handout-backdrop\{[^}]+z-index: 1500/);
});

test('the placement and prescription rails retain a compact 360px layout', () => {
  assert.match(cssSource, /@media \(max-width: 360px\)/);
  assert.match(cssSource, /order-stage-rail--placement[^{]+order-stage-rail__steps li\{ flex-basis: 50%/);
});

test('paid orders expose supplier contact without a direct cancellation escape', () => {
  assert.match(ordersSource, /Call Curaleaf to cancel/);
  assert.match(ordersSource, /Calling does not change this HHH order/);
  assert.doesNotMatch(ordersSource, /onResolve\('cancel'\)/);
  assert.doesNotMatch(ordersSource, /Curaleaf confirmed cancellation/);
});
