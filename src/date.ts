export function dateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function yesterdayInTimeZone(now: Date, timeZone: string): string {
  return dateInTimeZone(new Date(now.getTime() - 24 * 60 * 60 * 1000), timeZone);
}

export function assertIsoDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`Invalid collection date: ${value}`);
  }
  return value;
}
