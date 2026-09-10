export interface SheetsRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  jitterRatio: number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  onRetry?: (status: number, attempt: number, delayMs: number) => void;
}

export const DEFAULT_SHEETS_RETRY_POLICY: SheetsRetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  jitterRatio: 0.2,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

export class TransientSheetsError extends Error {
  constructor(public readonly status: number, public readonly attempts: number, cause: unknown) {
    super(`Google Sheets transient dependency failure after ${attempts} attempts (HTTP ${status})`, { cause });
    this.name = "TransientSheetsError";
  }
}

export class AmbiguousSheetsWriteError extends Error {
  constructor(cause: unknown) {
    super("Google Sheets write result is ambiguous; automatic append retry was stopped", { cause });
    this.name = "AmbiguousSheetsWriteError";
  }
}

export function sheetsHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  for (const candidate of [value.response?.status, value.status, value.code]) {
    const status = typeof candidate === "string" ? Number(candidate) : candidate;
    if (typeof status === "number" && Number.isInteger(status)) return status;
  }
  return null;
}

export function isRetryableSheetsError(error: unknown): boolean {
  return [429, 500, 502, 503, 504].includes(sheetsHttpStatus(error) ?? -1);
}

export async function withSheetsRetry<T>(operation: () => Promise<T>, overrides: Partial<SheetsRetryPolicy> = {}): Promise<T> {
  const policy = { ...DEFAULT_SHEETS_RETRY_POLICY, ...overrides };
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const status = sheetsHttpStatus(error);
      if (status === null || !isRetryableSheetsError(error)) throw error;
      if (attempt >= policy.maxAttempts) throw new TransientSheetsError(status, attempt, error);
      const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
      const jitter = exponential * policy.jitterRatio * (policy.random() * 2 - 1);
      const delayMs = Math.max(0, Math.round(exponential + jitter));
      policy.onRetry?.(status, attempt, delayMs);
      await policy.sleep(delayMs);
    }
  }
}

export async function withIdempotentSheetsAppend(
  append: () => Promise<void>,
  alreadyExists: () => Promise<boolean>,
  overrides: Partial<SheetsRetryPolicy> = {},
): Promise<{ recoveredAmbiguousWrite: boolean }> {
  let recoveredAmbiguousWrite = false;
  await withSheetsRetry(async () => {
    try {
      await append();
    } catch (error) {
      if (!isRetryableSheetsError(error)) throw error;
      let exists: boolean;
      try {
        exists = await alreadyExists();
      } catch (confirmationError) {
        // Never resend a non-idempotent append when we cannot prove the first
        // request was absent. This favors a manual reconciliation over duplicates.
        throw new AmbiguousSheetsWriteError(confirmationError);
      }
      if (exists) {
        recoveredAmbiguousWrite = true;
        return;
      }
      throw error;
    }
  }, overrides);
  return { recoveredAmbiguousWrite };
}
