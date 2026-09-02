import type { Screen } from '../context/AppContext';

export interface WorkspaceTourStep {
  id: string;
  screen: Screen;
  /** First matching `[data-tour="…"]` is highlighted. Missing targets still show the card. */
  targets: string[];
  title: string;
  body: string;
}

export const WORKSPACE_TOUR_STEPS: WorkspaceTourStep[] = [
  {
    id: 'overview-identity',
    screen: 'home',
    targets: ['overview-identity'],
    title: 'This is your pharmacy workspace',
    body: 'The name at the top is the pharmacy you are signed into. Live, Training, or Paused is written in words as well as colour. Overview is a summary only — open a record to act.',
  },
  {
    id: 'overview-enquiry',
    screen: 'home',
    targets: ['overview-enquiry'],
    title: 'New eligibility enquiries',
    body: 'This banner is a count, not a patient list. HHH still decides whether to refer or move the case. Open New enquiries to see who is assigned to you. Do not treat Overview as the place to accept or decline.',
  },
  {
    id: 'overview-daily',
    screen: 'home',
    targets: ['overview-daily'],
    title: 'Work that needs you today',
    body: 'Payments, aged collections, and cancellations appear here as case references. Opening a row takes you to the order or patient. You cannot take payment, refund, or message a patient from this screen.',
  },
  {
    id: 'overview-pipeline',
    screen: 'home',
    targets: ['overview-pipeline'],
    title: 'Where the rest of the queue sits',
    body: 'These totals are awaiting payment, with Curaleaf, and ready to collect. They come from the server snapshot, not from adding up lists in the browser. Use them to jump to Orders.',
  },
  {
    id: 'overview-integrations',
    screen: 'home',
    targets: ['overview-integrations'],
    title: 'Supplier and payment health',
    body: 'Curaleaf and Worldpay show connected, needs a check, unavailable, or not set up — always with words, not colour alone. Repair happens in Settings, not here.',
  },
  {
    id: 'patients-enquiries',
    screen: 'patients',
    targets: ['patients-enquiry-record', 'patients-enquiries'],
    title: 'New enquiries',
    body: 'People who chose this pharmacy on the website or used your QR code appear here at once. HHH may still move them. Referral is what marks them Referred. Orders stay locked until the workspace is live.',
  },
  {
    id: 'patients-referred',
    screen: 'patients',
    targets: ['patients-referred-record', 'patients-referred'],
    title: 'Referred until first collection',
    body: 'HHH referral creates Referred. That tag stays until the first collected dispense, even if an order is already open. You can link Referred patients on a draft; you cannot collect from Overview.',
  },
  {
    id: 'patients-active',
    screen: 'patients',
    targets: ['patients-active-record', 'patients-active'],
    title: 'Active after first collection',
    body: 'The first collected dispense makes the patient Active, accrues the £50 referral fee, and starts the anniversary year for the later fee. Collection on the order record is what changes this — not opening this list.',
  },
  {
    id: 'orders-board',
    screen: 'orders',
    targets: ['orders-board'],
    title: 'Live order lanes',
    body: 'Needs action, awaiting payment, with Curaleaf, split delivery, and ready to collect. Empty drafts with nothing to send are not work. Open a card to place, check in, or hand out.',
  },
  {
    id: 'create-order',
    screen: 'create',
    targets: ['create-order'],
    title: 'Create an order',
    body: 'Link a Referred or Active patient, then add a prescription from the Curaleaf test catalogue. Payment is shown as a preview. Worldpay, ePOS and Curaleaf placement stay locked until Curaleaf is live.',
  },
  {
    id: 'catalogue',
    screen: 'formulary',
    targets: ['catalogue'],
    title: 'Curaleaf catalogue',
    body: 'Recommended patient prices and stock come from Curaleaf. Staff do not edit the list here. Confirm exact pack prices when you quote an order.',
  },
  {
    id: 'finance',
    screen: 'finance',
    targets: ['finance'],
    title: 'Finance after collection',
    body: 'Headline figures count paid orders only once they are fully collected. Contribution uses the same ledger as this page. Overview never adds these totals up from the patient or order lists.',
  },
  {
    id: 'settings',
    screen: 'settings',
    targets: ['settings'],
    title: 'Settings and replay',
    body: 'Pharmacy details, Curaleaf customer ID, payment route, and eligibility assets live here. Replay this tour from this page whenever you need the walk-through again.',
  },
];
