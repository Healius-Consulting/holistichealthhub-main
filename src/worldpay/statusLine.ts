import type { WorldpayApplicationView } from '../shared/api';

/** What the pharmacy reads about its sent Worldpay application (spec §3.5). */
const londonDate = (iso: string | null) => (iso
  ? new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric' })
  : '');

export function worldpayStatusLine(view: Pick<WorldpayApplicationView, 'status' | 'submittedAt' | 'contactName' | 'contactEmail' | 'statusNote'>): string | null {
  const contact = [view.contactName, view.contactEmail ? `at ${view.contactEmail}` : ''].filter(Boolean).join(' ');
  switch (view.status) {
    case 'SUBMITTED':
    case 'WITH_WORLDPAY':
      return `Application sent on ${londonDate(view.submittedAt)}. Worldpay will contact ${contact || 'your contact'}.`;
    case 'QUERY':
      return `Worldpay have asked a question about your application: ${view.statusNote ?? ''}`.trim();
    case 'ACCOUNT_OPEN':
      return 'Your Worldpay account is open. Enter your details in Settings → Payments.';
    case 'CONNECTED':
      return 'Worldpay connected. Payment links are active.';
    case 'WITHDRAWN':
      return view.statusNote ? `This application was withdrawn: ${view.statusNote}` : 'This application was withdrawn.';
    case 'DECLINED':
      return view.statusNote ? `Worldpay declined this application: ${view.statusNote}` : 'Worldpay declined this application.';
    default:
      return null;
  }
}

