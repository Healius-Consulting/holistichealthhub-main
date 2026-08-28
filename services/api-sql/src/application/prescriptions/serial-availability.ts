import { HttpError } from '../../domain/common/errors.js';
import {
  evaluateSerialOccupancy,
  normalizeSerialNumber,
  serialReuseIsCurrent,
} from './serial-reuse.js';

export type SerialForCreateReason =
  | 'clinic'
  | 'ok'
  | 'SERIAL_REQUIRED'
  | 'SERIAL_IN_USE'
  | 'SERIAL_REUSE_EXPIRED'
  | 'CURALEAF_SERIAL_STILL_LIVE';

export type SerialForCreateResult = {
  allowed: boolean;
  reason: SerialForCreateReason;
  occupyingOrderId?: string;
  reusesSourceSerial: boolean;
};

export function evaluateSerialForCreate(input: {
  clinicOwned?: boolean;
  serialNumber?: string | null;
  issueDate?: string | null;
  sourceSerial?: string | null;
  liveOrderId?: string | null;
  livePatientId?: string | null;
  sourceOrderId?: string | null;
  currentOrderId?: string | null;
  currentPatientId?: string | null;
  asOf?: Date | string;
}): SerialForCreateResult {
  if (input.clinicOwned) {
    return { allowed: true, reason: 'clinic', reusesSourceSerial: false };
  }

  const serial = normalizeSerialNumber(input.serialNumber);
  if (!serial) {
    return { allowed: false, reason: 'SERIAL_REQUIRED', reusesSourceSerial: false };
  }

  const occupancy = evaluateSerialOccupancy({
    liveOrderId: input.liveOrderId,
    livePatientId: input.livePatientId,
    sourceOrderId: input.sourceOrderId,
    currentOrderId: input.currentOrderId,
    currentPatientId: input.currentPatientId,
  });
  const sourceSerial = normalizeSerialNumber(input.sourceSerial);
  const reusesSourceSerial = Boolean(
    occupancy.reason === 'source_owner'
    || (sourceSerial && serial === sourceSerial),
  );

  if (!occupancy.allowed) {
    return {
      allowed: false,
      reason: 'SERIAL_IN_USE',
      occupyingOrderId: occupancy.occupyingOrderId,
      reusesSourceSerial,
    };
  }

  if (reusesSourceSerial && !serialReuseIsCurrent(input.issueDate, input.asOf)) {
    return { allowed: false, reason: 'SERIAL_REUSE_EXPIRED', reusesSourceSerial: true };
  }

  return {
    allowed: true,
    reason: 'ok',
    occupyingOrderId: occupancy.occupyingOrderId,
    reusesSourceSerial,
  };
}

export async function assertSerialAvailableForCreate(input: {
  organisationId: string;
  clinicOwned?: boolean;
  serialNumber?: string | null;
  issueDate?: string | null;
  sourceSerial?: string | null;
  sourceOrderId?: string | null;
  currentPatientId?: string | null;
  asOf?: Date | string;
  findLive: (organisationId: string, serialNumber: string) => Promise<{ orderId: string | null; patientId: string } | null>;
  lookupCuraleaf?: (serialNumber: string) => Promise<void>;
}): Promise<SerialForCreateResult> {
  const serial = normalizeSerialNumber(input.serialNumber);
  const live = serial && !input.clinicOwned
    ? await input.findLive(input.organisationId, serial)
    : null;
  const evaluated = evaluateSerialForCreate({
    clinicOwned: input.clinicOwned,
    serialNumber: input.serialNumber,
    issueDate: input.issueDate,
    sourceSerial: input.sourceSerial,
    liveOrderId: live?.orderId,
    livePatientId: live?.patientId,
    sourceOrderId: input.sourceOrderId,
    currentPatientId: input.currentPatientId,
    asOf: input.asOf,
  });
  if (!evaluated.allowed || evaluated.reason === 'clinic' || !serial || !input.lookupCuraleaf) {
    return evaluated;
  }
  try {
    await input.lookupCuraleaf(serial);
    return evaluated;
  } catch (error) {
    if (error instanceof HttpError && error.code === 'CURALEAF_SERIAL_STILL_LIVE') {
      return {
        allowed: false,
        reason: 'CURALEAF_SERIAL_STILL_LIVE',
        reusesSourceSerial: evaluated.reusesSourceSerial,
      };
    }
    return evaluated;
  }
}

export function serialAvailabilityHttpError(result: SerialForCreateResult) {
  if (result.allowed) return null;
  if (result.reason === 'SERIAL_IN_USE') {
    return new HttpError(409, 'This prescription serial is already on another live order.', 'SERIAL_IN_USE', {
      occupyingOrderId: result.occupyingOrderId,
    });
  }
  if (result.reason === 'SERIAL_REUSE_EXPIRED') {
    return new HttpError(409, 'This prescription cannot be reused. Enter a new serial.', 'SERIAL_REUSE_EXPIRED');
  }
  if (result.reason === 'CURALEAF_SERIAL_STILL_LIVE') {
    return new HttpError(409, 'Curaleaf still has a live prescription with this serial. Call Curaleaf to cancel it before creating this order.', 'CURALEAF_SERIAL_STILL_LIVE');
  }
  return new HttpError(409, 'Enter the prescription serial exactly as printed.', 'SERIAL_REQUIRED');
}
