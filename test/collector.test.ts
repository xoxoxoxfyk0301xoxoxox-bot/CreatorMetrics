import { describe, expect, it } from "vitest";
import { runCollection } from "../src/collector.js";
import { initializeAdapter } from "../src/adapters/unavailable.js";
import { loadPinterestConfig, loadThreadsConfig } from "../src/config.js";
import { contentMetricKey, dailyMetricKey } from "../src/store/google-sheets.js";
import type { AdapterCollection, CollectionLogRecord, ContentMetricRecord, DailyMetricRecord, MetricsAdapter, MetricsStore } from "../src/types.js";

class MemoryStore implements MetricsStore {
  daily = new Map<string, DailyMetricRecord>(); content = new Map<string, ContentMetricRecord>(); logs: CollectionLogRecord[] = [];
  async ensureSheets() {}
  async upsertDailyMetrics(records: DailyMetricRecord[]) { for (const record of records) this.daily.set(dailyMetricKey(record), record); return records.length; }
  async upsertContentMetrics(records: ContentMetricRecord[]) { for (const record of records) this.content.set(contentMetricKey(record), record); return records.length; }
  async appendLog(record: CollectionLogRecord) { this.logs.push(record); }
}

const date = "2026-08-25";
const daily: DailyMetricRecord = { date, platform: "youtube", accountId: "channel", metrics: { views: 35 }, collectedAt: "2026-08-26T00:00:00Z" };
const content = (contentId: string): ContentMetricRecord => ({ date, platform: "youtube", contentId, contentType: "video", title: contentId, publishedAt: "2025-01-01T00:00:00Z", views: 10, estimatedMinutesWatched: 20, likes: 2, comments: 1, shares: 1, averageViewDuration: 120, collectedAt: "2026-08-26T00:00:00Z" });
const adapter = (collection: AdapterCollection): MetricsAdapter => ({ platform: "youtube", collect: async () => collection });

describe("runCollection", () => {
  it("stores one DailyMetrics row and multiple ContentMetrics rows", async () => {
    const store = new MemoryStore();
    const results = await runCollection([adapter({ dailyMetrics: [daily], contentMetrics: [content("a"), content("b")], notes: [] })], store, { date, timeZone: "Asia/Tokyo" });
    expect(store.daily.size).toBe(1); expect(store.content.size).toBe(2);
    expect(results[0]).toMatchObject({ dailyMetrics: 1, contentMetrics: 2, writtenDaily: 1, writtenContent: 2 });
  });

  it("upserts ContentMetrics without duplicates when the same date is rerun", async () => {
    const store = new MemoryStore();
    const source = adapter({ dailyMetrics: [daily], contentMetrics: [content("a"), content("b")], notes: [] });
    await runCollection([source], store, { date, timeZone: "Asia/Tokyo" });
    await runCollection([source], store, { date, timeZone: "Asia/Tokyo" });
    expect(store.content.size).toBe(2);
  });

  it("logs a reason when ContentMetrics is empty", async () => {
    const store = new MemoryStore();
    await runCollection([adapter({ dailyMetrics: [daily], contentMetrics: [], notes: ["no reportable video activity"] })], store, { date, timeZone: "Asia/Tokyo" });
    expect(store.logs[0]).toMatchObject({ contentMetrics: 0, writtenContent: 0, reason: "no reportable video activity" });
  });

  it("continues YouTube and logs Pinterest failure when Pinterest ENV is missing", async () => {
    const pinterest = initializeAdapter("pinterest", () => { loadPinterestConfig({}); throw new Error("unreachable"); });
    const store = new MemoryStore();
    const results = await runCollection([adapter({ dailyMetrics: [daily], contentMetrics: [], notes: [] }), pinterest], store, { date, timeZone: "Asia/Tokyo" });
    expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ platform: "youtube", status: "success" }), expect.objectContaining({ platform: "pinterest", status: "failed" })]));
    expect(store.logs.find((log) => log.platform === "pinterest")?.error).toContain("PINTEREST_ACCESS_TOKEN");
  });

  it("continues other media and logs Threads failure when Threads ENV is missing", async () => {
    const threads = initializeAdapter("threads", () => { loadThreadsConfig({}); throw new Error("unreachable"); });
    const store = new MemoryStore();
    const results = await runCollection([adapter({ dailyMetrics: [daily], contentMetrics: [], notes: [] }), threads], store, { date, timeZone: "Asia/Tokyo" });
    expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ platform: "youtube", status: "success" }), expect.objectContaining({ platform: "threads", status: "failed" })]));
    expect(store.logs.find((log) => log.platform === "threads")?.error).toContain("THREADS_");
  });
});
