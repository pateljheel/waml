import {
  extractCustomValues,
  extractHiveValues,
  normalizePrefixFilters,
} from "@waml/shared";
import type { SearchJob } from "@waml/shared";

function parseComparableNumber(value: string) {
  if (!/^-?\d+(\.\d+)?$/.test(value.trim())) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseComparableTimestamp(value: string) {
  const trimmed = value.trim();

  if (/^\d{6}$/.test(trimmed)) {
    const year = Number(trimmed.slice(0, 4));
    const month = Number(trimmed.slice(4, 6));
    return Date.UTC(year, month - 1, 1, 0, 0, 0, 0);
  }

  if (/^\d{8}$/.test(trimmed)) {
    const year = Number(trimmed.slice(0, 4));
    const month = Number(trimmed.slice(4, 6));
    const day = Number(trimmed.slice(6, 8));
    return Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  }

  if (/^\d{10}$/.test(trimmed)) {
    const year = Number(trimmed.slice(0, 4));
    const month = Number(trimmed.slice(4, 6));
    const day = Number(trimmed.slice(6, 8));
    const hour = Number(trimmed.slice(8, 10));
    return Date.UTC(year, month - 1, day, hour, 0, 0, 0);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const parsed = Date.parse(`${trimmed}T00:00:00Z`);
    return Number.isNaN(parsed) ? null : parsed;
  }

  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) {
    const parsed = Date.parse(trimmed.replace(" ", "T") + "Z");
    return Number.isNaN(parsed) ? null : parsed;
  }

  if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      trimmed,
    )
  ) {
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

export function compareRangeValues(left: string, right: string) {
  const leftNumber = parseComparableNumber(left);
  const rightNumber = parseComparableNumber(right);

  if (leftNumber !== null && rightNumber !== null) {
    return leftNumber - rightNumber;
  }

  const leftTimestamp = parseComparableTimestamp(left);
  const rightTimestamp = parseComparableTimestamp(right);

  if (leftTimestamp !== null && rightTimestamp !== null) {
    return leftTimestamp - rightTimestamp;
  }

  return left.localeCompare(right);
}

export function objectMatchesFilters(job: SearchJob, objectKey: string) {
  const rootPrefix = job.source.rootPrefix.trim();
  const relativePath = rootPrefix ? objectKey.slice(rootPrefix.length) : objectKey;
  const filterEntries = Object.entries(normalizePrefixFilters(job.prefixFilters));

  if (filterEntries.length === 0) {
    return true;
  }

  const customValues = extractCustomValues(relativePath, job.customPathPattern);
  const values = customValues ?? extractHiveValues(relativePath);

  return filterEntries.every(([key, filter]) => {
    const objectValue = values[key];

    if (!objectValue) {
      return false;
    }

    if (filter.mode === "values") {
      return filter.values.includes(objectValue);
    }

    if (filter.start && compareRangeValues(objectValue, filter.start) < 0) {
      return false;
    }

    if (filter.end && compareRangeValues(objectValue, filter.end) > 0) {
      return false;
    }

    return true;
  });
}
