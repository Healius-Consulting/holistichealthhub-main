import { serialReuseDisplay, serialReuseIsCurrent } from '@hhh/domain/prescription-date';
import type { Prescription } from '../context/AppContext';

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
  const reuse = rx?.issueDate ? serialReuseDisplay(rx.issueDate, now) : null;
  return {
    serialCarried,
    scanOnFile,
    serialTitle: serialCarried ? 'Serial carried forward' : 'New serial required',
    serialDetail: serialCarried
      ? (reuse?.text ?? 'This serial is still inside 24 days of the printed issue date.')
      : 'Enter the serial from a new prescription. After day 24 the old serial cannot be placed.',
    scanTitle: scanOnFile ? 'Stored scan kept' : 'New scan required',
    scanDetail: scanOnFile
      ? 'The copy on file will be sent with a new Curaleaf prescription record.'
      : 'The previous scan is no longer on file.',
  };
}
