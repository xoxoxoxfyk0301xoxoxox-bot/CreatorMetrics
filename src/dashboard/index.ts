import type { DashboardDataSource, DashboardOutput, DashboardSink } from "./types.js";
import { generateDashboard } from "./analytics.js";

export async function runDashboard(source: DashboardDataSource, sink: DashboardSink, asOf: string): Promise<DashboardOutput> {
  const output = generateDashboard(await source.readRawData(), asOf);
  await sink.writeDashboard(output);
  return output;
}
