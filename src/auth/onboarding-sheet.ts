import JSZip from 'jszip';

export type OnboardingSheetRow = { label: string; value: string };

function decodeXml(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function sharedStrings(xml: string) {
  return xml.split(/<si[\s>]/).slice(1).map(item => (
    decodeXml([...item.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map(match => match[1] ?? '').join(''))
  ));
}

function columnName(reference: string) {
  return reference.replace(/[0-9]/g, '');
}

/** Read the first worksheet as label and answer rows for an in-page look. */
export async function readOnboardingSpreadsheet(data: ArrayBuffer): Promise<OnboardingSheetRow[]> {
  const zip = await JSZip.loadAsync(data);
  const sharedXml = await zip.file('xl/sharedStrings.xml')?.async('string');
  const sheetXml = await zip.file('xl/worksheets/sheet1.xml')?.async('string');
  if (!sheetXml) return [];
  const shared = sharedXml ? sharedStrings(sharedXml) : [];
  const rows: OnboardingSheetRow[] = [];
  for (const rowXml of sheetXml.split(/<row[\s>]/).slice(1)) {
    const cells = new Map<string, string>();
    for (const match of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attributes = match[1] ?? '';
      const body = match[2] ?? '';
      const reference = attributes.match(/\br="([^"]+)"/)?.[1] ?? '';
      const type = attributes.match(/\bt="([^"]+)"/)?.[1] ?? '';
      const raw = body.match(/<v[^>]*>([^<]*)<\/v>/)?.[1] ?? '';
      const inline = [...body.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map(part => part[1] ?? '').join('');
      const value = decodeXml(type === 's' ? shared[Number(raw)] ?? '' : type === 'inlineStr' ? inline : raw).trim();
      if (reference && value) cells.set(columnName(reference), value);
    }
    const label = cells.get('A') ?? '';
    const value = ['C', 'B', 'D', 'E', 'F', 'G', 'H'].map(column => cells.get(column)).find(Boolean) ?? '';
    if (label || value) rows.push({ label, value });
  }
  return rows;
}
