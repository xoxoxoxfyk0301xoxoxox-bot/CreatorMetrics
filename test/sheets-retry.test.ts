import { describe, expect, it, vi } from "vitest";
import { AmbiguousSheetsWriteError, TransientSheetsError, withIdempotentSheetsAppend, withSheetsRetry } from "../src/posting/sheets-retry.js";

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });
const sleeper = () => vi.fn(async (_ms: number) => undefined);
const policy = (sleep: (ms: number) => Promise<void> = sleeper()) => ({ maxAttempts: 4, baseDelayMs: 1_000, jitterRatio: 0, random: () => 0.5, sleep });

describe("Google Sheets transient retry", () => {
  it.each([503, 429])("retries HTTP %s and recovers", async (status) => {
    const sleep = sleeper(), operation = vi.fn()
      .mockRejectedValueOnce(httpError(status)).mockResolvedValue("ok");
    await expect(withSheetsRetry(operation, policy(sleep))).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("does not retry a non-transient HTTP 400", async () => {
    const sleep = sleeper(), operation = vi.fn().mockRejectedValue(httpError(400));
    await expect(withSheetsRetry(operation, policy(sleep))).rejects.toThrow("HTTP 400");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops after four attempts and identifies the dependency failure", async () => {
    const sleep = sleeper(), operation = vi.fn().mockRejectedValue(httpError(503));
    await expect(withSheetsRetry(operation, policy(sleep))).rejects.toBeInstanceOf(TransientSheetsError);
    expect(operation).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000, 4_000]);
  });

  it("does not duplicate an append that succeeded before its response failed",async()=>{
    const rows:string[]=[];let calls=0;
    const result=await withIdempotentSheetsAppend(async()=>{calls++;rows.push("history-1");throw httpError(503);},async()=>rows.includes("history-1"),policy());
    expect(result.recoveredAmbiguousWrite).toBe(true);expect(calls).toBe(1);expect(rows).toEqual(["history-1"]);
  });

  it("retries append only after confirming the first request was not applied",async()=>{
    const rows:string[]=[];let calls=0;
    await withIdempotentSheetsAppend(async()=>{calls++;if(calls===1)throw httpError(503);rows.push("history-1");},async()=>false,policy());
    expect(calls).toBe(2);expect(rows).toEqual(["history-1"]);
  });

  it("stops an append retry when the ambiguous result cannot be confirmed",async()=>{
    let calls=0;
    await expect(withIdempotentSheetsAppend(async()=>{calls++;throw httpError(503);},async()=>{throw httpError(503);},policy())).rejects.toBeInstanceOf(AmbiguousSheetsWriteError);
    expect(calls).toBe(1);
  });
});
