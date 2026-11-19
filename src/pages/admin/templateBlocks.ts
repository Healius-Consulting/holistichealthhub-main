/**
 * The admin email editor's model of an onboarding template. A stored body is one
 * string with blank-line paragraphs and `[If flag]…[/If]` blocks; the editor shows it
 * as a list of blocks instead: plain paragraphs, and "shown only when" paragraphs for
 * each condition that stands as a paragraph of its own. A condition in the middle of a
 * sentence stays inside its plain paragraph, as typed.
 *
 * Serialising joins blocks with a blank line. The server's mergeTemplate drops empty
 * paragraphs, so this sends the same email as the original body, even where two
 * conditions shared a paragraph.
 */

export type TemplateBlock = { id: string; flag: string | null; text: string };

const IF_BLOCK = /\[If ([^\]]+)\]([\s\S]*?)\[\/If\]/gi;
const ONLY_IF_BLOCKS = /^(?:\s*\[If [^\]]+\][\s\S]*?\[\/If\]\s*)+$/i;

let nextId = 0;
const blockId = () => `block-${(nextId += 1)}`;

/** Splits a body into paragraphs, keeping each `[If]…[/If]` whole even when it has blank lines inside. */
function paragraphUnits(body: string): string[] {
  const units: string[] = [];
  let current = '';
  let last = 0;
  const addText = (text: string) => {
    const pieces = text.split(/\n\s*\n/);
    current += pieces[0] ?? '';
    for (const piece of pieces.slice(1)) {
      units.push(current);
      current = piece;
    }
  };
  for (const match of body.matchAll(IF_BLOCK)) {
    const start = match.index ?? 0;
    addText(body.slice(last, start));
    current += match[0];
    last = start + match[0].length;
  }
  addText(body.slice(last));
  units.push(current);
  return units.map(unit => unit.trim()).filter(Boolean);
}

export function parseTemplate(body: string): TemplateBlock[] {
  const blocks: TemplateBlock[] = [];
  for (const unit of paragraphUnits(body)) {
    if (ONLY_IF_BLOCKS.test(unit)) {
      for (const match of unit.matchAll(IF_BLOCK)) {
        blocks.push({ id: blockId(), flag: match[1]!.trim(), text: match[2]!.trim() });
      }
    } else {
      blocks.push({ id: blockId(), flag: null, text: unit });
    }
  }
  return blocks;
}

export function serializeTemplate(blocks: TemplateBlock[]): string {
  return blocks
    .filter(block => block.text.trim())
    .map(block => (block.flag ? `[If ${block.flag}]${block.text.trim()}[/If]` : block.text.trim()))
    .join('\n\n');
}

/** The same body in the editor's layout, so a body counts as changed only when its email would. */
export function normalizeTemplate(body: string): string {
  return serializeTemplate(parseTemplate(body));
}

export function newBlock(flag: string | null = null): TemplateBlock {
  return { id: blockId(), flag, text: '' };
}

/** Merge fields in the text that the email does not have: they would be sent as typed. */
export function unknownFields(text: string, fields: string[]): string[] {
  const known = new Set(fields.map(field => field.toLowerCase()));
  const found = new Set<string>();
  for (const match of text.matchAll(/\[([^\]\n]{1,60})\]/g)) {
    const name = match[1]!.trim();
    if (/^(If\s|\/If$)/i.test(name)) continue;
    if (!known.has(name.toLowerCase())) found.add(name);
  }
  return [...found];
}

/** Plain-English names for the template flags. */
export const FLAG_LABEL: Record<string, string> = {
  'no worldpay': 'No Worldpay application',
  'worldpay submitted': 'Worldpay application sent',
  'terms link': 'Partner Terms published',
  'training link': 'Training link set',
  'no training link': 'No training link',
  'existing curaleaf customer': 'Hold reason A: existing Curaleaf customer',
  'more information needed': 'Hold reason B: more information needed',
  'curaleaf declined': 'Hold reason C: Curaleaf declined',
  'worldpay validated': 'Card payments set up',
  'worldpay not validated': 'Card payments not set up',
  'required outstanding': 'Required checklist items open',
  'optional outstanding': 'Optional checklist items open',
  'own website': 'Pharmacy has its own website',
  'no website': 'Pharmacy has no website',
  amount: 'An amount is known',
  'order number': 'An order number is known',
  'case reference': 'A case reference is known',
  summary: 'There is a summary',
  'no summary': 'There is no summary',
  partial: 'Only some packs are ready',
  'all ready': 'Every pack is ready',
  'purchase order': 'A purchase order is known',
  'no purchase order': 'No purchase order is known',
  'patient name': 'The patient’s name is known',
  'no patient name': 'The patient’s name is not known',
  'pharmacy named': 'The invite is for a pharmacy',
  declined: 'Closed as not eligible',
  incomplete: 'Closed for missing information',
  withdrawn: 'Closed because the patient withdrew',
};

export function flagLabel(flag: string) {
  return FLAG_LABEL[flag.trim().toLowerCase()] ?? flag;
}
