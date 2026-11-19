/**
 * Admin-editable email and page content: `[field]` merge fields and `[If flag]…[/If]`
 * blocks (not nested; flag names match case-insensitively). Blank lines split paragraphs.
 * Shared by the Worldpay application and partner onboarding content.
 */
/**
 * Fills an admin-written template. `[field name]` is replaced from `fields` (unknown
 * names stay as typed, so a typo shows rather than vanishing); `[If flag]…[/If]` keeps
 * its text only when the flag is true. Returns paragraphs split on blank lines.
 */
export function mergeTemplate(template: string, fields: Record<string, string>, flags: Record<string, boolean>): string[] {
  const conditioned = template.replace(/\[If ([^\]]+)\]([\s\S]*?)\[\/If\]/gi, (_, flag: string, inner: string) => (flags[flag.trim().toLowerCase()] ? inner : ''));
  const lookup = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key.toLowerCase(), value]));
  const merged = conditioned.replace(/\[([^\]\n]{1,60})\]/g, (whole, name: string) => {
    const value = lookup[name.trim().toLowerCase()];
    return value === undefined ? whole : value;
  });
  return merged
    .replace(/\*\*/g, '')
    .split(/\n\s*\n/)
    .map(paragraph => paragraph.split('\n').map(lineText => lineText.trimEnd()).join('\n').trim())
    .filter(Boolean);
}

export function mergeSubject(template: string, fields: Record<string, string>) {
  return mergeTemplate(template, fields, {}).join(' ').replace(/\s+/g, ' ').trim();
}
