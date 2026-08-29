import type { CatalogueItem } from '../context/AppContext';

export type CachedCatalogue = {
  items: CatalogueItem[];
  updatedAt: string | null;
  environment: 'test' | 'production';
};

function cacheEstate(value: unknown): 'test' | 'production' {
  return value === 'production' ? 'production' : 'test';
}

export function parseCatalogueCache(raw: string | null | undefined): CachedCatalogue | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { items?: unknown; updatedAt?: unknown; environment?: unknown };
    if (!Array.isArray(parsed.items) || parsed.items.length === 0) return null;
    return {
      items: parsed.items as CatalogueItem[],
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      environment: cacheEstate(parsed.environment),
    };
  } catch {
    return null;
  }
}

/**
 * A key rotation must not leave sandbox packs on a live pharmacy (or the reverse).
 * Legacy cache with no environment is treated as test, so it is discarded when a
 * production catalogue arrives.
 */
export function shouldDiscardCatalogueCache(cachedEnvironment: unknown, fetchedEnvironment: unknown): boolean {
  return cacheEstate(cachedEnvironment) !== cacheEstate(fetchedEnvironment);
}

export function serialiseCatalogueCache(
  items: CatalogueItem[],
  updatedAt: string | null,
  environment: unknown,
): string {
  return JSON.stringify({
    items,
    updatedAt,
    environment: cacheEstate(environment),
    timestamp: Date.now(),
  });
}
