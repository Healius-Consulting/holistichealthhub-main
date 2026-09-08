import JSZip from 'jszip';
import QRCode from 'qrcode';
import type { PharmacyTenant } from '../context/AppContext';
import { deriveTenantTheme } from './tenantTheme.ts';

export const DEFAULT_ELIGIBILITY_FORM_URL = 'https://holistichealthhub.live/eligibility';

export function safeEligibilityFormBase(configuredBase: string | undefined, development = import.meta.env.DEV) {
  const candidate = configuredBase?.trim() || (development ? 'http://localhost:5174/eligibility' : DEFAULT_ELIGIBILITY_FORM_URL);
  try {
    const url = new URL(candidate);
    const localDevelopmentUrl = development && url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    return url.protocol === 'https:' || localDevelopmentUrl ? url : new URL(DEFAULT_ELIGIBILITY_FORM_URL);
  } catch {
    return new URL(DEFAULT_ELIGIBILITY_FORM_URL);
  }
}

export function eligibilityUrl(referralToken: string) {
  const token = referralToken.trim();
  if (!/^[A-Za-z0-9_-]{12,160}$/.test(token)) throw new Error('A valid pharmacy eligibility token is required.');
  const url = safeEligibilityFormBase(import.meta.env.VITE_ELIGIBILITY_FORM_URL as string | undefined);
  url.searchParams.set('token', token);
  return url.toString();
}

export function assertEligibilityUrl(value: string) {
  const url = new URL(value);
  const expected = safeEligibilityFormBase(import.meta.env.VITE_ELIGIBILITY_FORM_URL as string | undefined);
  const token = url.searchParams.get('token')?.trim() ?? '';
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || !/^[A-Za-z0-9_-]{12,160}$/.test(token)) {
    throw new Error('The pharmacy eligibility link is invalid.');
  }
  return url.toString();
}

export async function qrDataUrl(formUrl: string) {
  return QRCode.toDataURL(assertEligibilityUrl(formUrl), {
    width: 720,
    margin: 2,
    errorCorrectionLevel: 'H',
    color: { dark: '#0f172a', light: '#ffffff' },
  });
}

export function downloadDataUrl(dataUrl: string, filename: string) {
  const anchor = document.createElement('a');
  anchor.href = dataUrl;
  anchor.download = filename;
  anchor.click();
}

export async function downloadContentPack(org: PharmacyTenant, formUrl: string) {
  const url = assertEligibilityUrl(formUrl);
  const qr = await qrDataUrl(url);
  const theme = deriveTenantTheme(org.brand.primary);
  const zip = new JSZip();
  const folder = zip.folder(`${org.slug}-hhh-content-pack`)!;

  folder.file('README.txt', `HHH hosted eligibility link and QR pack for ${org.name}\n\nThe eligibility form is hosted and maintained centrally by Holistic Health Hub, a trading name of Fit-Pharma Ltd (company no. 11950925), 124 City Road, London EC1V 2NX. Do not copy, recreate, iframe or embed the form on the pharmacy website.\n\nThe pharmacy website team may design any suitable information page or call-to-action, but its button/link must send patients to the exact hosted URL below. The QR image supplied in this pack points to the same URL and may be used on the website, leaflets, posters and other approved designs.\n\nEligibility URL:\n${url}\n\nDo not change or share the referral token between pharmacy organisations. Before publishing, HHH must approve the patient-facing copy.\n`);
  folder.file('eligibility-link.txt', `${url}\n`);
  folder.file('brand-palette.txt', `AUTOMATIC HHH TENANT PALETTE FOR ${org.name.toUpperCase()}\n\nPrimary: ${theme.primary}\nPrimary hover: ${theme.primaryHover}\nPrimary soft: ${theme.primarySoft}\nSecondary: ${theme.secondary}\nSecondary hover: ${theme.secondaryHover}\nSecondary soft: ${theme.secondarySoft}\nNavigation: ${theme.sidebar}\nText on primary: ${theme.onPrimary}\nText on secondary: ${theme.onSecondary}\n\nOnly the primary colour is configured by HHH. The remaining colours are generated automatically to keep the staff portal and public eligibility form consistent. Semantic success, warning and error colours are not replaced by tenant branding.\n`);
  folder.file('website-copy.txt', `Suggested heading:\nCould medical cannabis be right for you?\n\nSuggested page copy:\nOur pharmacy works with Holistic Health Hub and a specialist clinic to support eligible patients. Complete the short pre-screening form to find out whether you may qualify for a specialist consultation. Eligibility is not a diagnosis or guarantee of treatment.\n\nSuggested button label:\nCheck my eligibility\n\nButton destination (use exactly as supplied):\n${url}\n`);
  folder.file('developer-notes.txt', `IMPLEMENTATION METHOD: LINK-OUT ONLY\n\n1. Design the pharmacy information page and button in your own website system.\n2. Set the button destination to the exact URL in eligibility-link.txt.\n3. You may open the hosted form in the same tab or a new tab.\n4. Do not iframe, embed, copy, proxy or rebuild the HHH form.\n5. Do not remove or replace the token query parameter. It attributes submissions to ${org.name}.\n6. The supplied eligibility-qr.png may be placed on the website or used in approved print/digital designs.\n7. Test the final button and QR before publishing. The hosted form must display ${org.name}.\n`);
  folder.file('qr-usage-notes.txt', `The QR code opens the centrally hosted HHH eligibility form for ${org.name}.\n\nSuitable uses include pharmacy web pages, counter cards, leaflets, posters and approved digital artwork. Keep a clear white margin around the code, do not crop or distort it, and test the final artwork before publication.\n`);
  folder.file('operator-and-privacy.txt', `OPERATOR AND DATA-PROTECTION ROLES\n\nThe referral service is provided by ${org.name}, which is the controller for patient information from the moment a patient applies.\n\nHolistic Health Hub (HHH) is a trading name of Fit-Pharma Ltd, company number 11950925, registered office 124 City Road, London EC1V 2NX, ICO registration ZB639206. HHH operates the website and processes patient information on the pharmacy's behalf and under its written instructions.\n\nThe published Terms of Use (holistichealthhub.live/terms) and Privacy Notice (holistichealthhub.live/privacy) set out these roles in full. Pharmacy pages linking to the eligibility form must not restate or contradict them.\n`);
  folder.file('eligibility-qr.png', qr.split(',')[1], { base64: true });

  const blob = await zip.generateAsync({ type: 'blob' });
  const blobUrl = URL.createObjectURL(blob);
  downloadDataUrl(blobUrl, `${org.slug}-hhh-content-pack.zip`);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}
