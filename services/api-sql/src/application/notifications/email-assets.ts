import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMAIL_CID, type EmailHeader } from './email-layout.js';

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../assets/email');

export type EmailInlineImage = {
  filename: string;
  content: string;
  content_id: string;
  content_type: 'image/png';
};

function readPng(filename: string, contentId: string): EmailInlineImage | null {
  try {
    return {
      filename,
      content: readFileSync(join(assetsDir, filename)).toString('base64'),
      content_id: contentId,
      content_type: 'image/png',
    };
  } catch {
    return null;
  }
}

/**
 * `brandLogoBase64` is the pharmacy's own uploaded logo, read at send time. The two
 * bundled images are Holistic Health Hub's and Curaleaf's own marks in the footer —
 * no pharmacy logo is ever shipped in the repository.
 */
export function emailInlineImages(header: EmailHeader, brandLogoBase64?: string | null): EmailInlineImage[] {
  const images = [
    readPng('hhh-logo.png', EMAIL_CID.hhh),
    readPng('curaleaf-clinic-white.png', EMAIL_CID.curaleaf),
  ];
  if (brandLogoBase64 && header.logoUrl === `cid:${EMAIL_CID.header}`) {
    images.push({
      filename: 'pharmacy-logo.png',
      content: brandLogoBase64,
      content_id: EMAIL_CID.header,
      content_type: 'image/png',
    });
  }
  return images.filter((image): image is EmailInlineImage => Boolean(image));
}
