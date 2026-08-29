/**
 * Fail-closed filter for Curaleaf pack labels.
 *
 * Keep in lockstep with `packages/domain/curaleaf-catalogue-label.js`.
 * Firebase functions cannot import the workspace package at deploy time, so this
 * copy lives in api-sql. `tests/curaleafCatalogueLabel.test.ts` fails if they drift.
 */

const SANDBOX_JUNK = /BPTEST/i;
const HTML_TAGS = /<(?:script|iframe|object|embed|svg|img|link|style|form|input|meta|base|video|audio|a|b)\b/i;
const EVENT_HANDLER = /\bon[a-z]+\s*=/i;
const UNSAFE_SCHEME = /(?:javascript|vbscript|data:text\/html|file)\s*:/i;
const COMMAND_SUB = /`|\$\(|\$\{/;
const PATH_TRAVERSAL = /\.\.\//;
const EXECUTABLE_SUFFIX = /\.(?:exe|bat|cmd|ps1|sh|js|html)(?:\s|$)/i;

export function curaleafCatalogueLabelIsUnsafe(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false;
  return SANDBOX_JUNK.test(value)
    || HTML_TAGS.test(value)
    || EVENT_HANDLER.test(value)
    || UNSAFE_SCHEME.test(value)
    || COMMAND_SUB.test(value)
    || PATH_TRAVERSAL.test(value)
    || EXECUTABLE_SUFFIX.test(value);
}

export function curaleafCatalogueRecordIsUnsafe(record: unknown): boolean {
  if (!record || typeof record !== 'object') return false;
  const row = record as { formulaName?: unknown; printedName?: unknown; formulaUnit?: unknown };
  return curaleafCatalogueLabelIsUnsafe(row.formulaName)
    || curaleafCatalogueLabelIsUnsafe(row.printedName)
    || curaleafCatalogueLabelIsUnsafe(row.formulaUnit);
}

export function curaleafCataloguePackIsUnsafe(product: unknown, formula?: unknown): boolean {
  const pack = product && typeof product === 'object' ? product as Record<string, unknown> : {};
  const row = formula && typeof formula === 'object' ? formula as Record<string, unknown> : {};
  return curaleafCatalogueRecordIsUnsafe({
    formulaName: pack.formulaName,
    printedName: pack.printedName ?? row.printedName,
    formulaUnit: pack.formulaUnit ?? row.unit ?? row.formulaUnit,
  });
}

export function stripUnsafeCuraleafCatalogue<T>(formulas: T[], products: T[]): { formulas: T[]; products: T[] } {
  const formulaList = Array.isArray(formulas) ? formulas : [];
  const productList = Array.isArray(products) ? products : [];
  const formulaById = new Map(
    formulaList
      .filter((row): row is T & { id: string } => Boolean(row) && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string')
      .map(row => [row.id, row]),
  );
  const safeProducts = productList.filter(product => {
    if (!product || typeof product !== 'object') return false;
    const pack = product as { formulaId?: unknown };
    const formula = typeof pack.formulaId === 'string' ? formulaById.get(pack.formulaId) : undefined;
    return !curaleafCataloguePackIsUnsafe(product, formula);
  });
  const safeFormulas = formulaList.filter(formula => {
    if (!formula || typeof formula !== 'object') return false;
    const row = formula as { printedName?: unknown; unit?: unknown; formulaUnit?: unknown };
    return !curaleafCatalogueRecordIsUnsafe({
      printedName: row.printedName,
      formulaUnit: row.unit ?? row.formulaUnit,
    });
  });
  return { formulas: safeFormulas, products: safeProducts };
}
