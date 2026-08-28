export type PrescriptionDateWindowStatus = 'current' | 'future' | 'expired' | 'invalid';
export type PrescriptionDateInputStatus = 'empty' | 'incomplete' | 'invalid' | 'valid';
export type PrescriptionExpiryTone = 'green' | 'amber' | 'red';

export function normalisePrescriptionDateParts(day?: string | number, month?: string | number, year?: string | number): { status: PrescriptionDateInputStatus; value: string; display?: string };
export function prescriptionExpiryDisplay(issueDate?: string, now?: Date | string): { expiryDate: string; daysRemaining: number; tone: PrescriptionExpiryTone; text: string } | null;
export function prescriptionIssueDateBounds(now?: Date | string): { min: string; max: string } | null;
export function calculatePrescriptionExpiryDate(issueDate: string): string | null;
export function prescriptionDateWindowStatus(issueDate?: string, suppliedExpiryDate?: string, now?: Date | string): PrescriptionDateWindowStatus;
export function prescriptionDateIsCurrent(issueDate?: string, suppliedExpiryDate?: string, now?: Date | string): boolean;
export function serialReuseUntilDate(issueDate?: string): string | null;
export function serialReuseWindowStatus(issueDate?: string, now?: Date | string): PrescriptionDateWindowStatus;
export function serialReuseIsCurrent(issueDate?: string, now?: Date | string): boolean;
export function serialReuseDisplay(issueDate?: string, now?: Date | string): { untilDate: string; daysRemaining: number; tone: PrescriptionExpiryTone; text: string } | null;
