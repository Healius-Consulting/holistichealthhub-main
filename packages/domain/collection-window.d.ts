export declare const COLLECTION_EMAIL_CUTOFF_HOUR: number;
export declare const COLLECTION_EMAIL_SEND_HOUR: number;
export declare function collectionEmailSendAt(now: Date): Date;
export declare function collectionEmailDelayUntil(now: Date): Date | null;
export declare function collectionEmailNotice(now?: Date): {
  immediate: boolean;
  sendAt: Date;
  summary: string;
  detail: string;
};
