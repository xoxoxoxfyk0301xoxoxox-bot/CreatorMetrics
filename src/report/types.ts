import type { DashboardOutput } from "../dashboard/types.js";

export type ReportLineKind = "title" | "meta" | "heading" | "body" | "spacer" | "note";
export interface ReportLine { kind: ReportLineKind; text: string }
export interface ReportDocument { generatedAt: string; periodStart: string; periodEnd: string; lines: ReportLine[] }
export interface ReportSource { readDashboardOutput(): Promise<DashboardOutput> }
export interface ReportSink { writeReport(report: ReportDocument): Promise<void> }
