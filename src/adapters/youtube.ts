import { google, type Auth, type youtube_v3, type youtubeAnalytics_v2 } from "googleapis";
import type { AdapterCollection, CollectionContext, ContentMetricRecord, DailyMetricRecord, MetricsAdapter } from "../types.js";

const DAILY_METRICS = ["views", "estimatedMinutesWatched", "subscribersGained", "subscribersLost", "likes", "comments", "shares"] as const;
const CONTENT_METRICS = ["views", "engagedViews", "estimatedMinutesWatched", "likes", "comments", "shares", "averageViewDuration", "averageViewPercentage", "subscribersGained", "subscribersLost"] as const;

interface YouTubeServices {
  listChannels(params: youtube_v3.Params$Resource$Channels$List): Promise<youtube_v3.Schema$Channel[]>;
  queryAnalytics(params: youtubeAnalytics_v2.Params$Resource$Reports$Query): Promise<youtubeAnalytics_v2.Schema$QueryResponse>;
  listVideos(ids: string[]): Promise<youtube_v3.Schema$Video[]>;
  listPlaylistVideoIds(playlistId: string, maxResults: number): Promise<string[]>;
}

function productionServices(auth: Auth.OAuth2Client): YouTubeServices {
  const youtube = google.youtube({ version: "v3", auth });
  const analytics = google.youtubeAnalytics({ version: "v2", auth });
  return {
    async listChannels(params) { return (await youtube.channels.list(params)).data.items ?? []; },
    async queryAnalytics(params) { return (await analytics.reports.query(params)).data; },
    async listVideos(ids) {
      const items: youtube_v3.Schema$Video[] = [];
      for (let index = 0; index < ids.length; index += 50) {
        const response = await youtube.videos.list({ part: ["snippet", "contentDetails", "statistics", "liveStreamingDetails"], id: ids.slice(index, index + 50) });
        items.push(...(response.data.items ?? []));
      }
      return items;
    },
    async listPlaylistVideoIds(playlistId, maxResults) {
      const ids: string[] = [];
      let pageToken: string | undefined;
      do {
        const response = await youtube.playlistItems.list({ part: ["contentDetails"], playlistId, maxResults: Math.min(50, maxResults - ids.length), ...(pageToken ? { pageToken } : {}) });
        ids.push(...(response.data.items ?? []).map((item) => item.contentDetails?.videoId).filter((id): id is string => Boolean(id)));
        pageToken = response.data.nextPageToken ?? undefined;
      } while (pageToken && ids.length < maxResults);
      return ids;
    }
  };
}

const safeQuery = (params: youtubeAnalytics_v2.Params$Resource$Reports$Query) => ({
  ids: params.ids, startDate: params.startDate, endDate: params.endDate,
  dimensions: params.dimensions ?? null, metrics: params.metrics, filters: params.filters ?? null,
  sort: params.sort ?? null, maxResults: params.maxResults ?? null
});

function subtractDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

export function isoDurationSeconds(value?: string | null): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
  if (!match) return undefined;
  return Number(match[1] ?? 0) * 86400 + Number(match[2] ?? 0) * 3600 + Number(match[3] ?? 0) * 60 + Number(match[4] ?? 0);
}

export interface YouTubeDiagnosticResult {
  exactMinimalError: string;
  oneDayRows: number;
  sevenDayRows: number;
  availableDays: string[];
  dailyViews: { date: string; views: number }[];
  perDayVideoRows: { date: string; rows: number }[];
  metricChecks: { metrics: string; rows: number }[];
  channelId: string;
  channelTitle: string;
  videoCount: string;
  viewCount: string;
  uploadVideoId: string;
  filteredVideoRows: number;
}

function numericRow(headers: youtubeAnalytics_v2.Schema$ResultTableColumnHeader[], row: unknown[]): Record<string, number> {
  const values: Record<string, number> = {};
  headers.forEach((header, index) => {
    if (!header.name) return;
    const value = Number(row[index]);
    if (Number.isFinite(value)) values[header.name] = value;
  });
  return values;
}

export class YouTubeAdapter implements MetricsAdapter {
  readonly platform = "youtube" as const;
  private readonly services: YouTubeServices;
  constructor(auth: Auth.OAuth2Client, private readonly configuredChannelId = "mine", services?: YouTubeServices) { this.services = services ?? productionServices(auth); }

  async collect({ date }: CollectionContext): Promise<AdapterCollection> {
    const channels = await this.services.listChannels({ part: ["id", "snippet", "statistics", "contentDetails"], ...(this.configuredChannelId === "mine" ? { mine: true } : { id: [this.configuredChannelId] }) });
    const channel = channels[0];
    if (!channel?.id) throw new Error("YouTube channel was not found for the authenticated user");
    const collectedAt = new Date().toISOString();
    const channelStart = channel.snippet?.publishedAt?.slice(0, 10) || "2005-02-14";
    const [dailyReport, contentReport, lifetimeReport, channelLifetimeReport] = await Promise.all([
      this.services.queryAnalytics({ ids: `channel==${channel.id}`, startDate: date, endDate: date, dimensions: "day", metrics: DAILY_METRICS.join(",") }),
      this.queryAllContentRows(channel.id, date, date),
      this.queryAllContentRows(channel.id, channelStart, date),
      this.services.queryAnalytics({ ids: `channel==${channel.id}`, startDate: channelStart, endDate: date, metrics: DAILY_METRICS.join(",") })
    ]);
    const dailyRow = dailyReport.rows?.[0];
    const analyticsMetrics = dailyRow ? numericRow(dailyReport.columnHeaders ?? [], dailyRow) : {};
    delete analyticsMetrics.day;
    const stats = channel.statistics ?? {};
    const lifetimeChannel = channelLifetimeReport.rows?.[0] ? numericRow(channelLifetimeReport.columnHeaders ?? [], channelLifetimeReport.rows[0]) : {};
    const metrics = { ...analyticsMetrics, analyticsAvailable: dailyRow ? 1 : 0, ...Object.fromEntries(Object.entries(lifetimeChannel).map(([key,value])=>[`lifetime${key[0]!.toUpperCase()}${key.slice(1)}`,value])), channelViewCount: Number(stats.viewCount ?? 0), subscriberCount: Number(stats.subscriberCount ?? 0), videoCount: Number(stats.videoCount ?? 0) };
    const dailyMetrics: DailyMetricRecord[] = [{ date, platform: this.platform, accountId: channel.id, metrics, collectedAt }];

    const contentHeaders = contentReport.columnHeaders ?? [];
    const videoIndex = contentHeaders.findIndex((header) => header.name === "video");
    if ((contentReport.rows?.length ?? 0) > 0 && videoIndex < 0) throw new Error("YouTube Analytics video report did not contain the video dimension");
    const contentRows = contentReport.rows ?? [];
    const creatorTypeIndex = contentHeaders.findIndex((header) => header.name === "creatorContentType");
    const analyticsByVideo = new Map<string, Record<string, number | string>>(contentRows.map((row) => [String(row[videoIndex]), { ...numericRow(contentHeaders, row), creatorContentType: creatorTypeIndex >= 0 ? String(row[creatorTypeIndex] ?? "") : "" }]));
    const lifetimeHeaders = lifetimeReport.columnHeaders ?? [];
    const lifetimeVideoIndex = lifetimeHeaders.findIndex((header) => header.name === "video");
    const lifetimeCreatorTypeIndex = lifetimeHeaders.findIndex((header) => header.name === "creatorContentType");
    const lifetimeByVideo = new Map<string, Record<string, number | string>>((lifetimeReport.rows ?? []).map((row) => [String(row[lifetimeVideoIndex]), { ...numericRow(lifetimeHeaders, row), creatorContentType: lifetimeCreatorTypeIndex >= 0 ? String(row[lifetimeCreatorTypeIndex] ?? "") : "" }]));
    const uploadsPlaylist = channel.contentDetails?.relatedPlaylists?.uploads;
    const uploadVideoIds = uploadsPlaylist ? await this.services.listPlaylistVideoIds(uploadsPlaylist, 5000) : [];
    const videoIds = [...new Set([...uploadVideoIds, ...analyticsByVideo.keys()])];
    const videos = videoIds.length ? await this.services.listVideos(videoIds) : [];
    const metadata = new Map(videos.filter((video) => video.id).map((video) => [video.id!, video]));
    const contentMetrics: ContentMetricRecord[] = videoIds.map((contentId) => {
      const values: Record<string, number | string> = analyticsByVideo.get(contentId) ?? {};
      const lifetime: Record<string, number | string> = lifetimeByVideo.get(contentId) ?? {};
      const video = metadata.get(contentId);
      const creatorType = String(values.creatorContentType ?? lifetime.creatorContentType ?? "");
      const publicStats = video?.statistics ?? {};
      const metric = (name: string) => typeof values[name] === "number" ? values[name] as number : 0;
      return {
        date, platform: this.platform, contentId, contentType: creatorType === "SHORTS" ? "short" : creatorType === "LIVE_STREAM" || video?.liveStreamingDetails ? "live" : "video",
        title: video?.snippet?.title ?? "", publishedAt: video?.snippet?.publishedAt ?? "",
        views: metric("views"), estimatedMinutesWatched: metric("estimatedMinutesWatched"),
        likes: metric("likes"), comments: metric("comments"), shares: metric("shares"),
        averageViewDuration: metric("averageViewDuration"), collectedAt,
        ...(typeof values.engagedViews === "number" ? { engagedViews: values.engagedViews } : {}),
        ...(typeof values.averageViewPercentage === "number" ? { averageViewPercentage: values.averageViewPercentage } : {}),
        ...(typeof values.subscribersGained === "number" ? { subscribersGained: values.subscribersGained } : {}),
        ...(typeof values.subscribersLost === "number" ? { subscribersLost: values.subscribersLost } : {}),
        ...(isoDurationSeconds(video?.contentDetails?.duration) !== undefined ? { videoDurationSeconds: isoDurationSeconds(video?.contentDetails?.duration)! } : {}),
        analyticsAvailable: analyticsByVideo.has(contentId), metricSemantics: "period",
        lifetimeViews: typeof lifetime.views === "number" ? lifetime.views : Number(publicStats.viewCount ?? 0),
        ...(typeof lifetime.engagedViews === "number" ? { lifetimeEngagedViews: lifetime.engagedViews } : {}),
        ...(typeof lifetime.estimatedMinutesWatched === "number" ? { lifetimeEstimatedMinutesWatched: lifetime.estimatedMinutesWatched } : {}),
        ...(typeof lifetime.averageViewDuration === "number" ? { lifetimeAverageViewDuration: lifetime.averageViewDuration } : {}),
        ...(typeof lifetime.averageViewPercentage === "number" ? { lifetimeAverageViewPercentage: lifetime.averageViewPercentage } : {}),
        ...(typeof lifetime.subscribersGained === "number" ? { lifetimeSubscribersGained: lifetime.subscribersGained } : {}),
        ...(typeof lifetime.subscribersLost === "number" ? { lifetimeSubscribersLost: lifetime.subscribersLost } : {}),
        lifetimeLikes: typeof lifetime.likes === "number" ? lifetime.likes : Number(publicStats.likeCount ?? 0),
        lifetimeComments: typeof lifetime.comments === "number" ? lifetime.comments : Number(publicStats.commentCount ?? 0), lifetimeCollectedAt: collectedAt
      };
    });
    const notes = contentMetrics.length === 0
      ? ["The authenticated channel has no videos in its uploads playlist and YouTube Analytics returned no video rows."]
      : contentRows.length === 0
        ? [`YouTube Analytics reported no per-video activity rows; wrote zero-valued daily snapshots for ${contentMetrics.length} existing uploads.`]
        : [];
    return { dailyMetrics, contentMetrics, notes };
  }

  private async queryAllContentRows(channelId: string, startDate: string, endDate: string): Promise<youtubeAnalytics_v2.Schema$QueryResponse> {
    const pageSize = 200;
    let startIndex = 1;
    let columnHeaders: youtubeAnalytics_v2.Schema$ResultTableColumnHeader[] = [];
    const rows: unknown[][] = [];
    while (true) {
      const params = {
        ids: `channel==${channelId}`, startDate, endDate, dimensions: "video",
        metrics: CONTENT_METRICS.join(","), sort: "-views", maxResults: pageSize, startIndex
      } satisfies youtubeAnalytics_v2.Params$Resource$Reports$Query;
      const page = await this.services.queryAnalytics(params);
      columnHeaders = page.columnHeaders ?? columnHeaders;
      const pageRows = page.rows ?? [];
      rows.push(...pageRows);
      if (pageRows.length < pageSize) break;
      startIndex += pageSize;
    }
    return { columnHeaders, rows };
  }

  async diagnose(date: string): Promise<YouTubeDiagnosticResult> {
    const channels = await this.services.listChannels({ part: ["id", "snippet", "statistics", "contentDetails"], mine: true });
    const channel = channels[0];
    if (!channel?.id) throw new Error("channels.list(mine=true) returned no channel");
    const info = {
      channelId: channel.id,
      channelTitle: channel.snippet?.title ?? "",
      videoCount: channel.statistics?.videoCount ?? "",
      viewCount: channel.statistics?.viewCount ?? ""
    };
    console.log(`[YouTube Data API] authenticatedChannel=${JSON.stringify(info)}`);

    const run = async (label: string, params: youtubeAnalytics_v2.Params$Resource$Reports$Query) => {
      console.log(`[YouTube Analytics] ${label} request=${JSON.stringify(safeQuery(params))}`);
      try {
        const response = await this.services.queryAnalytics(params);
        console.log(`[YouTube Analytics] ${label} response=${JSON.stringify({ columnHeaders: (response.columnHeaders ?? []).map((header) => ({ name: header.name, columnType: header.columnType, dataType: header.dataType })), rowsCount: response.rows?.length ?? 0 })}`);
        return { response, error: "" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[YouTube Analytics] ${label} response=${JSON.stringify({ columnHeaders: [], rowsCount: 0, error: message })}`);
        return { response: undefined, error: message };
      }
    };
    const base = { ids: "channel==MINE", endDate: date, dimensions: "video" } as const;
    const exactMinimal = await run("exact minimal one-day", { ...base, startDate: date, metrics: "views" });
    const minimal = await run("supported minimal one-day", { ...base, startDate: date, metrics: "views", sort: "-views", maxResults: 200 });
    const metricChecks: { metrics: string; rows: number }[] = [];
    const sevenDayStart = subtractDays(date, 6);
    const sevenDay = await run("supported minimal seven-day", { ...base, startDate: sevenDayStart, metrics: "views", sort: "-views", maxResults: 200 });
    const metricStartDate = (minimal.response?.rows?.length ?? 0) > 0 ? date : sevenDayStart;
    if ((minimal.response?.rows?.length ?? 0) > 0 || (sevenDay.response?.rows?.length ?? 0) > 0) {
      const metrics: string[] = [];
      for (const metric of ["views", "estimatedMinutesWatched", "averageViewDuration", "likes", "comments", "shares"]) {
        metrics.push(metric);
        const check = await run(`metrics ${metrics.join(",")}`, { ...base, startDate: metricStartDate, metrics: metrics.join(","), sort: "-views", maxResults: 200 });
        metricChecks.push({ metrics: metrics.join(","), rows: check.response?.rows?.length ?? 0 });
      }
    }
    const timeline = await run("daily availability", { ids: "channel==MINE", startDate: sevenDayStart, endDate: date, dimensions: "day", metrics: "views", sort: "day" });
    const availableDays = (timeline.response?.rows ?? []).map((row) => String(row[0]));
    const dailyViews = (timeline.response?.rows ?? []).map((row) => ({ date: String(row[0]), views: Number(row[1]) }));
    console.log(`[YouTube Analytics] daily availability=${JSON.stringify(dailyViews)}`);
    const perDayVideoRows: { date: string; rows: number }[] = [];
    for (const availableDate of availableDays) {
      const day = await run(`per-day video ${availableDate}`, { ids: "channel==MINE", startDate: availableDate, endDate: availableDate, dimensions: "video", metrics: "views", sort: "-views", maxResults: 200 });
      perDayVideoRows.push({ date: availableDate, rows: day.response?.rows?.length ?? 0 });
    }
    const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
    const uploadVideoId = uploads ? (await this.services.listPlaylistVideoIds(uploads, 1))[0] ?? "" : "";
    console.log(`[YouTube Data API] uploadsSample=${JSON.stringify({ uploadsPlaylistPresent: Boolean(uploads), videoId: uploadVideoId || null })}`);
    let filteredVideoRows = 0;
    if (uploadVideoId) {
      const filtered = await run("uploads video filter", { ids: "channel==MINE", startDate: sevenDayStart, endDate: date, metrics: "views", filters: `video==${uploadVideoId}` });
      filteredVideoRows = filtered.response?.rows?.length ?? 0;
    }
    return { exactMinimalError: exactMinimal.error, oneDayRows: minimal.response?.rows?.length ?? 0, sevenDayRows: sevenDay.response?.rows?.length ?? 0, availableDays, dailyViews, perDayVideoRows, metricChecks, ...info, uploadVideoId, filteredVideoRows };
  }
}
export type { YouTubeServices };
