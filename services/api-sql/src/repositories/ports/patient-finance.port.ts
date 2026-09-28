export interface DispenseEventRecord {
  id: string;
  orderId: string;
  dispenseKey: string;
  dispensedAt?: string;
}

export interface PatientFinanceRepositoryPort {
  findDispenseEvent(orderId: string, dispenseKey: string): Promise<DispenseEventRecord | null>;
  listRecentDispenseEvents(patientId: string, limit?: number): Promise<DispenseEventRecord[]>;
  insertDispenseEvent(data: {
    organisationId: string;
    patientId: string;
    orderId: string;
    dispenseKey: string;
    recordedByUid: string;
    dispensedAt: string;
  }): Promise<void>;
  hasNewReferralFee(patientId: string): Promise<boolean>;
  /** Latest payment timestamp, kept even when that order is later refunded. */
  latestPaidAt(patientId: string): Promise<string | null>;
  insertReferralFeeEvent(data: {
    organisationId: string;
    patientId: string;
    orderId?: string | null;
    kind: 'NEW_REFERRAL' | 'ANNUAL_PATIENT';
    amountPence: number;
    dueDate: string;
    status: string;
    idempotencyKey: string;
  }): Promise<boolean>;
}
