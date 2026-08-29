import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { acquireDailyLock } from "../src/daily-lock.js";

describe("daily process lock", () => {
  it("blocks a concurrent run and releases cleanly", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "cmc-lock-")), "daily.lock");
    const first = await acquireDailyLock(path, { pid: 101, nonce: "first", isPidAlive: () => true });
    await expect(acquireDailyLock(path, { pid: 202, nonce: "second", isPidAlive: () => true })).rejects.toThrow("already running");
    await first.release();
    const second = await acquireDailyLock(path, { pid: 202, nonce: "second", isPidAlive: () => true });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pid: 202, nonce: "second" });
    await second.release();
  });
  it("recovers a stale lock", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "cmc-stale-")), "daily.lock");
    const stale = await acquireDailyLock(path, { pid: 101, nonce: "stale", isPidAlive: () => false });
    const recovered = await acquireDailyLock(path, { pid: 202, nonce: "new", isPidAlive: () => false });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pid: 202, nonce: "new" });
    await stale.release();
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ nonce: "new" });
    await recovered.release();
  });
});
