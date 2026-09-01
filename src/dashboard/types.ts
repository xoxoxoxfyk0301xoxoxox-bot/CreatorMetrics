import type { CommissionPaymentRecord, ContentMetricRecord, DailyMetricRecord, SalesMetricRecord, TransactionRecord } from "../types.js";

export type DataQuality = "OK" | "NO_DATA" | "NOT_SUPPORTED" | "INSUFFICIENT_BASELINE" | "STALE" | "PARTIAL";
export type CollectionStatus = "OK" | "PARTIAL" | "FAILED" | "STALE" | "NO_DATA";
export type ActivityStatus = "HAS_DATA" | "ZERO_ACTIVITY" | "NO_DATA";
export type ComparisonStatus = "COMPARABLE" | "INSUFFICIENT_BASELINE";
export type MetricSemantics = "snapshot" | "period" | "increment";
export interface MetricValue { value: number | null; quality: DataQuality }
export interface RawDashboardData {
  daily: DailyMetricRecord[];
  content: ContentMetricRecord[];
  sales: SalesMetricRecord[];
  transactions: TransactionRecord[];
  payments: CommissionPaymentRecord[];
  importActivity: ImportActivityRecord[];
  collectionActivity: CollectionActivityRecord[];
}
export interface ImportActivityRecord { platform: string; source: string; status: string; finishedAt: string }
export interface CollectionActivityRecord { date: string; platform: string; status: string; dailyMetricsCount: number; contentMetricsCount: number; writtenDaily: number; writtenContent: number; reason: string; errorCode: string; finishedAt: string }
export interface PeriodRange { start: string; end: string }
export interface WeeklySummaryRecord {
  key: string; weekStart: string; weekEnd: string; platform: string;
  views: number | null; likes: number | null; comments: number | null; replies: number | null; reposts: number | null;
  shares: number | null; clicks: number | null; orders: number | null; grossSales: number | null; commission: number | null;
  postsPublished: number | null; previousPeriodValue: number | null; changeRate: number | null; changeLabel: string;
  overallQuality: DataQuality; quality: Record<string, DataQuality>; collectionStatus: CollectionStatus; activityStatus: ActivityStatus; comparisonStatus: ComparisonStatus; generatedAt: string;
}
export interface TopContentRecord {
  key: string; periodType: "WEEK"; periodStart: string; periodEnd: string; platform: "youtube" | "threads";
  rank: number; contentId: string; title: string; publishedAt: string;
  views: number; likes: number; comments: number | null; replies: number | null; reposts: number | null; shares: number;
  engagementRate: number | null; quality: DataQuality; generatedAt: string;
}
export interface DashboardRow {
  section: string; metric: string; value: number | null; display: string; quality: DataQuality; period: string; generatedAt: string;
}
export interface DashboardOutput { dashboard: DashboardRow[]; weekly: WeeklySummaryRecord[]; topContent: TopContentRecord[] }
export interface DashboardDataSource { readRawData(): Promise<RawDashboardData> }
export interface DashboardSink { writeDashboard(output: DashboardOutput): Promise<void> }
