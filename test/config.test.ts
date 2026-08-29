import { describe, expect, it } from "vitest";
import { loadConfig, loadPinterestConfig, loadYouTubeConfig } from "../src/config.js";

const commonEnv = {
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  GOOGLE_REFRESH_TOKEN: "refresh-token",
  METRICS_SPREADSHEET_ID: "spreadsheet-id",
  TZ: "Asia/Tokyo"
};

describe("configuration boundaries", () => {
  it("loads common and YouTube config without Pinterest ENV", () => {
    expect(() => loadConfig(commonEnv)).not.toThrow();
    expect(loadYouTubeConfig(commonEnv)).toEqual({ channelId: "mine" });
  });

  it("validates Pinterest ENV only when Pinterest config is loaded", () => {
    expect(() => loadPinterestConfig(commonEnv)).toThrow("PINTEREST_ACCESS_TOKEN");
  });
});
