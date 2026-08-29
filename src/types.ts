export type Platform = "youtube" | "pinterest" | "threads" | (string & {});
export interface DailyMetricRecord { date: string; platform: Platform; accountId: string; metrics: Record<string, number>; collectedAt: string }
export interface ContentMetricRecord {
  date: string; platform: Platform; contentId: string; contentType: string; title: string; publishedAt: string;
  views: number; estimatedMinutesWatched: number; likes: number; comments: number; shares: number; averageViewDuration: number;
  impressions?: number; ctr?: number; collectedAt: string;
  replies?: number; reposts?: number; quotes?: number; engagementRate?: number;
}
export interface AdapterCollection { dailyMetrics: DailyMetricRecord[]; contentMetrics: ContentMetricRecord[]; notes: string[] }
export interface CollectionContext { date: string; timeZone: string }
export interface MetricsAdapter { readonly platform: Platform; collect(context: CollectionContext): Promise<AdapterCollection> }
export interface CollectionLogRecord {
  runId: string; collectedAt: string; date: string; platform: Platform; status: "success" | "failed";
  dailyMetrics: number; contentMetrics: number; writtenDaily: number; writtenContent: number;
  durationMs: number; reason: string; error: string;
  recordsWritten: number; errorCode: string; errorMessage: string; startedAt: string; finishedAt: string;
}
export interface MetricsStore {
  ensureSheets(): Promise<void>;
  upsertDailyMetrics(records: DailyMetricRecord[]): Promise<number>;
  upsertContentMetrics(records: ContentMetricRecord[]): Promise<number>;
  appendLog(record: CollectionLogRecord): Promise<void>;
}

export interface SalesMetricRecord {
  key: string; date: string; yearMonth: string; periodMonth: string | null; platform: Platform; source: string; shopName: string;
  grossSales: number; fees: number; netSalesBeforeTransferFee: number; transferFees: number; netSales: number;
  commission: number; clicks: number | null; orders: number | null; conversionRate: number | null; collectedAt: string;
}
export type TransactionStatus = "UNCONFIRMED" | "CONFIRMED" | "DISCARDED" | "";
export interface TransactionRecord {
  key: string; transactionDate: string; periodMonth: string | null; platform: Platform; source: string; transactionId: string;
  paymentType: string; paymentMethod: string; contentType: string; contentName: string;
  grossSales: number; taxRate: number; salesBeforeTax: number; taxAmount: number; pointsUsed: number;
  commission: number; commissionRate: number; genre: string; shopName: string; itemName: string;
  rawStatus: string; orderStatus: TransactionStatus; linkType: string; deviceType: string; measurementId: string;
  collectedAt: string; sourceFileHash: string;
}
export interface CommissionPaymentRecord {
  key: string; yearMonth: string; platform: Platform; source: string; rakutenPoints: number;
  rakutenCash: number; bankTransfer: number; totalPaid: number; collectedAt: string;
}
export interface ImportLogRecord {
  platform: Platform; source: string; filename: string; fileHash: string; status: "success" | "failed" | "skipped";
  rowsRead: number; rowsWritten: number; rowsUpdated: number; rowsSkipped: number; unknownColumns: string[];
  errorMessage: string; startedAt: string; finishedAt: string;
}
export interface UpsertResult { written: number; updated: number }
export interface ImportStore {
  ensureImportSheets(): Promise<void>;
  hasImportedFile(fileHash: string): Promise<boolean>;
  upsertSalesMetrics(records: SalesMetricRecord[]): Promise<UpsertResult>;
  upsertTransactions(records: TransactionRecord[]): Promise<UpsertResult>;
  upsertCommissionPayments(records: CommissionPaymentRecord[]): Promise<UpsertResult>;
  appendImportLog(record: ImportLogRecord): Promise<void>;
}
