import { surfaceRoutePath, type PortalPathPrefix } from './surfaceRoute';

/**
 * Links into a place in Settings (FB-12 to FB-16): `/pharmacy/settings?section=assets&focus=<id>`.
 * Settings reads it once on open, scrolls there, briefly highlights the card, then tidies the URL.
 */
export type SettingsSectionId = 'organisation' | 'payments' | 'assets' | 'support';
export type SettingsLinkTarget = { section: SettingsSectionId; focus: string | null };

const SECTIONS = new Set<SettingsSectionId>(['organisation', 'payments', 'assets', 'support']);

export function settingsHref(target: SettingsLinkTarget, prefix: PortalPathPrefix) {
  const params = new URLSearchParams({ section: target.section });
  if (target.focus) params.set('focus', target.focus);
  return `${surfaceRoutePath('/settings', prefix)}?${params.toString()}`;
}

export function settingsTargetFromSearch(search: string): SettingsLinkTarget | null {
  const params = new URLSearchParams(search);
  const section = params.get('section') as SettingsSectionId | null;
  if (!section || !SECTIONS.has(section)) return null;
  const focus = params.get('focus');
  return { section, focus: focus && /^[A-Za-z0-9_.-]{1,80}$/.test(focus) ? focus : null };
}

/** The element id a content pack download group carries in Settings → Assets (FB-20). */
export function contentPackGroupElementId(group: string) {
  return `content-pack-group-${group}`;
}
