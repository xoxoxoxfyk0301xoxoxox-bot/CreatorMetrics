import { describe, expect, it, vi } from "vitest";
import type { Auth } from "googleapis";
import { YouTubeAdapter, type YouTubeServices } from "../src/adapters/youtube.js";

describe("YouTubeAdapter", () => {
  it("collects daily performance for an existing video not published on that date", async () => {
    const queries: string[] = [];
    const services: YouTubeServices = {
      async listChannels() { return [{ id: "channel", statistics: { viewCount: "100", subscriberCount: "5", videoCount: "1" } }]; },
      async queryAnalytics(params) {
        queries.push(params.dimensions ?? "");
        if (params.dimensions === "day") return { columnHeaders: [{ name: "day" }, { name: "views" }], rows: [["2026-08-25", 20]] };
        return { columnHeaders: [{ name: "video" }, { name: "views" }, { name: "estimatedMinutesWatched" }, { name: "likes" }, { name: "comments" }, { name: "shares" }, { name: "averageViewDuration" }], rows: [["old-video", 20, 40, 3, 1, 2, 120]] };
      },
      async listVideos() { return [{ id: "old-video", snippet: { title: "Old video", publishedAt: "2024-01-01T00:00:00Z" } }]; },
      async listPlaylistVideoIds() { return ["old-video"]; }
    };
    const result = await new YouTubeAdapter({} as Auth.OAuth2Client, "mine", services).collect({ date: "2026-08-25", timeZone: "Asia/Tokyo" });
    expect(queries).toContain("video");
    expect(result.contentMetrics[0]).toMatchObject({ date: "2026-08-25", contentId: "old-video", publishedAt: "2024-01-01T00:00:00Z", views: 20 });
  });

  it("returns zero-valued snapshots for existing uploads when Analytics has no video rows", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const services: YouTubeServices = {
      async listChannels() { return [{ id: "channel", contentDetails: { relatedPlaylists: { uploads: "uploads" } }, statistics: { viewCount: "100", subscriberCount: "5", videoCount: "2" } }]; },
      async queryAnalytics(params) {
        if (params.dimensions === "day") return { columnHeaders: [{ name: "day" }, { name: "views" }], rows: [["2026-08-20", 0]] };
        return { columnHeaders: [{ name: "video" }, { name: "views" }], rows: [] };
      },
      async listVideos(ids) { return ids.map((id) => ({ id, snippet: { title: id, publishedAt: "2024-01-01T00:00:00Z" } })); },
      async listPlaylistVideoIds() { return ["old-a", "old-b"]; }
    };
    const result = await new YouTubeAdapter({} as Auth.OAuth2Client, "mine", services).collect({ date: "2026-08-20", timeZone: "Asia/Tokyo" });
    expect(result.contentMetrics).toHaveLength(2);
    expect(result.contentMetrics).toEqual(expect.arrayContaining([expect.objectContaining({ contentId: "old-a", views: 0 }), expect.objectContaining({ contentId: "old-b", views: 0 })]));
    expect(result.notes[0]).toContain("zero-valued daily snapshots");
    expect(output).not.toHaveBeenCalled();
    output.mockRestore();
  });
});
