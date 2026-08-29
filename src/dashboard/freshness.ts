import { monthOf, normalizeYearMonth } from "./date.js";
import type { DataQuality, RawDashboardData } from "./types.js";

export const FRESHNESS_THRESHOLDS = { rakutenImportDays: 35 } as const;
export interface Freshness { value: string | null; display: string; quality: DataQuality }

function latest(values: string[]): string | null { return values.filter(Boolean).sort().at(-1) ?? null; }
function ageDays(date: string, asOf: string): number { return Math.floor((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${date.slice(0, 10)}T00:00:00Z`)) / 86_400_000); }

export function calculateFreshness(data: RawDashboardData, asOf: string): Record<"youtube" | "threads" | "note" | "rakuten_affiliate", Freshness> {
  const automated = (platform: string): Freshness => {
    const value = latest([...data.daily.filter((row) => row.platform === platform).map((row) => row.date), ...data.content.filter((row) => row.platform === platform).map((row) => row.date)]);
    return value ? { value, display: value, quality: value < asOf ? "STALE" : "OK" } : { value: null, display: "データなし", quality: "NO_DATA" };
  };
  const importDate = (platform: string): string | null => latest(data.importActivity.filter((row) => row.platform === platform && row.status === "success").map((row) => row.finishedAt));
  const noteImport = importDate("note");
  const noteMonths = data.sales.filter((row) => row.platform === "note" && row.source === "note_sales_summary").map((row) => row.yearMonth || row.periodMonth || "");
  const currentMonth = monthOf(asOf);
  const previousDate = new Date(`${currentMonth}-01T00:00:00Z`); previousDate.setUTCDate(0);
  const acceptedNoteMonths = new Set([currentMonth, monthOf(previousDate.toISOString().slice(0, 10))]);
  const noteFresh = noteMonths.some((month) => acceptedNoteMonths.has(normalizeYearMonth(month) ?? ""));
  const rakutenImport = importDate("rakuten_affiliate");
  return {
    youtube: automated("youtube"), threads: automated("threads"),
    note: noteImport ? { value: noteImport, display: noteImport.slice(0, 10), quality: noteFresh ? "OK" : "STALE" } : { value: null, display: "データなし", quality: "NO_DATA" },
    rakuten_affiliate: rakutenImport ? { value: rakutenImport, display: rakutenImport.slice(0, 10), quality: ageDays(rakutenImport, asOf) > FRESHNESS_THRESHOLDS.rakutenImportDays ? "STALE" : "OK" } : { value: null, display: "データなし", quality: "NO_DATA" }
  };
}
