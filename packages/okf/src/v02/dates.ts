const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const DAY_MS = 86_400_000;

export function normalizeOkfDateOnly(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = DATE_ONLY.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const instant = new Date(Date.UTC(year, month - 1, day));
  if (
    instant.getUTCFullYear() !== year
    || instant.getUTCMonth() !== month - 1
    || instant.getUTCDate() !== day
  ) {
    return null;
  }
  return value;
}

export function normalizeOkfDateTime(value: unknown): string | null {
  if (typeof value !== "string" || !INSTANT.test(value)) return null;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : null;
}

export function okfDateOnlyToEpochDay(value: string): number | null {
  const normalized = normalizeOkfDateOnly(value);
  return normalized === null ? null : Math.floor(Date.parse(`${normalized}T00:00:00Z`) / DAY_MS);
}

export function compareOkfDateOnly(left: string, right: string): number | null {
  const leftDay = okfDateOnlyToEpochDay(left);
  const rightDay = okfDateOnlyToEpochDay(right);
  return leftDay === null || rightDay === null ? null : leftDay - rightDay;
}
