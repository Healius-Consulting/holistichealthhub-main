/**
 * Fail-closed filter for Curaleaf pack labels.
 *
 * Sandbox junk (BPTEST) and XSS / command / file payloads must never reach the
 * pharmacy catalogue, quote bank, or clinic-scan errors. Drop the pack; do not
 * try to clean the name for display. Legitimate oil and flos names will not match.
 */

const SANDBOX_JUNK = /BPTEST/i;
const HTML_TAGS = /<(?:script|iframe|object|embed|svg|img|link|style|form|input|meta|base|video|audio|a|b)\b/i;
const EVENT_HANDLER = /\bon[a-z]+\s*=/i;
const UNSAFE_SCHEME = /(?:javascript|vbscript|data:text\/html|file)\s*:/i;
const COMMAND_SUB = /`|\$\(|\$\{/;
const PATH_TRAVERSAL = /\.\.\//;
const EXECUTABLE_SUFFIX = /\.(?:exe|bat|cmd|ps1|sh|js|html)(?:\s|$)/i;

export function curaleafCatalogueLabelIsUnsafe(value) {
  if (typeof value !== 'string' || !value) return false;
  return SANDBOX_JUNK.test(value)
    || HTML_TAGS.test(value)
    || EVENT_HANDLER.test(value)
    || UNSAFE_SCHEME.test(value)
    || COMMAND_SUB.test(value)
    || PATH_TRAVERSAL.test(value)
    || EXECUTABLE_SUFFIX.test(value);
}

export function curaleafCatalogueRecordIsUnsafe(record) {
  if (!record || typeof record !== 'object') return false;
  return curaleafCatalogueLabelIsUnsafe(record.formulaName)
    || curaleafCatalogueLabelIsUnsafe(record.printedName)
    || curaleafCatalogueLabelIsUnsafe(record.formulaUnit);
}

export function curaleafCataloguePackIsUnsafe(product, formula) {
  const pack = product && typeof product === 'object' ? product : {};
  const row = formula && typeof formula === 'object' ? formula : {};
  return curaleafCatalogueRecordIsUnsafe({
    formulaName: pack.formulaName,
    printedName: pack.printedName ?? row.printedName,
    formulaUnit: pack.formulaUnit ?? row.unit ?? row.formulaUnit,
  });
}

export function stripUnsafeCuraleafCatalogue(formulas, products) {
  const formulaList = Array.isArray(formulas) ? formulas : [];
  const productList = Array.isArray(products) ? products : [];
  const formulaById = new Map(
    formulaList
      .filter(row => row && typeof row === 'object' && typeof row.id === 'string')
      .map(row => [row.id, row]),
  );
  const safeProducts = productList.filter(product => {
    if (!product || typeof product !== 'object') return false;
    const formula = typeof product.formulaId === 'string' ? formulaById.get(product.formulaId) : undefined;
    return !curaleafCataloguePackIsUnsafe(product, formula);
  });
  const safeFormulas = formulaList.filter(formula => {
    if (!formula || typeof formula !== 'object') return false;
    return !curaleafCatalogueRecordIsUnsafe({
      printedName: formula.printedName,
      formulaUnit: formula.unit ?? formula.formulaUnit,
    });
  });
  return { formulas: safeFormulas, products: safeProducts };
}
