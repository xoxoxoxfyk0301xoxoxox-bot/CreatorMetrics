import { google, type Auth, type youtube_v3, type youtubeAnalytics_v2 } from "googleapis";
import type { AdapterCollection, CollectionContext, ContentMetricRecord, DailyMetricRecord, MetricsAdapter } from "../types.js";

const DAILY_METRICS = ["views", "estimatedMinutesWatched", "subscribersGained", "subscribersLost", "likes", "comments", "shares"] as const;
const CONTENT_METRICS = ["views", "estimatedMinutesWatched", "likes", "comments", "shares", "averageViewDuration"] as const;

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
        const response = await youtube.videos.list({ part: ["snippet", "liveStreamingDetails"], id: ids.slice(index, index + 50) });
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
    const [dailyReport, contentReport] = await Promise.all([
      this.services.queryAnalytics({ ids: `channel==${channel.id}`, startDate: date, endDate: date, dimensions: "day", metrics: DAILY_METRICS.join(",") }),
      this.queryAllContentRows(channel.id, date)
    ]);
    const dailyRow = dailyReport.rows?.[0];
    const analyticsMetrics = dailyRow ? numericRow(dailyReport.columnHeaders ?? [], dailyRow) : {};
    delete analyticsMetrics.day;
    const stats = channel.statistics ?? {};
    const metrics = { ...analyticsMetrics, channelViewCount: Number(stats.viewCount ?? 0), subscriberCount: Number(stats.subscriberCount ?? 0), videoCount: Number(stats.videoCount ?? 0) };
    const dailyMetrics: DailyMetricRecord[] = [{ date, platform: this.platform, accountId: channel.id, metrics, collectedAt }];

    const contentHeaders = contentReport.columnHeaders ?? [];
    const videoIndex = contentHeaders.findIndex((header) => header.name === "video");
    if ((contentReport.rows?.length ?? 0) > 0 && videoIndex < 0) throw new Error("YouTube Analytics video report did not contain the video dimension");
    const contentRows = contentReport.rows ?? [];
    const analyticsByVideo = new Map(contentRows.map((row) => [String(row[videoIndex]), numericRow(contentHeaders, row)]));
    const uploadsPlaylist = channel.contentDetails?.relatedPlaylists?.uploads;
    const uploadVideoIds = uploadsPlaylist ? await this.services.listPlaylistVideoIds(uploadsPlaylist, 5000) : [];
    const videoIds = [...new Set([...uploadVideoIds, ...analyticsByVideo.keys()])];
    const videos = videoIds.length ? await this.services.listVideos(videoIds) : [];
    const metadata = new Map(videos.filter((video) => video.id).map((video) => [video.id!, video]));
    const contentMetrics: ContentMetricRecord[] = videoIds.map((contentId) => {
      const values = analyticsByVideo.get(contentId) ?? {};
      const video = metadata.get(contentId);
      return {
        date, platform: this.platform, contentId, contentType: video?.liveStreamingDetails ? "live" : "video",
        title: video?.snippet?.title ?? "", publishedAt: video?.snippet?.publishedAt ?? "",
        views: values.views ?? 0, estimatedMinutesWatched: values.estimatedMinutesWatched ?? 0,
        likes: values.likes ?? 0, comments: values.comments ?? 0, shares: values.shares ?? 0,
        averageViewDuration: values.averageViewDuration ?? 0, collectedAt
      };
    });
    const notes = contentMetrics.length === 0
      ? ["The authenticated channel has no videos in its uploads playlist and YouTube Analytics returned no video rows."]
      : contentRows.length === 0
        ? [`YouTube Analytics reported no per-video activity rows; wrote zero-valued daily snapshots for ${contentMetrics.length} existing uploads.`]
        : [];
    return { dailyMetrics, contentMetrics, notes };
  }

  private async queryAllContentRows(channelId: string, date: string): Promise<youtubeAnalytics_v2.Schema$QueryResponse> {
    const pageSize = 200;
    let startIndex = 1;
    let columnHeaders: youtubeAnalytics_v2.Schema$ResultTableColumnHeader[] = [];
    const rows: unknown[][] = [];
    while (true) {
      const params = {
        ids: `channel==${channelId}`, startDate: date, endDate: date, dimensions: "video",
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
