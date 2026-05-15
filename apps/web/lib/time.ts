import "server-only";

import type {
  LineTimestampParser,
  PartitionTimeMapping,
  TimePreviewInput,
} from "@waml/shared";

type Precision =
  | "year"
  | "month"
  | "day"
  | "hour"
  | "minute"
  | "second";

type ParsedParts = {
  year?: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
  second?: number;
  precision?: Precision;
};

type ParsedTimestamp = {
  epochMs: number;
  iso: string;
};

function toIso(epochMs: number) {
  return new Date(epochMs).toISOString();
}

function parseInteger(value: string, length?: number) {
  if (length && value.length !== length) {
    return null;
  }

  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseWithFormat(value: string, format?: string): ParsedParts | null {
  if (!format) {
    return null;
  }

  if (format === "YYYY") {
    const year = parseInteger(value, 4);
    return year === null ? null : { year, precision: "year" };
  }

  if (format === "YYYYMM") {
    const match = value.match(/^(\d{4})(\d{2})$/);
    return match
      ? {
          year: Number(match[1]),
          month: Number(match[2]),
          precision: "month",
        }
      : null;
  }

  if (format === "YYYY-MM-DD") {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match
      ? {
          year: Number(match[1]),
          month: Number(match[2]),
          day: Number(match[3]),
          precision: "day",
        }
      : null;
  }

  if (format === "YYYYMMDD") {
    const match = value.match(/^(\d{4})(\d{2})(\d{2})$/);
    return match
      ? {
          year: Number(match[1]),
          month: Number(match[2]),
          day: Number(match[3]),
          precision: "day",
        }
      : null;
  }

  if (format === "YYYYMMDDHH") {
    const match = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})$/);
    return match
      ? {
          year: Number(match[1]),
          month: Number(match[2]),
          day: Number(match[3]),
          hour: Number(match[4]),
          precision: "hour",
        }
      : null;
  }

  if (format === "YYYY-MM-DD HH:mm:ss") {
    const match = value.match(
      /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/,
    );
    return match
      ? {
          year: Number(match[1]),
          month: Number(match[2]),
          day: Number(match[3]),
          hour: Number(match[4]),
          minute: Number(match[5]),
          second: Number(match[6]),
          precision: "second",
        }
      : null;
  }

  if (format === "YYYY-MM-DDTHH:mm:ssZ") {
    const match = value.match(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/,
    );
    return match
      ? {
          year: Number(match[1]),
          month: Number(match[2]),
          day: Number(match[3]),
          hour: Number(match[4]),
          minute: Number(match[5]),
          second: Number(match[6]),
          precision: "second",
        }
      : null;
  }

  if (format === "unix_seconds") {
    const parsed = parseInteger(value);
    return parsed === null
      ? null
      : {
          year: new Date(parsed * 1000).getUTCFullYear(),
          month: new Date(parsed * 1000).getUTCMonth() + 1,
          day: new Date(parsed * 1000).getUTCDate(),
          hour: new Date(parsed * 1000).getUTCHours(),
          minute: new Date(parsed * 1000).getUTCMinutes(),
          second: new Date(parsed * 1000).getUTCSeconds(),
          precision: "second",
        };
  }

  if (format === "unix_millis") {
    const parsed = parseInteger(value);
    return parsed === null
      ? null
      : {
          year: new Date(parsed).getUTCFullYear(),
          month: new Date(parsed).getUTCMonth() + 1,
          day: new Date(parsed).getUTCDate(),
          hour: new Date(parsed).getUTCHours(),
          minute: new Date(parsed).getUTCMinutes(),
          second: new Date(parsed).getUTCSeconds(),
          precision: "second",
        };
  }

  return null;
}

function precisionRank(precision: Precision) {
  switch (precision) {
    case "year":
      return 1;
    case "month":
      return 2;
    case "day":
      return 3;
    case "hour":
      return 4;
    case "minute":
      return 5;
    case "second":
      return 6;
  }
}

function mergeParts(target: ParsedParts, source: ParsedParts) {
  const next: ParsedParts = {
    ...target,
    ...source,
  };

  if (!target.precision) {
    next.precision = source.precision;
  } else if (source.precision) {
    next.precision =
      precisionRank(source.precision) > precisionRank(target.precision)
        ? source.precision
        : target.precision;
  }

  return next;
}

function partsToRange(parts: ParsedParts) {
  if (!parts.year) {
    return null;
  }

  const start = Date.UTC(
    parts.year,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
    0,
  );

  const endDate = new Date(start);
  switch (parts.precision ?? "year") {
    case "year":
      endDate.setUTCFullYear(endDate.getUTCFullYear() + 1);
      break;
    case "month":
      endDate.setUTCMonth(endDate.getUTCMonth() + 1);
      break;
    case "day":
      endDate.setUTCDate(endDate.getUTCDate() + 1);
      break;
    case "hour":
      endDate.setUTCHours(endDate.getUTCHours() + 1);
      break;
    case "minute":
      endDate.setUTCMinutes(endDate.getUTCMinutes() + 1);
      break;
    case "second":
      endDate.setUTCSeconds(endDate.getUTCSeconds() + 1);
      break;
  }

  return {
    startEpochMs: start,
    endEpochMs: endDate.getTime(),
    start: toIso(start),
    end: toIso(endDate.getTime()),
  };
}

function parseMappingValue(mapping: PartitionTimeMapping, value: string): ParsedParts | null {
  switch (mapping.component) {
    case "none":
      return {};
    case "year": {
      const year = parseInteger(value, 4);
      return year === null ? null : { year, precision: "year" };
    }
    case "month": {
      const month = parseInteger(value);
      return month === null ? null : { month, precision: "month" };
    }
    case "day": {
      const day = parseInteger(value);
      return day === null ? null : { day, precision: "day" };
    }
    case "hour": {
      const hour = parseInteger(value);
      return hour === null ? null : { hour, precision: "hour" };
    }
    case "minute": {
      const minute = parseInteger(value);
      return minute === null ? null : { minute, precision: "minute" };
    }
    case "second": {
      const second = parseInteger(value);
      return second === null ? null : { second, precision: "second" };
    }
    case "date":
    case "datetime":
      return parseWithFormat(value, mapping.format);
  }
}

function parseAutoTimestamp(value: string): ParsedTimestamp | null {
  const direct = Date.parse(value);

  if (!Number.isNaN(direct)) {
    return {
      epochMs: direct,
      iso: toIso(direct),
    };
  }

  const spaced = parseWithFormat(value, "YYYY-MM-DD HH:mm:ss");
  const range = spaced ? partsToRange(spaced) : null;

  return range
    ? {
        epochMs: range.startEpochMs,
        iso: range.start,
      }
    : null;
}

function parseTimestampText(value: string, format?: string): ParsedTimestamp | null {
  if (format) {
    if (format === "unix_seconds") {
      const parsed = parseInteger(value);
      return parsed === null
        ? null
        : { epochMs: parsed * 1000, iso: toIso(parsed * 1000) };
    }

    if (format === "unix_millis") {
      const parsed = parseInteger(value);
      return parsed === null ? null : { epochMs: parsed, iso: toIso(parsed) };
    }

    const parts = parseWithFormat(value, format);
    const range = parts ? partsToRange(parts) : null;
    return range
      ? {
          epochMs: range.startEpochMs,
          iso: range.start,
        }
      : null;
  }

  return parseAutoTimestamp(value);
}

export function previewTimeConfig(input: TimePreviewInput) {
  const errors: string[] = [];
  let collectedParts: ParsedParts = {};

  for (const mapping of input.pathMappings) {
    const rawValue = input.partitionValues[mapping.partitionKey];

    if (!rawValue || mapping.component === "none") {
      continue;
    }

    const parsed = parseMappingValue(mapping, rawValue);

    if (!parsed) {
      errors.push(`Could not parse partition '${mapping.partitionKey}' with format '${mapping.format ?? mapping.component}'.`);
      continue;
    }

    collectedParts = mergeParts(collectedParts, parsed);
  }

  const coarseRange = partsToRange(collectedParts);
  if (!coarseRange && input.pathMappings.some((mapping) => mapping.component !== "none")) {
    errors.push("Could not derive a coarse time range from the provided partition mappings.");
  }

  let extractedText: string | null = null;
  let lineTimestamp: string | null = null;

  if (input.lineParser.mode === "auto") {
    extractedText = input.sampleLine || null;
    const parsed = input.sampleLine ? parseAutoTimestamp(input.sampleLine) : null;
    if (input.sampleLine && !parsed) {
      errors.push("Could not auto-parse a timestamp from the sample line.");
    }
    lineTimestamp = parsed?.iso ?? null;
  }

  if (input.lineParser.mode === "regex") {
    try {
      const regex = new RegExp(input.lineParser.pattern);
      const match = input.sampleLine.match(regex);
      extractedText = match?.[input.lineParser.group] ?? null;

      if (!extractedText) {
        errors.push("Regex parser did not capture a timestamp from the sample line.");
      } else {
        const parsed = parseTimestampText(extractedText, input.lineParser.format);
        if (!parsed) {
          errors.push("Captured timestamp could not be parsed with the configured format.");
        }
        lineTimestamp = parsed?.iso ?? null;
      }
    } catch {
      errors.push("Regex pattern is invalid.");
    }
  }

  return {
    coarseRange: coarseRange
      ? {
          start: coarseRange.start,
          end: coarseRange.end,
        }
      : null,
    extractedText,
    lineTimestamp,
    errors,
  };
}
