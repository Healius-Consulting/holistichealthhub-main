import { serialReuseIsCurrent } from '@hhh/domain/prescription-date';
import type { Prescription } from '../context/AppContext';

/** Replacement drafts copy only the first source script. Extra scripts belong on a new order. */
export function replacementSourcePrescriptions<T>(prescriptions: T[]): T[] {
  return prescriptions.slice(0, 1);
}

export function draftAllowsAdditionalPrescriptions(order: { redoContext?: unknown } | null | undefined) {
  return order != null && !order.redoContext;
}

export function replacementPrescriptionCopy(sourceRx: Prescription | undefined, now = new Date()) {
  const serialEligible = Boolean(sourceRx?.serialNumber && sourceRx.issueDate && serialReuseIsCurrent(sourceRx.issueDate, now));
  const fileReusable = Boolean(sourceRx?.fileId);
  return {
    serialEligible,
    fileReusable,
    serialNumber: serialEligible ? sourceRx?.serialNumber : undefined,
    issueDate: serialEligible ? sourceRx?.issueDate : undefined,
    expiryDate: serialEligible ? sourceRx?.expiryDate : undefined,
    fileId: fileReusable ? sourceRx?.fileId : undefined,
    copyFileName: fileReusable ? (sourceRx?.copyFileName ?? 'Prescription copy on file') : null,
    serialInherited: serialEligible,
  };
}

export function replacementBannerState(
  rx: Pick<Prescription, 'serialInherited' | 'serialNumber' | 'issueDate' | 'fileId' | 'copyFileName'> | undefined,
  now = new Date(),
) {
  const serialCarried = Boolean(rx?.serialInherited && rx.serialNumber && serialReuseIsCurrent(rx.issueDate, now));
  const scanOnFile = Boolean(rx?.fileId || rx?.copyFileName);
  return {
    serialCarried,
    scanOnFile,
    serialTitle: serialCarried ? 'Prescription carried forward' : 'New serial required',
    serialDetail: serialCarried
      ? 'This prescription can be reused.'
      : 'This prescription cannot be reused. Enter a new serial.',
    scanTitle: scanOnFile ? 'Stored scan kept' : 'New scan required',
    scanDetail: scanOnFile
      ? 'The copy on file will be sent with a new Curaleaf prescription record.'
      : 'The previous scan is no longer on file.',
  };
}
