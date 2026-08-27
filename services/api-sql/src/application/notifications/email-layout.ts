export const EMAIL_PUBLIC_ORIGIN = 'https://holistichealthhub.live';

export const EMAIL_CID = {
  header: 'email-header-logo',
  hhh: 'email-hhh-logo',
  curaleaf: 'email-curaleaf-logo',
} as const;

const PHARMACY_HEADER_LOGOS = [
  {
    ids: ['6d0176bb-89a0-4e32-9bce-c934c9557c42'],
    names: ['eastwood'],
    assetFile: 'eastwood-health-logo.png',
    width: 240,
    height: 22,
  },
  {
    ids: ['3e9f74ff-4fed-497d-904d-4d3ee3e5e126'],
    names: ['k-chem', 'kchem'],
    assetFile: 'k-chem-logo.png',
    width: 150,
    height: 100,
  },
] as const;

export type EmailHeader = {
  logoUrl: string;
  logoAlt: string;
  width: number;
  height: number;
  fallbackText: string;
  assetFile?: string;
};

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character] ?? character));
}

export function safeHttpUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString();
  } catch {
    return '';
  }
  return '';
}

function imageSrc(value: string) {
  if (/^cid:[a-z0-9.-]+$/i.test(value)) return value;
  return safeHttpUrl(value);
}

export function resolveEmailHeader(input: {
  audience: 'admin' | 'pharmacy';
  organisationId?: string;
  pharmacyName?: string;
}): EmailHeader {
  if (input.audience === 'admin') {
    return {
      logoUrl: `cid:${EMAIL_CID.hhh}`,
      logoAlt: 'Holistic Health Hub',
      width: 240,
      height: 45,
      fallbackText: 'Holistic Health Hub',
      assetFile: 'hhh-logo.png',
    };
  }
  const organisationId = (input.organisationId || '').toLowerCase();
  const pharmacyName = (input.pharmacyName || '').trim();
  const key = pharmacyName.toLowerCase();
  const match = PHARMACY_HEADER_LOGOS.find(item => (
    (item.ids as readonly string[]).includes(organisationId)
    || item.names.some(name => key.includes(name))
  ));
  return {
    logoUrl: match ? `cid:${EMAIL_CID.header}` : '',
    logoAlt: pharmacyName || 'Pharmacy',
    width: match?.width || 190,
    height: match?.height || 90,
    fallbackText: pharmacyName || 'the pharmacy',
    assetFile: match?.assetFile,
  };
}

function detailRows(details: Array<{ label: string; value: string }>) {
  return details.filter(item => item.value).map((item, index, items) =>
    `<p style="margin:0 0 ${index === items.length - 1 ? '0' : '8px'}; color:#31413d; font-size:16px; line-height:24px;"><strong>${escapeHtml(item.label)}:</strong> ${escapeHtml(item.value)}</p>`
  ).join('');
}

export function brandedEmail(input: {
  preheader: string;
  eyebrow?: string;
  title: string;
  paragraphs: string[];
  highlight?: { label: string; value: string };
  cta?: { label: string; href: string };
  detailsTitle?: string;
  details?: Array<{ label: string; value: string }>;
  nextSteps?: string[];
  footerNote?: string;
  header: EmailHeader;
}) {
  const paragraphs = input.paragraphs.filter(Boolean).map((paragraph, index, items) =>
    `<p style="margin:0 0 ${index === items.length - 1 ? '28px' : '12px'}; color:#2f3c39; font-size:19px; line-height:31px;">${paragraph}</p>`
  ).join('');
  const href = input.cta ? safeHttpUrl(input.cta.href) : '';
  const logoUrl = imageSrc(input.header.logoUrl);
  const headerMark = logoUrl
    ? `<img src="${escapeHtml(logoUrl)}" width="${input.header.width}" height="${input.header.height}" alt="${escapeHtml(input.header.logoAlt)}" style="width:${input.header.width}px; height:${input.header.height}px; max-width:100%; object-fit:contain; object-position:center; border:0; display:block;">`
    : `<p style="margin:0; color:#dce9e5; font-family:Arial, Helvetica, sans-serif; font-size:22px; line-height:28px; font-weight:700;">${escapeHtml(input.header.fallbackText)}</p>`;
  const highlight = input.highlight?.value
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; margin:0 0 24px; border:1px solid #d7e0de; border-radius:18px; background:#f6fbfa;"><tr><td style="padding:26px;"><p style="margin:0 0 8px; color:#5c6864; font-size:12px; line-height:16px; font-weight:700; letter-spacing:1.6px; text-transform:uppercase;">${escapeHtml(input.highlight.label)}</p><p style="margin:0; color:#1d2321; font-size:42px; line-height:46px; font-weight:700;">${escapeHtml(input.highlight.value)}</p></td></tr></table>`
    : '';
  const cta = href
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; margin:0 0 24px;"><tr><td align="center" bgcolor="#1baa92" style="border-radius:10px; background:#1baa92;"><a href="${escapeHtml(href)}" target="_blank" style="display:block; padding:18px 24px; border:1px solid #149b84; border-radius:10px; color:#ffffff; font-family:Arial, Helvetica, sans-serif; font-size:18px; line-height:22px; font-weight:700; text-align:center; text-decoration:none;">${escapeHtml(input.cta!.label)}</a></td></tr></table>`
    : '';
  const details = detailRows(input.details ?? []);
  const detailsBlock = details
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; margin:0 0 24px; border:1px solid #d7e0de; border-radius:18px; background:#f6fbfa;"><tr><td style="padding:24px 26px;">${input.detailsTitle ? `<p style="margin:0 0 12px; color:#1f2725; font-size:18px; line-height:24px; font-weight:700;">${escapeHtml(input.detailsTitle)}</p>` : ''}${details}</td></tr></table>`
    : '';
  const nextSteps = (input.nextSteps ?? []).filter(Boolean).map((step, index, items) =>
    `<tr><td style="padding:0 26px ${index === items.length - 1 ? '24px' : '8px'}; color:#34423f; font-size:16px; line-height:24px;">${index + 1}. ${escapeHtml(step)}</td></tr>`
  ).join('');
  const nextStepsBlock = nextSteps
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; margin:0 0 24px; border:1px solid #e1e8e6; border-radius:18px; background:#ffffff;"><tr><td style="padding:24px 26px 10px;"><p style="margin:0; color:#1f2725; font-size:18px; line-height:24px; font-weight:700;">What happens next</p></td></tr>${nextSteps}</table>`
    : '';
  const footerNote = input.footerNote
    ? `<p style="margin:0; color:#5a6662; font-size:15px; line-height:24px;">${input.footerNote}</p>`
    : '';
  const eyebrow = input.eyebrow
    ? `<p style="margin:0 0 14px; color:#148c77; font-size:12px; line-height:16px; font-weight:700; letter-spacing:1.8px; text-transform:uppercase;">${escapeHtml(input.eyebrow)}</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="supported-color-schemes" content="light">
</head>
<body style="margin:0; padding:0; background:#f3f8f7;">
  <div style="display:none; max-height:0; overflow:hidden; opacity:0; color:transparent;">${escapeHtml(input.preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; background:#f3f8f7;">
    <tr>
      <td align="center" style="padding:40px 18px;">
        <table role="presentation" width="640" cellspacing="0" cellpadding="0" border="0" style="width:100%; max-width:640px; overflow:hidden; background:#fdfefd; border:1px solid #d9e2e0; border-radius:16px;">
          <tr>
            <td align="center" style="padding:48px 42px; border-bottom:1px solid #0f342c; background:#123f36;">
              ${headerMark}
            </td>
          </tr>
          <tr>
            <td style="padding:54px 48px 46px; font-family:Arial, Helvetica, sans-serif; color:#1f2725; background:#fcfdfc;">
              ${eyebrow}
              <h1 style="margin:0 0 16px; color:#1d2321; font-size:44px; line-height:50px; letter-spacing:-1.6px; font-weight:700;">${escapeHtml(input.title)}</h1>
              ${paragraphs}
              ${highlight}
              ${cta}
              ${detailsBlock}
              ${nextStepsBlock}
              ${footerNote}
            </td>
          </tr>
          <tr>
            <td align="center" bgcolor="#123f36" style="padding:34px 32px 40px; background:#123f36; font-family:Arial, Helvetica, sans-serif;">
              <p style="margin:0 0 10px; color:#dce9e5; font-size:11px; line-height:14px; font-weight:700; letter-spacing:2.4px; text-transform:uppercase;">Powered by</p>
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center">
                <tr>
                  <td valign="middle" align="center" style="height:56px;">
                    <img src="cid:${EMAIL_CID.hhh}" width="180" height="34" alt="Holistic Health Hub" style="width:180px; height:34px; max-width:100%; object-fit:contain; object-position:center; border:0; display:block;">
                  </td>
                  <td valign="middle" align="center" style="padding:0 16px; color:#ffffff; font-size:24px; font-weight:300; height:56px;">&times;</td>
                  <td valign="middle" align="center" style="height:56px;">
                    <img src="cid:${EMAIL_CID.curaleaf}" width="168" height="56" alt="Curaleaf Clinic" style="width:168px; height:56px; max-width:100%; object-fit:contain; object-position:center; border:0; display:block;">
                  </td>
                </tr>
              </table>
              <p style="margin:18px 0 0; color:#9fb4af; font-size:12px; line-height:18px;">This mailbox is not monitored.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
