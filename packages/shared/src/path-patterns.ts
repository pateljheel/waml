export type CustomPatternCaptureKind = "category" | "range";

type CustomPatternPart =
  | { type: "literal"; value: string }
  | { type: "capture"; kind: CustomPatternCaptureKind; key: string };

export type CompiledCustomPathPattern = {
  captures: Array<{ kind: CustomPatternCaptureKind; key: string }>;
  normalizedPattern: string;
  segments: CustomPatternPart[][];
};

export function normalizePathPattern(pathPattern?: string) {
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

export function trimTrailingSlashes(value: string) {
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
    const [fullMatch, kind, key] = match;
    const matchIndex = match.index ?? 0;
    const literal = segment.slice(lastIndex, matchIndex);

    if (literal) {
      parts.push({ type: "literal", value: literal });
    }

    parts.push({ type: "capture", kind: kind as CustomPatternCaptureKind, key });
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

export function compileCustomPathPattern(pathPattern: string): CompiledCustomPathPattern {
  const normalizedPattern = normalizePathPattern(pathPattern);
  const captures: Array<{ kind: CustomPatternCaptureKind; key: string }> = [];
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
          captures.push({ kind: part.kind, key: part.key });
        }
      }

      return parts;
    });

  return {
    captures,
    normalizedPattern,
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

export function matchCustomPatternPath(
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

export function canRelativePathMatchPatternPrefix(
  relativePath: string,
  pathPattern: string,
) {
  const compiled = compileCustomPathPattern(pathPattern);

  if (compiled.segments.length === 0) {
    return true;
  }

  const segments = trimTrailingSlashes(relativePath).split("/").filter(Boolean);

  if (segments.length > compiled.segments.length) {
    return false;
  }

  return segments.every((segment, index) =>
    matchPatternSegment(segment, compiled.segments[index] ?? []) !== null,
  );
}

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

  for (const capture of compiled.captures) {
    const value = match[capture.key];

    if (value) {
      values[capture.key] = value;
    }
  }

  return values;
}
