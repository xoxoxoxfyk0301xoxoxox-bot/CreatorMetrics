export const THREADS_POST_METRICS = ["views", "likes", "replies", "reposts", "quotes", "shares"] as const;
export const THREADS_ACCOUNT_METRICS = ["views", "likes", "replies", "reposts", "quotes", "clicks", "followers_count"] as const;

export interface ThreadsProfile { id: string; username?: string; name?: string; threads_profile_picture_url?: string; threads_biography?: string }
export interface ThreadsPost { id: string; media_product_type?: string; media_type?: string; text?: string; timestamp?: string; permalink?: string }
export interface ThreadsInsight { name: string; period?: string; values?: { value?: number; end_time?: string }[]; total_value?: { value?: number } }
type Page<T> = { data?: T[]; paging?: { next?: string } };

export interface ThreadsApi {
  getProfile(): Promise<ThreadsProfile>;
  getAllThreads(): Promise<ThreadsPost[]>;
  getPostInsights(threadId: string): Promise<ThreadsInsight[]>;
  getAccountInsights(date: string): Promise<ThreadsInsight[]>;
}
export interface ThreadsPublishingApi { getProfile(): Promise<ThreadsProfile>; createTextContainer(text: string): Promise<string>; publishContainer(creationId: string): Promise<string> }

export class ThreadsApiError extends Error {
  constructor(readonly apiCode: string, message: string) { super(`[${apiCode}] ${message}`); this.name = "ThreadsApiError"; }
}

export class ThreadsClient implements ThreadsApi {
  constructor(private readonly accessToken: string, private readonly baseUrl = "https://graph.threads.net", private readonly fetcher: typeof fetch = fetch) {}

  private async request<T>(pathOrUrl: string, method = "GET"): Promise<T> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    const response = await this.fetcher(url, { method, headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json" } });
    const body = await response.json().catch(() => ({})) as { error?: { code?: number; error_subcode?: number; message?: string } } & T;
    if (!response.ok || body.error) {
      const code = body.error?.error_subcode ?? body.error?.code ?? response.status;
      const raw = body.error?.message ?? `Threads API HTTP ${response.status}`;
      const safeMessage = raw.replaceAll(this.accessToken, "[REDACTED]");
      throw new ThreadsApiError(`THREADS_${code}`, safeMessage);
    }
    return body;
  }

  async getProfile(): Promise<ThreadsProfile> {
    return this.request<ThreadsProfile>("/me?fields=id,username,name,threads_profile_picture_url,threads_biography");
  }

  async getAllThreads(): Promise<ThreadsPost[]> {
    const posts: ThreadsPost[] = [];
    let next: string | undefined = "/me/threads?fields=id,media_product_type,media_type,text,timestamp,permalink&limit=100";
    while (next) {
      const page: Page<ThreadsPost> = await this.request<Page<ThreadsPost>>(next);
      posts.push(...(page.data ?? []));
      next = page.paging?.next;
    }
    return posts;
  }

  async getPostInsights(threadId: string): Promise<ThreadsInsight[]> {
    const query = new URLSearchParams({ metric: THREADS_POST_METRICS.join(",") });
    return (await this.request<{ data?: ThreadsInsight[] }>(`/${encodeURIComponent(threadId)}/insights?${query}`)).data ?? [];
  }

  async getAccountInsights(date: string): Promise<ThreadsInsight[]> {
    const since = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
    const until = since + 86400;
    const query = new URLSearchParams({ metric: THREADS_ACCOUNT_METRICS.join(","), since: String(since), until: String(until) });
    return (await this.request<{ data?: ThreadsInsight[] }>(`/me/threads_insights?${query}`)).data ?? [];
  }

  async createTextContainer(text: string): Promise<string> {
    const query = new URLSearchParams({ media_type: "TEXT", text });
    const result = await this.request<{ id?: string }>(`/me/threads?${query}`, "POST");
    if (!result.id) throw new ThreadsApiError("THREADS_API", "Text container ID was not returned");
    return result.id;
  }

  async publishContainer(creationId: string): Promise<string> {
    const query = new URLSearchParams({ creation_id: creationId });
    const result = await this.request<{ id?: string }>(`/me/threads_publish?${query}`, "POST");
    if (!result.id) throw new ThreadsApiError("THREADS_API", "Published Threads post ID was not returned");
    return result.id;
  }
}

export function insightValues(insights: ThreadsInsight[]): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const insight of insights) {
    const value = insight.total_value?.value ?? insight.values?.at(-1)?.value;
    if (typeof value === "number" && Number.isFinite(value)) metrics[insight.name] = value;
  }
  return metrics;
}
