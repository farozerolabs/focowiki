import { toBundleMarkdownHref } from "./public-bundle-path.js";

export type OkfLogEntry = {
  occurredAt: string;
  action: string;
  message: string;
  changedFileCount?: number;
  links?: Array<{
    path: string;
    title: string;
  }>;
};

export type OkfLogMonthlySummary = {
  month: string;
  publicationCount: number;
  changedFileCount: number;
};

export type OkfLogLimits = {
  maxEntries: number;
  maxBytes: number;
};

export const DEFAULT_OKF_LOG_LIMITS: OkfLogLimits = {
  maxEntries: 100,
  maxBytes: 65_536
};

const FORBIDDEN_LOG_PATTERNS = [
  /\bS3_PREFIX\b/gi,
  /\bs3:\/\/[^\s)]+/gi,
  /\b(?:release|task)-[a-z0-9-]+\b/gi,
  /\b(?:authorization|secret|password|token|object\s*key|storage\s*key|redis\s*key|sql)\b/gi,
  /\/(?:Users|home|private|var|tmp|etc)\/[^\s)]+/gi,
  /(?:^|\/)knowledge-bases\/[^/\s]+\/(?:uploads|releases)\/[^\s)]*/gi
];

export function renderOkfLog(input: {
  entries: OkfLogEntry[];
  summaries?: OkfLogMonthlySummary[];
  limits?: Partial<OkfLogLimits>;
}): string {
  const limits = normalizeLogLimits(input.limits);
  const selectedEntries: OkfLogEntry[] = [];
  const remainingEntries: OkfLogEntry[] = [];
  let candidateEntries = sortLogEntries(input.entries).slice();

  while (candidateEntries.length > 0) {
    const candidate = candidateEntries.shift();

    if (!candidate || selectedEntries.length >= limits.maxEntries) {
      if (candidate) {
        remainingEntries.push(candidate);
      }
      remainingEntries.push(...candidateEntries);
      break;
    }

    const nextEntries = [...selectedEntries, candidate];
    const nextContent = renderLogContent(
      nextEntries,
      combineMonthlySummaries(input.summaries ?? [], summarizeLogEntries(remainingEntries))
    );

    if (byteLength(nextContent) > limits.maxBytes && selectedEntries.length > 0) {
      remainingEntries.push(candidate, ...candidateEntries);
      break;
    }

    selectedEntries.push(candidate);
  }

  const summaries = combineMonthlySummaries(
    input.summaries ?? [],
    summarizeLogEntries(remainingEntries)
  );

  return trimToMaxBytes(renderLogContent(selectedEntries, summaries), limits.maxBytes);
}

function renderLogContent(entries: OkfLogEntry[], summaries: OkfLogMonthlySummary[]): string {
  const lines = ["# Directory Update Log"];
  const grouped = groupLogEntriesByDate(entries);

  for (const [index, [date, dateEntries]] of grouped.entries()) {
    lines.push("", `## ${date}`, "");

    for (const entry of dateEntries) {
      lines.push(renderLogEntryLine(entry));
    }
    if (index === 0) {
      for (const summary of summaries) {
        lines.push(
          `* **History summary**: ${summary.month} contains ${summary.publicationCount} publication events and ${summary.changedFileCount} changed files.`
        );
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

function groupLogEntriesByDate(entries: OkfLogEntry[]): Array<[string, OkfLogEntry[]]> {
  const groups = new Map<string, OkfLogEntry[]>();

  for (const entry of sortLogEntries(entries)) {
    const date = datePart(entry.occurredAt);
    groups.set(date, [...(groups.get(date) ?? []), entry]);
  }

  return Array.from(groups.entries());
}

function renderLogEntryLine(entry: OkfLogEntry): string {
  const action = cleanText(entry.action) || "Update";
  const message = sanitizeLogText(entry.message) || "Updated the knowledge base.";
  const links = (entry.links ?? [])
    .map((link) => ({
      title: cleanText(link.title),
      path: cleanText(link.path)
    }))
    .filter((link) => link.title && isPublicBundlePath(link.path))
    .map((link) => `[${escapeMarkdownLabel(link.title)}](${toBundleMarkdownHref(link.path)})`);
  const linkSuffix = links.length > 0 ? ` ${links.join(", ")}` : "";

  return `* **${escapeMarkdownLabel(action)}**: ${message}${linkSuffix}`;
}

function sortLogEntries(entries: OkfLogEntry[]): OkfLogEntry[] {
  return entries.slice().sort((left, right) => {
    const byTime = right.occurredAt.localeCompare(left.occurredAt);
    return byTime || `${left.action}\u0000${left.message}`.localeCompare(`${right.action}\u0000${right.message}`);
  });
}

function summarizeLogEntries(entries: OkfLogEntry[]): OkfLogMonthlySummary[] {
  const byMonth = new Map<string, OkfLogMonthlySummary>();

  for (const entry of entries) {
    const month = monthPart(entry.occurredAt);
    const existing = byMonth.get(month) ?? {
      month,
      publicationCount: 0,
      changedFileCount: 0
    };
    byMonth.set(month, {
      month,
      publicationCount: existing.publicationCount + 1,
      changedFileCount: existing.changedFileCount + (entry.changedFileCount ?? 0)
    });
  }

  return Array.from(byMonth.values()).sort((left, right) => right.month.localeCompare(left.month));
}

function combineMonthlySummaries(
  left: OkfLogMonthlySummary[],
  right: OkfLogMonthlySummary[]
): OkfLogMonthlySummary[] {
  const byMonth = new Map<string, OkfLogMonthlySummary>();

  for (const summary of [...left, ...right]) {
    const existing = byMonth.get(summary.month) ?? {
      month: summary.month,
      publicationCount: 0,
      changedFileCount: 0
    };
    byMonth.set(summary.month, {
      month: summary.month,
      publicationCount: existing.publicationCount + summary.publicationCount,
      changedFileCount: existing.changedFileCount + summary.changedFileCount
    });
  }

  return Array.from(byMonth.values()).sort((a, b) => b.month.localeCompare(a.month));
}

function normalizeLogLimits(limits: Partial<OkfLogLimits> | undefined): OkfLogLimits {
  return {
    maxEntries: normalizePositiveInteger(limits?.maxEntries, DEFAULT_OKF_LOG_LIMITS.maxEntries),
    maxBytes: normalizePositiveInteger(limits?.maxBytes, DEFAULT_OKF_LOG_LIMITS.maxBytes)
  };
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function datePart(value: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : "1970-01-01";
}

function monthPart(value: string): string {
  return /^\d{4}-\d{2}/.test(value) ? value.slice(0, 7) : "1970-01";
}

function isPublicBundlePath(path: string): boolean {
  return path === "index.md" || path === "log.md" || path === "schema.md" || path.startsWith("pages/");
}

function cleanText(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeLogText(value: string): string {
  return FORBIDDEN_LOG_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, "[redacted]"),
    cleanText(value)
  );
}

function escapeMarkdownLabel(value: string): string {
  return cleanText(value).replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function trimToMaxBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) {
    return value;
  }

  const lines = value.split("\n");
  const kept: string[] = [];

  for (const line of lines) {
    const next = [...kept, line].join("\n");

    if (byteLength(`${next}\n`) > maxBytes) {
      break;
    }

    kept.push(line);
  }

  return `${kept.join("\n").trimEnd()}\n`;
}
