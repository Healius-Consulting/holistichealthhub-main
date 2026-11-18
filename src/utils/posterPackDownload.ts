import JSZip from 'jszip';
import type { PharmacyTenant } from '../context/AppContext';
import { downloadDataUrl, qrDataUrl } from './pharmacyResources';
import { buildPosterPdfs, posterImageType, type PosterImage } from './posterPack';

function dataUrlBytes(dataUrl: string) {
  const binary = atob(dataUrl.split(',')[1] ?? '');
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

/** The branch logo HHH uploaded, when it can be read as PNG or JPEG. Otherwise the poster prints the name. */
async function branchLogo(org: PharmacyTenant): Promise<PosterImage | null> {
  if (!org.emailLogoUrl) return null;
  try {
    const response = await fetch(org.emailLogoUrl, { credentials: 'omit' });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const type = posterImageType(bytes);
    return type ? { bytes, type } : null;
  } catch {
    return null;
  }
}

/** Builds the three posters in the browser and saves them as one .zip. Settings imports this file only on click, so pdf-lib loads only then. */
export async function downloadPosterPack(org: PharmacyTenant, formUrl: string) {
  const [qr, logo] = await Promise.all([
    qrDataUrl(formUrl),
    branchLogo(org),
  ]);
  const files = await buildPosterPdfs({
    pharmacyName: org.name,
    address: org.address,
    primary: org.brand.primary,
    qr: dataUrlBytes(qr),
    logo,
  });
  const zip = new JSZip();
  const folder = zip.folder(`${org.slug}-poster-pack`)!;
  for (const file of files) folder.file(file.filename, file.bytes);
  const blobUrl = URL.createObjectURL(await zip.generateAsync({ type: 'blob' }));
  downloadDataUrl(blobUrl, `${org.slug}-poster-pack.zip`);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}
