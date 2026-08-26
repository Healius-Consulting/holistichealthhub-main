import type { CatalogueItem } from '../../context/AppContext';

export function basketItemIssue(input: {
  productId: string;
  cost: number | null;
  catalogue?: CatalogueItem;
  unavailableProductIds: string[];
  quoteError: boolean;
}): { tone: 'blocked' | 'warning'; label: string } | null {
  const { catalogue, unavailableProductIds, productId, cost, quoteError } = input;
  if (unavailableProductIds.includes(productId) || catalogue?.availability === 'out') {
    return { tone: 'blocked', label: 'Out of stock' };
  }
  if (catalogue?.supplierState && catalogue.supplierState !== 'ACTIVE') {
    return { tone: 'blocked', label: 'Unavailable' };
  }
  if (cost === null && quoteError) {
    return { tone: 'blocked', label: 'Quote needs attention' };
  }
  if (catalogue?.availability === 'low') {
    return { tone: 'warning', label: 'Low stock' };
  }
  if (catalogue?.availability === 'unknown' && cost !== null) {
    return { tone: 'warning', label: 'Stock check required' };
  }
  return null;
}

export function patientInitials(name: string) {
  return name.split(' ').map(word => word[0]).join('').toUpperCase().slice(0, 2);
}

export function gmcNumber(value?: string) {
  const number = value?.trim() ? Number(value) : null;
  return number && Number.isInteger(number) && number > 0 ? number : null;
}
