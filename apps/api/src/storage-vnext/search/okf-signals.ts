import {
  analyzeOkfMetadata,
  okfDateOnlyToEpochDay
} from "@focowiki/okf";
import type { StorageVnextStructuredMetadata } from "../shared/types.js";

export type OkfSearchSignals = {
  status: "draft" | "stable" | "deprecated" | null;
  trustTier: "unverified" | "machine-confirmed" | "human-reviewed" | null;
  staleAfterEpochDay: number | null;
  generatedAtEpochMs: number | null;
  latestVerifiedAtEpochMs: number | null;
  sourceCount: number | null;
};

export type OkfSearchFilters = {
  status: "draft" | "stable" | "deprecated" | null;
  trustTier: "unverified" | "machine-confirmed" | "human-reviewed" | null;
  freshness: "fresh" | "stale" | null;
  requestEpochDay: number | null;
};

export type OkfSearchFilterInput = {
  okfStatus?: unknown;
  okfTrustTier?: unknown;
  okfFreshness?: unknown;
  requestDate?: unknown;
};

export function createOkfSearchSignals(
  metadata: StorageVnextStructuredMetadata
): OkfSearchSignals {
  const analysis = analyzeOkfMetadata(metadata as Record<string, unknown>, {
    ownership: "source"
  });
  return {
    status: analysis.signals.effectiveStatus,
    trustTier: analysis.signals.trustTier,
    staleAfterEpochDay: analysis.signals.staleAfter === null
      ? null
      : okfDateOnlyToEpochDay(analysis.signals.staleAfter),
    generatedAtEpochMs: toEpochMs(analysis.signals.generatedAt),
    latestVerifiedAtEpochMs: toEpochMs(analysis.signals.latestVerifiedAt),
    sourceCount: analysis.signals.sourceCount
  };
}

export function normalizeOkfSearchFilters(
  input: OkfSearchFilterInput
): OkfSearchFilters {
  const status = optionalEnum(input.okfStatus, ["draft", "stable", "deprecated"]);
  const trustTier = optionalEnum(input.okfTrustTier, [
    "unverified", "machine-confirmed", "human-reviewed"
  ]);
  const freshness = optionalEnum(input.okfFreshness, ["fresh", "stale"]);
  const requestEpochDay = freshness === null
    ? null
    : typeof input.requestDate === "string"
      ? okfDateOnlyToEpochDay(input.requestDate)
      : null;
  if (freshness !== null && requestEpochDay === null) invalidFilters();
  return { status, trustTier, freshness, requestEpochDay };
}

export function normalizeOkfSearchFilterContract(
  input: OkfSearchFilters | undefined
): OkfSearchFilters {
  if (input === undefined) {
    return {
      status: null,
      trustTier: null,
      freshness: null,
      requestEpochDay: null
    };
  }
  const status = nullableKnownEnum(input.status, ["draft", "stable", "deprecated"]);
  const trustTier = nullableKnownEnum(input.trustTier, [
    "unverified", "machine-confirmed", "human-reviewed"
  ]);
  const freshness = nullableKnownEnum(input.freshness, ["fresh", "stale"]);
  const requestEpochDay = input.requestEpochDay;
  if (
    freshness === null && requestEpochDay !== null
    || freshness !== null && !Number.isSafeInteger(requestEpochDay)
  ) invalidFilters();
  return {
    status,
    trustTier,
    freshness,
    requestEpochDay: freshness === null ? null : requestEpochDay
  };
}

export function matchesOkfSearchFilters(
  signals: OkfSearchSignals,
  filters: OkfSearchFilters
): boolean {
  if (filters.status !== null && signals.status !== filters.status) return false;
  if (filters.trustTier !== null && signals.trustTier !== filters.trustTier) return false;
  if (filters.freshness !== null) {
    if (signals.staleAfterEpochDay === null || filters.requestEpochDay === null) return false;
    const stale = signals.staleAfterEpochDay <= filters.requestEpochDay;
    if ((filters.freshness === "stale") !== stale) return false;
  }
  return true;
}

export function hasOkfSearchFilters(filters: OkfSearchFilters): boolean {
  return filters.status !== null
    || filters.trustTier !== null
    || filters.freshness !== null;
}

function optionalEnum<const T extends string>(
  value: unknown,
  values: readonly T[]
): T | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !values.includes(value as T)) invalidFilters();
  return value as T;
}

function nullableKnownEnum<const T extends string>(
  value: unknown,
  values: readonly T[]
): T | null {
  if (value === null) return null;
  if (typeof value !== "string" || !values.includes(value as T)) invalidFilters();
  return value as T;
}

function toEpochMs(value: string | null): number | null {
  if (value === null) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function invalidFilters(): never {
  throw new Error("OKF search filters are invalid");
}
