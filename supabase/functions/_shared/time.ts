/**
 * Strict UTC time handling (PLAN.md s.2). Every timestamp must carry an explicit UTC designator
 * ("Z" or "+00:00"). Timezone-free, non-UTC-offset and impossible calendar values are rejected.
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

const UTC_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|\+00:00)$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Milliseconds since epoch for an explicit-UTC ISO timestamp, or null when invalid. */
export function parseUtc(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = UTC_PATTERN.exec(value);
  if (match == null) return null;
  const [, y, mo, d, h, mi, s, frac] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = s == null ? 0 : Number(s);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const millis = frac == null ? 0 : Number(frac.padEnd(3, "0").slice(0, 3));
  const ms = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return ms;
}

/** Start of a UTC calendar day ("YYYY-MM-DD"), or null when invalid. */
export function parseUtcDate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = DATE_PATTERN.exec(value);
  if (match == null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return ms;
}

export function isoUtc(ms: number): string {
  return new Date(ms).toISOString();
}

export function floorUtcToHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/**
 * Original publication time with its precision. A date-only source is the interval
 * [day-start, next-day-start); strict admission uses the latest possible availability.
 */
export type PublishedTime =
  | { precision: "instant"; at: string }
  | { precision: "day"; date: string }
  | { precision: "interval"; start: string; end: string }
  | { precision: "unknown" };

export type PublishedBounds = { earliest: number; latest: number } | null;

/** Earliest and latest possible publication times, or null when undated or invalid. */
export function publishedBounds(published: PublishedTime): PublishedBounds {
  switch (published.precision) {
    case "instant": {
      const at = parseUtc(published.at);
      return at == null ? null : { earliest: at, latest: at };
    }
    case "day": {
      const start = parseUtcDate(published.date);
      return start == null ? null : { earliest: start, latest: start + DAY_MS };
    }
    case "interval": {
      const start = parseUtc(published.start);
      const end = parseUtc(published.end);
      if (start == null || end == null || end < start) return null;
      return { earliest: start, latest: end };
    }
    case "unknown":
      return null;
  }
}

export function describePublished(published: PublishedTime): string {
  switch (published.precision) {
    case "instant":
      return published.at;
    case "day":
      return `${published.date} (date only)`;
    case "interval":
      return `between ${published.start} and ${published.end}`;
    case "unknown":
      return "undated";
  }
}
