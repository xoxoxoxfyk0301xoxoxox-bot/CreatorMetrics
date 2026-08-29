import { describe, expect, it, vi } from "vitest";
import { ThreadsAdapter } from "../src/adapters/threads.js";
import { ThreadsClient, type ThreadsApi, type ThreadsInsight } from "../src/threads-client.js";
import { runCollection } from "../src/collector.js";
import { contentMetricKey, dailyMetricKey } from "../src/store/google-sheets.js";
import type { CollectionLogRecord, ContentMetricRecord, DailyMetricRecord, MetricsStore } from "../src/types.js";

const insights = (values: Record<string, number>): ThreadsInsight[] => Object.entries(values).map(([name, value]) => ({ name, period: "lifetime", values: [{ value }] }));

class MemoryStore implements MetricsStore {
  daily = new Map<string, DailyMetricRecord>(); content = new Map<string, ContentMetricRecord>(); logs: CollectionLogRecord[] = [];
  async ensureSheets() {}
  async upsertDailyMetrics(records: DailyMetricRecord[]) { for (const record of records) this.daily.set(dailyMetricKey(record), record); return records.length; }
  async upsertContentMetrics(records: ContentMetricRecord[]) { for (const record of records) this.content.set(contentMetricKey(record), record); return records.length; }
  async appendLog(record: CollectionLogRecord) { this.logs.push(record); }
}

function api(): ThreadsApi {
  return {
    async getProfile() { return { id: "user-1", username: "creator" }; },
    async getAllThreads() { return [{ id: "thread-1", media_product_type: "THREADS", text: "A real post body", timestamp: "2026-08-01T00:00:00Z" }]; },
    async getPostInsights() { return insights({ views: 100, likes: 10, replies: 2, reposts: 3, quotes: 1, shares: 4 }); },
    async getAccountInsights() { return [
      ...insights({ views: 200, likes: 20, replies: 4, reposts: 5, quotes: 2, clicks: 7 }),
      { name: "followers_count", period: "day", total_value: { value: 99 } }
    ]; }
  };
}

describe("ThreadsAdapter", () => {
  it("gets the profile and converts post/account insights", async () => {
    const getProfile = vi.fn(api().getProfile);
    const source = { ...api(), getProfile };
    const result = await new ThreadsAdapter(source).collect({ date: "2026-08-26", timeZone: "Asia/Tokyo" });
    expect(getProfile).toHaveBeenCalled();
    expect(result.dailyMetrics[0]).toMatchObject({ accountId: "user-1", metrics: { views: 200, followers: 99 } });
    expect(result.contentMetrics[0]).toMatchObject({ contentId: "thread-1", title: "A real post body", views: 100, likes: 10, replies: 2, reposts: 3, quotes: 1, shares: 4, engagementRate: 0.2 });
  });

  it("stores lifetime insights as separate daily snapshots and upserts same-day reruns", async () => {
    const store = new MemoryStore();
    const adapter = new ThreadsAdapter(api());
    await runCollection([adapter], store, { date: "2026-08-26", timeZone: "Asia/Tokyo" });
    await runCollection([adapter], store, { date: "2026-08-26", timeZone: "Asia/Tokyo" });
    await runCollection([adapter], store, { date: "2026-08-27", timeZone: "Asia/Tokyo" });
    expect(store.content.size).toBe(2);
    expect([...store.content.keys()]).toEqual(expect.arrayContaining(["2026-08-26|threads|thread-1", "2026-08-27|threads|thread-1"]));
  });
});

describe("ThreadsClient", () => {
  it("fetches every page of the user's threads", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "a" }], paging: { next: "https://graph.threads.net/page-2" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "b" }] }), { status: 200 }));
    const posts = await new ThreadsClient("token", "https://graph.threads.net", fetcher).getAllThreads();
    expect(posts.map((post) => post.id)).toEqual(["a", "b"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("redacts the access token from API errors", async () => {
    const secret = "secret-token-value";
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 190, message: `Invalid token ${secret}` } }), { status: 401 }));
    let message = "";
    try { await new ThreadsClient(secret, "https://graph.threads.net", fetcher).getProfile(); }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message).toContain("[THREADS_190]");
    expect(message).not.toContain(secret);
    expect(message).toContain("[REDACTED]");
  });
});
