export const EMAIL_PUBLIC_ORIGIN = 'https://holistichealthhub.live';

export const EMAIL_CID = {
  header: 'email-header-logo',
  hhh: 'email-hhh-logo',
  curaleaf: 'email-curaleaf-logo',
} as const;

/*
 * Footer lockup sizing, matched on visible ink rather than on canvas.
 *
 * curaleaf-clinic-white.png is 504x167 with 17px of transparent padding top and
 * bottom, so its ink box is 504x133 — 79% of the canvas height. hhh-logo.png is
 * 300x56 with an ink box of 297x54, or 96%. Sizing the two canvases to the same
 * height therefore renders the Curaleaf mark about 37% larger than the HHH one,
 * which reads as the pair being misaligned and invites nudging the placement by
 * eye. They are vertically centred correctly; they were simply different sizes.
 *
 * 124x41 scales the Curaleaf ink to ~32.8px tall, the same visible height as the
 * HHH mark at 180x34. Both keep their source aspect ratio (~3.02 and ~5.3).
 *
 * If either PNG is replaced, measure the new file's ink box and recompute these
 * rather than adjusting them by eye — that is what produced the mismatch.
 */
const FOOTER_LOGOS = {
  hhh: { width: 180, height: 34 },
  curaleaf: { width: 124, height: 41 },
} as const;

/**
 * Display size for a pharmacy's own uploaded logo. The stored asset is a fixed
 * 640×192 canvas (see brand-logo.ts), so one ratio serves every pharmacy and the
 * header never has to be told the dimensions of the file it is showing.
 */
const BRAND_LOGO_DISPLAY = { width: 240, height: 72 } as const;

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

/**
 * A pharmacy's header is its own uploaded logo or nothing — never a logo picked for
 * it here. `hasBrandLogo` is set by the delivery worker, which is the only place
 * that knows whether the upload actually exists at the moment of sending; a pharmacy
 * that has not uploaded one gets its name set in type instead.
 */
export function resolveEmailHeader(input: {
  audience: 'admin' | 'pharmacy';
  organisationId?: string;
  pharmacyName?: string;
  hasBrandLogo?: boolean;
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
  const pharmacyName = (input.pharmacyName || '').trim();
  return {
    logoUrl: input.hasBrandLogo ? `cid:${EMAIL_CID.header}` : '',
    logoAlt: pharmacyName || 'Pharmacy',
    width: BRAND_LOGO_DISPLAY.width,
    height: BRAND_LOGO_DISPLAY.height,
    fallbackText: pharmacyName || 'the pharmacy',
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
  /**
   * A plain string is one short line. A step with more to say than fits on one
   * takes a heading and a body, so four long steps read as four things to do
   * rather than as a wall of numbered prose.
   */
  nextSteps?: Array<string | { title: string; body?: string }>;
  footerNote?: string;
  header: EmailHeader;
  /**
   * The controller's own identity. Privacy 1.1 promises the pharmacy's name, address,
   * GPhC number, ICO number and privacy contact appear in every message it sends, so
   * a patient can always tell who holds their information without returning to the site.
   */
  controller?: {
    pharmacyName?: string | null;
    pharmacyAddress?: string | null;
    gphcNumber?: string | null;
    icoRegistrationNumber?: string | null;
    privacyContactEmail?: string | null;
    complaintsContactEmail?: string | null;
    complaintsContactPhone?: string | null;
  } | null;
  /** Marketing only: PECR reg. 22 requires a working opt-out in every message. */
  unsubscribeUrl?: string | null;
  /**
   * The monitored address this message sets as Reply-To, when it sets one. The
   * footer otherwise tells the reader the mailbox is unread, which would flatly
   * contradict copy that invites a reply.
   */
  replyTo?: string | null;
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
  const nextSteps = (input.nextSteps ?? []).filter(Boolean).map((step, index, items) => {
    const { title, body } = typeof step === 'string' ? { title: step, body: '' } : step;
    const last = index === items.length - 1;
    // Nested tables and a fixed-width number cell, because email clients that
    // ignore flexbox still lay this out correctly. The badge degrades to a
    // square in Outlook, which is fine — the number is what carries the order.
    const bodyLine = body
      ? `<p style="margin:5px 0 0; color:#4d5a56; font-size:15px; line-height:23px;">${escapeHtml(body)}</p>`
      : '';
    return `<tr><td style="padding:0 26px ${last ? '24px' : '18px'};"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>`
      + `<td width="28" valign="top" style="width:28px; padding:1px 14px 0 0;">`
      + `<div style="width:26px; height:26px; line-height:26px; border-radius:13px; background:#e3f1ed; color:#12564a; font-family:Arial, Helvetica, sans-serif; font-size:13px; font-weight:700; text-align:center;">${index + 1}</div>`
      + `</td><td valign="top">`
      + `<p style="margin:0; color:#1f2725; font-size:16px; line-height:23px; font-weight:700;">${escapeHtml(title)}</p>${bodyLine}`
      + `</td></tr></table></td></tr>`;
  }).join('');
  const nextStepsBlock = nextSteps
    ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%; margin:0 0 24px; border:1px solid #e1e8e6; border-radius:18px; background:#ffffff;"><tr><td style="padding:24px 26px 10px;"><p style="margin:0; color:#1f2725; font-size:18px; line-height:24px; font-weight:700;">What happens next</p></td></tr>${nextSteps}</table>`
    : '';
  const footerNote = input.footerNote
    ? `<p style="margin:0; color:#5a6662; font-size:15px; line-height:24px;">${input.footerNote}</p>`
    : '';
  const controllerLines = (() => {
    const c = input.controller;
    if (!c?.pharmacyName?.trim()) return '';
    const present = (values: Array<string | null | undefined>) =>
      values.map(value => value?.trim() ?? '').filter(Boolean);
    const parts = present([
      c.pharmacyAddress,
      c.gphcNumber?.trim() ? `GPhC premises ${c.gphcNumber.trim()}` : '',
      c.icoRegistrationNumber?.trim() ? `ICO ${c.icoRegistrationNumber.trim()}` : '',
    ]).map(escapeHtml).join(' · ');
    const complaints = present([c.complaintsContactEmail, c.complaintsContactPhone]).join(' · ');
    const contacts = present([
      c.privacyContactEmail?.trim() ? `Privacy: ${c.privacyContactEmail.trim()}` : '',
      complaints ? `Complaints: ${complaints}` : '',
    ]).map(escapeHtml).join(' · ');
    return `<p style="margin:18px 0 0; color:#9fb4af; font-size:12px; line-height:18px;"><strong style="color:#dce9e5;">${escapeHtml(c.pharmacyName.trim())}</strong>${parts ? `<br>${parts}` : ''}${contacts ? `<br>${contacts}` : ''}</p>`;
  })();
  const unsubscribeHref = input.unsubscribeUrl ? safeHttpUrl(input.unsubscribeUrl) : '';
  const replyTo = (input.replyTo || '').trim();
  const mailboxNote = replyTo
    ? `Replies to this email go to ${escapeHtml(replyTo)}.`
    : 'This mailbox is not monitored.';
  const unsubscribeLine = unsubscribeHref
    ? `<p style="margin:12px 0 0; color:#9fb4af; font-size:12px; line-height:18px;"><a href="${escapeHtml(unsubscribeHref)}" style="color:#dce9e5; text-decoration:underline;">Unsubscribe from these messages</a></p>`
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
                    <img src="cid:${EMAIL_CID.hhh}" width="${FOOTER_LOGOS.hhh.width}" height="${FOOTER_LOGOS.hhh.height}" alt="Holistic Health Hub" style="width:${FOOTER_LOGOS.hhh.width}px; height:${FOOTER_LOGOS.hhh.height}px; max-width:100%; object-fit:contain; object-position:center; border:0; display:block;">
                  </td>
                  <td valign="middle" align="center" style="padding:0 16px; color:#ffffff; font-size:24px; font-weight:300; height:56px;">&times;</td>
                  <td valign="middle" align="center" style="height:56px;">
                    <img src="cid:${EMAIL_CID.curaleaf}" width="${FOOTER_LOGOS.curaleaf.width}" height="${FOOTER_LOGOS.curaleaf.height}" alt="Curaleaf Clinic" style="width:${FOOTER_LOGOS.curaleaf.width}px; height:${FOOTER_LOGOS.curaleaf.height}px; max-width:100%; object-fit:contain; object-position:center; border:0; display:block;">
                  </td>
                </tr>
              </table>
              <p style="margin:18px 0 0; color:#9fb4af; font-size:12px; line-height:18px;">${mailboxNote}</p>
              ${controllerLines}
              ${unsubscribeLine}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
