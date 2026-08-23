import { useSyncExternalStore } from 'react';
import { applyPublicSurface } from './publicSurface';

export type PublicLocation = {
  pathname: string;
  search: string;
};

function readLocation(): PublicLocation {
  return {
    pathname: window.location.pathname,
    search: window.location.search,
  };
}

let current = readLocation();
const listeners = new Set<() => void>();

function emit() {
  current = readLocation();
  applyPublicSurface(current.pathname, current.search);
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', emit);
}

export function getPublicLocation() {
  return current;
}

export function usePublicLocation() {
  return useSyncExternalStore(subscribe, getPublicLocation, getPublicLocation);
}

export function isModifiedClick(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

export function navigatePublic(href: string) {
  const url = new URL(href, window.location.origin);
  if (url.origin !== window.location.origin) {
    window.location.assign(href);
    return;
  }

  const next = `${url.pathname}${url.search}${url.hash}`;
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next !== currentUrl) {
    window.history.pushState({}, '', next);
    emit();
  }
  window.scrollTo(0, 0);
}
