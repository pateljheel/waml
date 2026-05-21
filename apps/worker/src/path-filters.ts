import { normalizePrefixFilters } from "@waml/shared";
import type { SearchJob } from "@waml/shared";

export function extractHiveValues(relativePath: string) {
  const values: Record<string, string> = {};
  const segments = relativePath.split("/").filter(Boolean);

  for (const segment of segments) {
    const match = segment.match(/^([^=\/]+)=(.+)$/);

    if (match) {
      values[match[1]] = match[2];
    }
  }

  return values;
}

type CustomPatternPart =
  | { type: "literal"; value: string }
  | { type: "capture"; key: string };

type CompiledCustomPathPattern = {
  captures: Array<{ key: string }>;
  segments: CustomPatternPart[][];
};

function normalizePathPattern(pathPattern?: string) {
  const value = (pathPattern ?? "").trim();
  let start = 0;
  let end = value.length;

  while (start < end && value.charCodeAt(start) === 47) {
    start += 1;
  }

  while (end > start && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }

  return value.slice(start, end);
}

function trimTrailingSlashes(value: string) {
  let end = value.length;

  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }

  return value.slice(0, end);
}

function parseCustomPatternSegment(segment: string) {
  const capturePattern = /\{(category|range):([A-Za-z_][A-Za-z0-9_]*)\}/g;
  const parts: CustomPatternPart[] = [];
  let lastIndex = 0;

  for (const match of segment.matchAll(capturePattern)) {
    const [fullMatch, , key] = match;
    const matchIndex = match.index ?? 0;
    const literal = segment.slice(lastIndex, matchIndex);

    if (literal) {
      parts.push({ type: "literal", value: literal });
    }

    parts.push({ type: "capture", key });
    lastIndex = matchIndex + fullMatch.length;
  }

  const trailingLiteral = segment.slice(lastIndex);

  if (trailingLiteral) {
    parts.push({ type: "literal", value: trailingLiteral });
  }

  return parts;
}

function isAmbiguousCustomPatternSegment(parts: CustomPatternPart[]) {
  let seenCapture = false;

  for (let index = 0; index < parts.length - 1; index += 1) {
    if (parts[index]?.type === "capture" && parts[index + 1]?.type === "capture") {
      return true;
    }

    if (parts[index]?.type === "capture") {
      seenCapture = true;
    }
  }

  return seenCapture && parts.every((part) => part.type === "capture");
}

function compileCustomPathPattern(pathPattern: string) {
  const normalizedPattern = normalizePathPattern(pathPattern);
  const capturePattern = /\{(category|range):([A-Za-z_][A-Za-z0-9_]*)\}/g;
  const captures: Array<{ key: string }> = [];
  const segments = normalizedPattern
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      const parts = parseCustomPatternSegment(segment);

      if (isAmbiguousCustomPatternSegment(parts)) {
        throw new Error(
          "Custom path patterns with adjacent captures in the same segment are not supported. Add a literal separator between captures.",
        );
      }

      for (const part of parts) {
        if (part.type === "capture") {
          captures.push({ key: part.key });
        }
      }

      return parts;
    });

  return {
    captures,
    segments,
  };
}

function matchPatternSegment(
  segment: string,
  parts: CustomPatternPart[],
): Record<string, string> | null {
  if (parts.length === 0) {
    return segment.length === 0 ? {} : null;
  }

  const captures: Record<string, string> = {};
  let offset = 0;

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];

    if (part.type === "literal") {
      if (!segment.startsWith(part.value, offset)) {
        return null;
      }

      offset += part.value.length;
      continue;
    }

    let nextLiteral = "";

    for (let lookahead = index + 1; lookahead < parts.length; lookahead += 1) {
      const lookaheadPart = parts[lookahead];

      if (lookaheadPart?.type === "literal") {
        nextLiteral = lookaheadPart.value;
        break;
      }
    }

    if (!nextLiteral) {
      const value = segment.slice(offset);

      if (!value) {
        return null;
      }

      captures[part.key] = value;
      offset = segment.length;
      continue;
    }

    const nextLiteralIndex = segment.indexOf(nextLiteral, offset);

    if (nextLiteralIndex === -1 || nextLiteralIndex === offset) {
      return null;
    }

    captures[part.key] = segment.slice(offset, nextLiteralIndex);
    offset = nextLiteralIndex;
  }

  return offset === segment.length ? captures : null;
}

function matchCustomPatternPath(
  relativePath: string,
  compiled: CompiledCustomPathPattern,
) {
  const normalizedRelativePath = trimTrailingSlashes(relativePath);
  const segments = normalizedRelativePath.split("/").filter(Boolean);

  if (segments.length !== compiled.segments.length) {
    return null;
  }

  const captures: Record<string, string> = {};

  for (const [index, segment] of segments.entries()) {
    const matchedCaptures = matchPatternSegment(
      segment,
      compiled.segments[index] ?? [],
    );

    if (!matchedCaptures) {
      return null;
    }

    Object.assign(captures, matchedCaptures);
  }

  return captures;
}

export function extractCustomValues(relativePath: string, pathPattern: string) {
  const trimmedPattern = pathPattern.trim();

  if (!trimmedPattern) {
    return null;
  }

  const compiled = compileCustomPathPattern(trimmedPattern);
  const match = matchCustomPatternPath(relativePath, compiled);

  if (!match) {
    return null;
  }

  const values: Record<string, string> = {};

  compiled.captures.forEach((capture, index) => {
    const value = match[capture.key];

    if (value) {
      values[capture.key] = value;
    }
  });

  return values;
}

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
