import { resolvePublicView, type PublicView } from './publicRoute';

export function applyPublicSurface(pathname: string, search: string): PublicView {
  const view = resolvePublicView(pathname, search);
  const html = document.documentElement;
  const body = document.body;
  const isSite = view === 'site';
  const isEligibility = view === 'eligibility';

  html.classList.toggle('hhh-public-active', isSite);
  html.classList.toggle('eligibility-active', isEligibility);
  body.classList.toggle('hhh-public-active', isSite);
  body.classList.toggle('eligibility-active', isEligibility);
  body.classList.toggle('hhh-page-ready', isSite);

  if (!isSite) body.classList.remove('hhh-page-ready');
  return view;
}
