import { describe, expect, it } from "vitest";
import { yesterdayInTimeZone } from "../src/date.js";

describe("yesterdayInTimeZone", () => {
  it("uses Asia/Tokyo calendar boundaries", () => {
    expect(yesterdayInTimeZone(new Date("2026-08-26T00:30:00Z"), "Asia/Tokyo")).toBe("2026-08-25");
  });
});
