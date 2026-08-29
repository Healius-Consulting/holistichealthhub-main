import type { Prescription } from '../../context/AppContext';
import { prescriptionDateIsCurrent } from '@hhh/domain/prescription-date';

export type RxTabStatus = 'ready' | 'needs copy' | 'needs details' | 'needs medicines';

export function rxHasCopy(rx: Prescription) {
  return Boolean(rx.copyFileName || rx.clinicScanId);
}

export function rxSourceVerified(rx: Prescription) {
  return rx.entryMode === 'manual'
    ? Boolean(rx.serialNumber?.trim())
    : Boolean(rx.clinicScanId && rx.curaleafPrescriptionId);
}

export function rxPrescriberComplete(rx: Prescription) {
  return Boolean(
    rx.issueDate
    && rx.prescriber.trim()
    && (rx.entryMode === 'manual' ? rx.prescriberPin?.trim() : rx.prescriberId),
  );
}

export function rxMedicinesComplete(rx: Prescription) {
  return rx.items.length > 0 && rx.items.every(item => (
    Boolean(item.productId && item.formulaId)
    && Number.isInteger(item.qty) && item.qty > 0
    && Number.isInteger(item.unitsNeededCount) && item.unitsNeededCount! > 0
    && Number.isFinite(item.retail) && item.retail > 0
  ));
}

export function rxDetailsComplete(rx: Prescription) {
  return rxSourceVerified(rx)
    && rxPrescriberComplete(rx)
    && prescriptionDateIsCurrent(rx.issueDate, rx.expiryDate);
}

export function rxAuthenticated(rx: Prescription, options?: { requireLiveFile?: boolean }) {
  const liveFileOk = !options?.requireLiveFile || Boolean(rx.fileId) || Boolean(rx.clinicScanId);
  return rxHasCopy(rx) && liveFileOk && rxDetailsComplete(rx);
}

export function rxTabStatus(rx: Prescription): RxTabStatus {
  if (!rxHasCopy(rx)) return 'needs copy';
  if (!rxDetailsComplete(rx)) return 'needs details';
  if (!rxMedicinesComplete(rx)) return 'needs medicines';
  return 'ready';
}

export function rxRouteLabel(rx: Prescription) {
  return rx.entryMode === 'manual' ? 'Manual' : 'Clinic';
}

export function rxTabStatusLabel(status: RxTabStatus) {
  if (status === 'ready') return 'ready';
  if (status === 'needs copy') return 'needs copy';
  if (status === 'needs details') return 'needs details';
  return 'needs medicines';
}

export function incompletePrescriptionPaymentGates(prescriptions: Prescription[]) {
  if (prescriptions.length <= 1) return [];
  return prescriptions.flatMap((rx, index) => {
    const status = rxTabStatus(rx);
    if (status === 'ready') return [];
    const phrase = status === 'needs copy'
      ? 'needs a copy'
      : status === 'needs details'
        ? 'needs details'
        : 'needs medicines';
    return [{ label: `Prescription ${index + 1} ${phrase}`, complete: false as const }];
  });
}
