import type { AdapterCollection, CollectionContext, MetricsAdapter } from "../types.js";
const METRICS = ["IMPRESSION", "PIN_CLICK", "OUTBOUND_CLICK", "SAVE", "ENGAGEMENT", "TOTAL_AUDIENCE", "ENGAGED_AUDIENCE"];
type PinterestRow = { DATE?: string; date?: string; [metric: string]: unknown };
export class PinterestAdapter implements MetricsAdapter {
  readonly platform = "pinterest" as const;
  constructor(private readonly accessToken: string, private readonly username: string, private readonly baseUrl = "https://api.pinterest.com/v5", private readonly fetcher: typeof fetch = fetch) {}
  async collect({ date }: CollectionContext): Promise<AdapterCollection> {
    const query = new URLSearchParams({ start_date: date, end_date: date, granularity: "DAY" });
    for (const metric of METRICS) query.append("metric_types", metric);
    const response = await this.fetcher(`${this.baseUrl}/user_account/analytics?${query}`, { headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json" } });
    if (!response.ok) throw new Error(`Pinterest API ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const body = await response.json() as PinterestRow[] | { items?: PinterestRow[] };
    const rows = Array.isArray(body) ? body : body.items ?? [];
    const metrics: Record<string, number> = {};
    for (const row of rows) for (const metric of METRICS) {
      const value = Number(row[metric]);
      if (Number.isFinite(value)) metrics[metric] = (metrics[metric] ?? 0) + value;
    }
    const dailyMetrics = rows.length ? [{ date, platform: this.platform, accountId: this.username, metrics, collectedAt: new Date().toISOString() }] : [];
    return { dailyMetrics, contentMetrics: [], notes: rows.length ? ["Pinterest content-level collection is not implemented."] : ["Pinterest Analytics returned no daily rows."] };
  }
}
