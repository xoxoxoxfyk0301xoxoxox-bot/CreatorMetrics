import type { AdapterCollection, CollectionContext, ContentMetricRecord, DailyMetricRecord, MetricsAdapter } from "../types.js";
import { insightValues, type ThreadsApi, type ThreadsPost, type ThreadsProfile } from "../threads-client.js";

function titleFromText(text?: string): string {
  return Array.from(text?.trim() ?? "").slice(0, 120).join("");
}

function cutoffDate(date: string, lookbackDays: number): number {
  return Date.parse(`${date}T23:59:59Z`) - lookbackDays * 86400000;
}

export class ThreadsAdapter implements MetricsAdapter {
  readonly platform = "threads" as const;
  constructor(private readonly api: ThreadsApi, private readonly lookbackDays = 90) {}

  async collect({ date }: CollectionContext): Promise<AdapterCollection> {
    const [profile, allPosts, accountInsights] = await Promise.all([this.api.getProfile(), this.api.getAllThreads(), this.api.getAccountInsights(date)]);
    const cutoff = cutoffDate(date, this.lookbackDays);
    const posts = allPosts.filter((post) => !post.timestamp || Date.parse(post.timestamp) >= cutoff);
    const insights = await this.fetchPostInsights(posts);
    return this.toCollection(date, profile, posts, insights, accountInsights);
  }

  private async fetchPostInsights(posts: ThreadsPost[]): Promise<Map<string, Awaited<ReturnType<ThreadsApi["getPostInsights"]>>>> {
    const result = new Map<string, Awaited<ReturnType<ThreadsApi["getPostInsights"]>>>();
    for (let index = 0; index < posts.length; index += 5) {
      const batch = posts.slice(index, index + 5);
      const values = await Promise.all(batch.map(async (post) => [post.id, await this.api.getPostInsights(post.id)] as const));
      for (const [id, value] of values) result.set(id, value);
    }
    return result;
  }

  private toCollection(date: string, profile: ThreadsProfile, posts: ThreadsPost[], postInsights: Map<string, Awaited<ReturnType<ThreadsApi["getPostInsights"]>>>, accountInsights: Awaited<ReturnType<ThreadsApi["getAccountInsights"]>>): AdapterCollection {
    const collectedAt = new Date().toISOString();
    const account = insightValues(accountInsights);
    if (account.followers_count !== undefined) { account.followers = account.followers_count; delete account.followers_count; }
    const dailyMetrics: DailyMetricRecord[] = [{ date, platform: this.platform, accountId: profile.id, metrics: account, collectedAt }];
    const contentMetrics: ContentMetricRecord[] = posts.map((post) => {
      const metrics = insightValues(postInsights.get(post.id) ?? []);
      const views = metrics.views ?? 0;
      const engagements = (metrics.likes ?? 0) + (metrics.replies ?? 0) + (metrics.reposts ?? 0) + (metrics.quotes ?? 0) + (metrics.shares ?? 0);
      return {
        date, platform: this.platform, contentId: post.id,
        contentType: post.media_product_type ?? post.media_type ?? "",
        title: titleFromText(post.text), publishedAt: post.timestamp ?? "",
        views, estimatedMinutesWatched: 0, likes: metrics.likes ?? 0, comments: 0,
        replies: metrics.replies ?? 0, reposts: metrics.reposts ?? 0, quotes: metrics.quotes ?? 0,
        shares: metrics.shares ?? 0, averageViewDuration: 0,
        engagementRate: views > 0 ? engagements / views : 0, collectedAt
      };
    });
    const notes = posts.length ? [] : [`No Threads posts were found within the ${this.lookbackDays}-day lookback window.`];
    return { dailyMetrics, contentMetrics, notes };
  }

  async diagnose(context: CollectionContext): Promise<{ authenticatedUserId: string; username: string; profileAvailable: boolean; threadsFetched: number; insightsAvailable: boolean; dailyMetricsCount: number; contentMetricsCount: number; tokenValid: boolean }> {
    const profile = await this.api.getProfile();
    const collection = await this.collect(context);
    return {
      authenticatedUserId: profile.id, username: profile.username ?? "", profileAvailable: Boolean(profile.id),
      threadsFetched: collection.contentMetrics.length, insightsAvailable: collection.dailyMetrics.length > 0,
      dailyMetricsCount: collection.dailyMetrics.length, contentMetricsCount: collection.contentMetrics.length, tokenValid: true
    };
  }
}
