import { describe, expect, it } from "vitest";
import { contentMetricKey } from "../src/store/google-sheets.js";
describe("contentMetricKey", () => {
  it("uses date, platform, and contentId", () => {
    expect(contentMetricKey({ date: "2026-08-25", platform: "youtube", contentId: "video-a" })).toBe("2026-08-25|youtube|video-a");
  });
});
