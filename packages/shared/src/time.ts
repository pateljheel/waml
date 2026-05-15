import type {
  LineTimestampParser,
  PartitionTimeMapping,
  TimePreviewInput,
} from "./index";

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

function getFormatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function getTimeZoneOffsetMs(timeZone: string, epochMs: number) {
  const parts = getFormatter(timeZone).formatToParts(new Date(epochMs));
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;

  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
    0,
  );

  return asUtc - epochMs;
}

function zonedDateTimeToUtc(parts: ParsedParts, timeZone: string) {
  const utcGuess = Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
    0,
  );

  let offset = getTimeZoneOffsetMs(timeZone, utcGuess);
  let resolved = utcGuess - offset;
  const refinedOffset = getTimeZoneOffsetMs(timeZone, resolved);

  if (refinedOffset !== offset) {
    resolved = utcGuess - refinedOffset;
  }

  return resolved;
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

function addPrecisionToParts(parts: ParsedParts) {
  const next = {
    year: parts.year ?? 0,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };

  switch (parts.precision ?? "year") {
    case "year":
      next.year += 1;
      break;
    case "month":
      next.month += 1;
      if (next.month > 12) {
        next.month = 1;
        next.year += 1;
      }
      break;
    case "day": {
      const date = new Date(Date.UTC(next.year, next.month - 1, next.day));
      date.setUTCDate(date.getUTCDate() + 1);
      next.year = date.getUTCFullYear();
      next.month = date.getUTCMonth() + 1;
      next.day = date.getUTCDate();
      break;
    }
    case "hour": {
      const date = new Date(
        Date.UTC(next.year, next.month - 1, next.day, next.hour),
      );
      date.setUTCHours(date.getUTCHours() + 1);
      next.year = date.getUTCFullYear();
      next.month = date.getUTCMonth() + 1;
      next.day = date.getUTCDate();
      next.hour = date.getUTCHours();
      break;
    }
    case "minute": {
      const date = new Date(
        Date.UTC(next.year, next.month - 1, next.day, next.hour, next.minute),
      );
      date.setUTCMinutes(date.getUTCMinutes() + 1);
      next.year = date.getUTCFullYear();
      next.month = date.getUTCMonth() + 1;
      next.day = date.getUTCDate();
      next.hour = date.getUTCHours();
      next.minute = date.getUTCMinutes();
      break;
    }
    case "second": {
      const date = new Date(
        Date.UTC(
          next.year,
          next.month - 1,
          next.day,
          next.hour,
          next.minute,
          next.second,
        ),
      );
      date.setUTCSeconds(date.getUTCSeconds() + 1);
      next.year = date.getUTCFullYear();
      next.month = date.getUTCMonth() + 1;
      next.day = date.getUTCDate();
      next.hour = date.getUTCHours();
      next.minute = date.getUTCMinutes();
      next.second = date.getUTCSeconds();
      break;
    }
  }

  return next;
}

function partsToRange(parts: ParsedParts, timeZone = "UTC") {
  if (!parts.year) {
    return null;
  }

  const start = zonedDateTimeToUtc(parts, timeZone);
  const end = zonedDateTimeToUtc(addPrecisionToParts(parts), timeZone);

  return {
    startEpochMs: start,
    endEpochMs: end,
    start: toIso(start),
    end: toIso(end),
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

function parseAutoTimestamp(value: string, timeZone = "UTC"): ParsedTimestamp | null {
  const direct = Date.parse(value);

  if (!Number.isNaN(direct)) {
    return {
      epochMs: direct,
      iso: toIso(direct),
    };
  }

  const spaced = parseWithFormat(value, "YYYY-MM-DD HH:mm:ss");
  const range = spaced ? partsToRange(spaced, timeZone) : null;

  return range
    ? {
        epochMs: range.startEpochMs,
        iso: range.start,
      }
    : null;
}

function parseTimestampText(
  value: string,
  format?: string,
  timeZone = "UTC",
): ParsedTimestamp | null {
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
    const range = parts ? partsToRange(parts, timeZone) : null;
    return range
      ? {
          epochMs: range.startEpochMs,
          iso: range.start,
        }
      : null;
  }

  return parseAutoTimestamp(value, timeZone);
}

export function deriveCoarseTimeRangeFromMappings(
  pathMappings: PartitionTimeMapping[],
  partitionValues: Record<string, string>,
  timeZone = "UTC",
) {
  let collectedParts: ParsedParts = {};
  const errors: string[] = [];

  for (const mapping of pathMappings) {
    const rawValue = partitionValues[mapping.partitionKey];

    if (!rawValue || mapping.component === "none") {
      continue;
    }

    const parsed = parseMappingValue(mapping, rawValue);

    if (!parsed) {
      errors.push(
        `Could not parse partition '${mapping.partitionKey}' with format '${mapping.format ?? mapping.component}'.`,
      );
      continue;
    }

    collectedParts = mergeParts(collectedParts, parsed);
  }

  return {
    range: partsToRange(collectedParts, timeZone),
    errors,
  };
}

export function extractLineTimestamp(
  lineParser: LineTimestampParser,
  sampleLine: string,
  timeZone = "UTC",
) {
  if (lineParser.mode === "none") {
    return {
      extractedText: null,
      lineTimestamp: null,
      errors: [] as string[],
    };
  }

  if (lineParser.mode === "auto") {
    const parsed = sampleLine ? parseAutoTimestamp(sampleLine, timeZone) : null;

    return {
      extractedText: sampleLine || null,
      lineTimestamp: parsed?.iso ?? null,
      errors:
        sampleLine && !parsed
          ? ["Could not auto-parse a timestamp from the sample line."]
          : [],
    };
  }

  try {
    const regex = new RegExp(lineParser.pattern);
    const match = sampleLine.match(regex);
    const extractedText = match?.[lineParser.group] ?? null;

    if (!extractedText) {
      return {
        extractedText: null,
        lineTimestamp: null,
        errors: ["Regex parser did not capture a timestamp from the sample line."],
      };
    }

    const parsed = parseTimestampText(
      extractedText,
      lineParser.format,
      timeZone,
    );

    return {
      extractedText,
      lineTimestamp: parsed?.iso ?? null,
      errors: parsed
        ? []
        : ["Captured timestamp could not be parsed with the configured format."],
    };
  } catch {
    return {
      extractedText: null,
      lineTimestamp: null,
      errors: ["Regex pattern is invalid."],
    };
  }
}

export function parseQueryTimestamp(value: string, timeZone = "UTC") {
  if (!value.trim()) {
    return null;
  }

  const localMatch = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/,
  );

  if (localMatch && !/[zZ]|[+-]\d{2}:\d{2}$/.test(value)) {
    return zonedDateTimeToUtc(
      {
        year: Number(localMatch[1]),
        month: Number(localMatch[2]),
        day: Number(localMatch[3]),
        hour: Number(localMatch[4]),
        minute: Number(localMatch[5]),
        second: Number(localMatch[6] ?? "0"),
      },
      timeZone,
    );
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export function previewTimeConfig(input: TimePreviewInput) {
  const coarseResult = deriveCoarseTimeRangeFromMappings(
    input.pathMappings,
    input.partitionValues,
    input.timezone,
  );
  const lineResult = extractLineTimestamp(
    input.lineParser,
    input.sampleLine,
    input.timezone,
  );
  const errors = [...coarseResult.errors, ...lineResult.errors];

  if (
    !coarseResult.range &&
    input.pathMappings.some((mapping) => mapping.component !== "none")
  ) {
    errors.push(
      "Could not derive a coarse time range from the provided partition mappings.",
    );
  }

  return {
    coarseRange: coarseResult.range
      ? {
          start: coarseResult.range.start,
          end: coarseResult.range.end,
        }
      : null,
    extractedText: lineResult.extractedText,
    lineTimestamp: lineResult.lineTimestamp,
    errors,
  };
}

export function isTimestampInRange(
  epochMs: number,
  startEpochMs: number | null,
  endEpochMs: number | null,
) {
  if (startEpochMs !== null && epochMs < startEpochMs) {
    return false;
  }

  if (endEpochMs !== null && epochMs >= endEpochMs) {
    return false;
  }

  return true;
}

export function doesRangeOverlap(
  range:
    | {
        startEpochMs: number;
        endEpochMs: number;
      }
    | null,
  startEpochMs: number | null,
  endEpochMs: number | null,
) {
  if (!range) {
    return true;
  }

  if (startEpochMs !== null && range.endEpochMs <= startEpochMs) {
    return false;
  }

  if (endEpochMs !== null && range.startEpochMs >= endEpochMs) {
    return false;
  }

  return true;
}
