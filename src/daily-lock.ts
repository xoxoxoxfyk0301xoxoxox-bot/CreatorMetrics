import { open, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export const DEFAULT_DAILY_LOCK_PATH = "/tmp/creator-metrics-collector-daily.lock";
interface LockContents { pid: number; nonce: string; startedAt: string }
export interface DailyLock { release(): Promise<void> }
export interface LockOptions { pid?: number; nonce?: string; isPidAlive?: (pid: number) => boolean }

function defaultIsPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function readLock(path: string): Promise<LockContents | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<LockContents>;
    return Number.isInteger(value.pid) && value.pid! > 0 && typeof value.nonce === "string" ? value as LockContents : null;
  } catch { return null; }
}

export async function acquireDailyLock(path = DEFAULT_DAILY_LOCK_PATH, options: LockOptions = {}): Promise<DailyLock> {
  const pid = options.pid ?? process.pid, nonce = options.nonce ?? randomUUID(), isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid, nonce, startedAt: new Date().toISOString() }));
      await handle.close();
      return { async release() { const current = await readLock(path); if (current?.nonce === nonce) await unlink(path).catch(() => undefined); } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readLock(path);
      if (existing && isPidAlive(existing.pid)) throw new Error(`Daily update is already running (pid ${existing.pid}).`);
      await unlink(path).catch((unlinkError) => { if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError; });
    }
  }
  throw new Error("Could not acquire the daily update lock.");
}
