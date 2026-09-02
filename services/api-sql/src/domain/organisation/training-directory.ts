const TRAINING_DIRECTORY_PHARMACY_IDS = new Set([
  '70913a3071c34a41952ed532927af58c',
  'f486a221223644a5b072f06de399ab0e',
]);
const TRAINING_DIRECTORY_PHARMACY_NAMES = /^(primary|alternate)\s+(pharmacy|branch)$/i;

export function isTrainingDirectoryOrganisation(organisation: {
  id: string;
  name?: string | null;
  tradingName?: string | null;
  classification?: string | null;
} | null | undefined) {
  if (!organisation) return false;
  if (String(organisation.classification || '').toUpperCase() === 'TRAINING') return true;
  if (TRAINING_DIRECTORY_PHARMACY_IDS.has(organisation.id.replaceAll('-', '').toLowerCase())) return true;
  return [organisation.name, organisation.tradingName]
    .map(value => String(value || '').trim())
    .some(name => TRAINING_DIRECTORY_PHARMACY_NAMES.test(name));
}
