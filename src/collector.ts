import { randomUUID } from "node:crypto";
import type { CollectionContext, CollectionLogRecord, MetricsAdapter, MetricsStore } from "./types.js";

export interface CollectionResult {
  platform: string; status: "success" | "failed"; dailyMetrics: number; contentMetrics: number;
  writtenDaily: number; writtenContent: number; reason: string; error?: string;
}

export async function runCollection(adapters: MetricsAdapter[], store: MetricsStore, context: CollectionContext): Promise<CollectionResult[]> {
  await store.ensureSheets();
  return Promise.all(adapters.map(async (adapter): Promise<CollectionResult> => {
    const started = Date.now();
    const startedAt = new Date().toISOString();
    const runId = randomUUID();
    let result: CollectionResult;
    try {
      const collection = await adapter.collect(context);
      const writes = await Promise.allSettled([
        store.upsertDailyMetrics(collection.dailyMetrics),
        store.upsertContentMetrics(collection.contentMetrics)
      ]);
      const errors = writes.filter((write): write is PromiseRejectedResult => write.status === "rejected").map((write) => write.reason instanceof Error ? write.reason.message : String(write.reason));
      result = {
        platform: adapter.platform, status: errors.length ? "failed" : "success",
        dailyMetrics: collection.dailyMetrics.length, contentMetrics: collection.contentMetrics.length,
        writtenDaily: writes[0]?.status === "fulfilled" ? writes[0].value : 0,
        writtenContent: writes[1]?.status === "fulfilled" ? writes[1].value : 0,
        reason: collection.notes.join("; "), ...(errors.length ? { error: errors.join("; ") } : {})
      };
    } catch (error) {
      result = { platform: adapter.platform, status: "failed", dailyMetrics: 0, contentMetrics: 0, writtenDaily: 0, writtenContent: 0, reason: "Collection failed before metrics were returned.", error: error instanceof Error ? error.message : String(error) };
    }
    const finishedAt = new Date().toISOString();
    const errorValue = result.error ?? "";
    const errorCode = result.error && typeof result.error === "string" ? (result.error.match(/^\[([^\]]+)\]/)?.[1] ?? "") : "";
    const log: CollectionLogRecord = {
      runId, collectedAt: finishedAt, date: context.date, platform: adapter.platform, status: result.status,
      dailyMetrics: result.dailyMetrics, contentMetrics: result.contentMetrics, writtenDaily: result.writtenDaily,
      writtenContent: result.writtenContent, durationMs: Date.now() - started, reason: result.reason, error: errorValue,
      recordsWritten: result.writtenDaily + result.writtenContent, errorCode, errorMessage: errorValue,
      startedAt, finishedAt
    };
    try { await store.appendLog(log); }
    catch (logError) {
      const message = `CollectionLog write failed: ${logError instanceof Error ? logError.message : String(logError)}`;
      result = { ...result, status: "failed", error: result.error ? `${result.error}; ${message}` : message };
    }
    return result;
  }));
}
