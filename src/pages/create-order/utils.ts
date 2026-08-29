import type { CatalogueItem } from '../../context/AppContext';
import { catalogueStockLabel, catalogueStockStatus } from '../../utils/catalogueStock';

export function basketItemIssue(input: {
  productId: string;
  cost: number | null;
  catalogue?: CatalogueItem;
  unavailableProductIds: string[];
  quoteError: boolean;
}): { tone: 'blocked' | 'warning'; label: string } | null {
  const { catalogue, unavailableProductIds, productId, cost, quoteError } = input;
  if (catalogue && catalogueStockStatus(catalogue) === 'discontinued') {
    return { tone: 'blocked', label: catalogueStockLabel('discontinued') };
  }
  if (unavailableProductIds.includes(productId) || catalogue?.availability === 'out') {
    return { tone: 'blocked', label: catalogueStockLabel('out') };
  }
  if (cost === null && quoteError) {
    return { tone: 'blocked', label: 'Quote needs attention' };
  }
  if (catalogue?.availability === 'low') {
    return { tone: 'warning', label: catalogueStockLabel('low') };
  }
  if (catalogue?.availability === 'unknown' && cost !== null) {
    return { tone: 'warning', label: catalogueStockLabel('unknown') };
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
