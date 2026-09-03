import type { PeriodRange } from "./types.js";

function utcDate(value: string): Date { return new Date(`${value}T00:00:00Z`); }
export function addDays(value: string, days: number): string { const date = utcDate(value); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
export function mondayOf(value: string): string { const day = utcDate(value).getUTCDay(); return addDays(value, -(day === 0 ? 6 : day - 1)); }
export function sundayOf(value: string): string { return addDays(mondayOf(value), 6); }
export function comparisonPeriods(asOf: string): { current: PeriodRange; previous: PeriodRange } {
  return {
    current: { start: addDays(asOf, -6), end: asOf },
    previous: { start: addDays(asOf, -13), end: addDays(asOf, -7) }
  };
}
export function datesInRange(range: PeriodRange): string[] { const values: string[] = []; for (let value = range.start; value <= range.end; value = addDays(value, 1)) values.push(value); return values; }
export function monthOf(value: string): string { return value.slice(0, 7); }
export function normalizeYearMonth(value: string): string | null {
  const match = value.match(/^(\d{4})(?:年|[-./])(\d{1,2})(?:月)?$/);
  if (!match) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? `${match[1]}-${String(month).padStart(2, "0")}` : null;
}
export function dateInTokyo(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
