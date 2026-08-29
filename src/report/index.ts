import { generateReport } from "./generator.js";
import type { ReportDocument, ReportSink, ReportSource } from "./types.js";

export async function runReport(source: ReportSource, sink: ReportSink): Promise<ReportDocument> {
  const report = generateReport(await source.readDashboardOutput());
  await sink.writeReport(report);
  return report;
}
