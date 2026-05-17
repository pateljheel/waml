import {
  getManifestScope,
  listManifestObjects,
  replaceManifestScopeObjects,
} from "@waml/db";
import type {
  PartitionTimeMapping,
  PrefixFilterSelection,
  SearchJob,
} from "@waml/shared";
import type { WorkerObjectStoreReader } from "./storage";

const defaultManifestMaxPrefixes = 512;
const defaultManifestForceRefreshWindowMs = 6 * 60 * 60 * 1000;
const defaultManifestWarmWindowMs = 7 * 24 * 60 * 60 * 1000;
const defaultManifestWarmTtlMs = 2 * 60 * 1000;
const defaultManifestColdTtlMs = 60 * 60 * 1000;

type ScopedObject = {
  key: string;
  versionToken: string;
  etag: string;
  size: number;
  lastModified: string;
};

function getPositiveEnvNumber(name: string, fallback: number) {
  const configured = Number(process.env[name] ?? "");
  return Number.isFinite(configured) && configured > 0
    ? configured
    : fallback;
}

function getManifestMaxPrefixes() {
  return Math.trunc(
    getPositiveEnvNumber(
      "WAML_MANIFEST_MAX_PREFIXES",
      defaultManifestMaxPrefixes,
    ),
  );
}

function getManifestForceRefreshWindowMs() {
  return getPositiveEnvNumber(
    "WAML_MANIFEST_FORCE_REFRESH_WINDOW_MS",
    defaultManifestForceRefreshWindowMs,
  );
}

function getManifestWarmWindowMs() {
  return getPositiveEnvNumber(
    "WAML_MANIFEST_WARM_WINDOW_MS",
    defaultManifestWarmWindowMs,
  );
}

function getManifestWarmTtlMs() {
  return getPositiveEnvNumber(
    "WAML_MANIFEST_WARM_TTL_MS",
    defaultManifestWarmTtlMs,
  );
}

function getManifestColdTtlMs() {
  return getPositiveEnvNumber(
    "WAML_MANIFEST_COLD_TTL_MS",
    defaultManifestColdTtlMs,
  );
}

function getManifestScopeFreshnessPolicy(
  queryStartEpochMs: number | null,
  queryEndEpochMs: number | null,
) {
  if (queryStartEpochMs === null || queryEndEpochMs === null) {
    return {
      forceRefresh: false,
      ttlMs: getManifestColdTtlMs(),
    };
  }

  const now = Date.now();
  const forceRefreshCutoff = now - getManifestForceRefreshWindowMs();
  const warmCutoff = now - getManifestWarmWindowMs();
  const touchesVeryRecentWindow = queryEndEpochMs >= forceRefreshCutoff;

  if (touchesVeryRecentWindow) {
    return {
      forceRefresh: true,
      ttlMs: 0,
    };
  }

  const touchesWarmWindow = queryEndEpochMs >= warmCutoff;

  if (touchesWarmWindow) {
    return {
      forceRefresh: false,
      ttlMs: getManifestWarmTtlMs(),
    };
  }

  return {
    forceRefresh: false,
    ttlMs: getManifestColdTtlMs(),
  };
}

function getFormatter(timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
}

function getZonedParts(epochMs: number, timeZone: string) {
  const values = Object.fromEntries(
    getFormatter(timeZone)
      .formatToParts(new Date(epochMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  ) as Record<string, string>;

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
  };
}

function getRenderableMappingValue(
  mapping: PartitionTimeMapping,
  epochMs: number,
  timeZone: string,
) {
  const parts = getZonedParts(epochMs, timeZone);

  switch (mapping.component) {
    case "year":
      return parts.year;
    case "month":
      return parts.month;
    case "day":
      return parts.day;
    case "hour":
      return parts.hour;
    case "date":
      if (mapping.format === "YYYYMM") {
        return `${parts.year}${parts.month}`;
      }
      if (mapping.format === "YYYY-MM-DD") {
        return `${parts.year}-${parts.month}-${parts.day}`;
      }
      if (mapping.format === "YYYYMMDD") {
        return `${parts.year}${parts.month}${parts.day}`;
      }
      return null;
    case "datetime":
      if (mapping.format === "YYYYMMDDHH") {
        return `${parts.year}${parts.month}${parts.day}${parts.hour}`;
      }
      return null;
    default:
      return null;
  }
}

function getSingleFilterValue(filter: PrefixFilterSelection | undefined) {
  return filter?.mode === "values" && filter.values.length === 1
    ? filter.values[0]
    : null;
}

function getFixedCaptureValue({
  job,
  mappingByKey,
  key,
  epochMs,
}: {
  job: SearchJob;
  mappingByKey: Map<string, PartitionTimeMapping>;
  key: string;
  epochMs: number;
}) {
  const mapping = mappingByKey.get(key);

  if (mapping) {
    return getRenderableMappingValue(mapping, epochMs, job.timeConfig.timezone);
  }

  return getSingleFilterValue(job.prefixFilters[key]);
}

function compileCustomPathPattern(pathPattern: string) {
  return pathPattern
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      const tokens: Array<
        | { type: "literal"; value: string }
        | { type: "capture"; key: string }
      > = [];
      const capturePattern = /\{(?:category|range):([A-Za-z_][A-Za-z0-9_]*)\}/g;
      let lastIndex = 0;

      for (const match of segment.matchAll(capturePattern)) {
        const matchIndex = match.index ?? 0;

        if (matchIndex > lastIndex) {
          tokens.push({
            type: "literal",
            value: segment.slice(lastIndex, matchIndex),
          });
        }

        tokens.push({
          type: "capture",
          key: match[1],
        });
        lastIndex = matchIndex + match[0].length;
      }

      if (lastIndex < segment.length) {
        tokens.push({
          type: "literal",
          value: segment.slice(lastIndex),
        });
      }

      return tokens;
    });
}

function buildScopePrefixesFromCustomPattern({
  job,
  queryStartEpochMs,
  queryEndEpochMs,
}: {
  job: SearchJob;
  queryStartEpochMs: number;
  queryEndEpochMs: number;
}) {
  const segments = compileCustomPathPattern(job.customPathPattern);

  if (segments.length === 0) {
    return null;
  }

  const mappingByKey = new Map(
    job.timeConfig.pathMappings.map((mapping) => [mapping.partitionKey, mapping]),
  );
  const prefixes = new Set<string>();

  for (
    let epochMs = queryStartEpochMs;
    epochMs < queryEndEpochMs;
    epochMs += 60 * 60 * 1000
  ) {
    let prefix = job.source.rootPrefix.trim();
    let stopped = false;

    for (const tokens of segments) {
      let segmentPrefix = "";

      for (const token of tokens) {
        if (token.type === "literal") {
          segmentPrefix += token.value;
          continue;
        }

        const fixedValue = getFixedCaptureValue({
          job,
          mappingByKey,
          key: token.key,
          epochMs,
        });

        if (fixedValue === null) {
          prefixes.add(prefix + segmentPrefix);
          stopped = true;
          break;
        }

        segmentPrefix += fixedValue;
      }

      if (stopped) {
        break;
      }

      prefix += `${segmentPrefix}/`;
    }

    if (!stopped) {
      prefixes.add(prefix);
    }

    if (prefixes.size > getManifestMaxPrefixes()) {
      return null;
    }
  }

  return prefixes.size > 0
    ? [...prefixes.values()]
        .filter((value) => value.length > 0)
        .sort((left, right) => left.localeCompare(right))
    : null;
}

function buildScopePrefixesForMappings({
  job,
  queryStartEpochMs,
  queryEndEpochMs,
}: {
  job: SearchJob;
  queryStartEpochMs: number;
  queryEndEpochMs: number;
}) {
  if (job.customPathPattern.trim()) {
    return buildScopePrefixesFromCustomPattern({
      job,
      queryStartEpochMs,
      queryEndEpochMs,
    });
  }

  if (job.timeConfig.pathMappings.length === 0 || queryEndEpochMs <= queryStartEpochMs) {
    return null;
  }

  for (
    let mappingCount = job.timeConfig.pathMappings.length;
    mappingCount >= 1;
    mappingCount -= 1
  ) {
    const renderableMappings = job.timeConfig.pathMappings.slice(0, mappingCount);
    const prefixes = new Set<string>();

    for (
      let epochMs = queryStartEpochMs;
      epochMs < queryEndEpochMs;
      epochMs += 60 * 60 * 1000
    ) {
      const renderedValues = renderableMappings.map((mapping) =>
        getRenderableMappingValue(mapping, epochMs, job.timeConfig.timezone),
      );

      if (renderedValues.some((value) => value === null)) {
        prefixes.clear();
        break;
      }

      prefixes.add(
        `${job.source.rootPrefix.trim()}${renderableMappings
          .map((mapping, index) => `${mapping.partitionKey}=${renderedValues[index]}/`)
          .join("")}`,
      );

      if (prefixes.size > getManifestMaxPrefixes()) {
        prefixes.clear();
        break;
      }
    }

    if (prefixes.size > 0) {
      return [...prefixes.values()].sort((left, right) => left.localeCompare(right));
    }
  }

  return null;
}

export function deriveManifestScopePrefixes(
  job: SearchJob,
  queryStartEpochMs: number | null,
  queryEndEpochMs: number | null,
) {
  const rootPrefix = job.source.rootPrefix.trim();

  if (queryStartEpochMs === null || queryEndEpochMs === null) {
    return [rootPrefix];
  }

  const scopePrefixes =
    buildScopePrefixesForMappings({
      job,
      queryStartEpochMs,
      queryEndEpochMs,
    }) ?? [rootPrefix];

  return scopePrefixes;
}

async function refreshManifestScope({
  reader,
  provider,
  bucket,
  rootPrefix,
  scopePrefix,
}: {
  reader: WorkerObjectStoreReader;
  provider: SearchJob["source"]["provider"];
  bucket: string;
  rootPrefix: string;
  scopePrefix: string;
}) {
  const objects: ScopedObject[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await reader.listObjectsPage({
      bucket,
      prefix: scopePrefix.trim(),
      continuationToken,
      maxKeys: 1000,
    });

    for (const entry of response.objects) {
      if (!entry.key || entry.key === scopePrefix) {
        continue;
      }

      objects.push({
        key: entry.key,
        versionToken: entry.etag,
        etag: entry.etag,
        size: entry.size,
        lastModified: entry.lastModified,
      });
    }

    continuationToken = response.nextContinuationToken ?? undefined;
  } while (continuationToken);

  replaceManifestScopeObjects({
    provider,
    bucket,
    rootPrefix,
    scopePrefix,
    objects: objects.map((object) => ({
      objectKey: object.key,
      versionToken: object.versionToken,
      etag: object.etag,
      size: object.size,
      lastModified: object.lastModified,
    })),
  });

  return objects.sort((left, right) => left.key.localeCompare(right.key));
}

export async function loadManifestScopeObjects({
  reader,
  job,
  scopePrefix,
  queryStartEpochMs,
  queryEndEpochMs,
}: {
  reader: WorkerObjectStoreReader;
  job: SearchJob;
  scopePrefix: string;
  queryStartEpochMs: number | null;
  queryEndEpochMs: number | null;
}) {
  const freshnessPolicy = getManifestScopeFreshnessPolicy(
    queryStartEpochMs,
    queryEndEpochMs,
  );
  const manifestScope = getManifestScope(
    job.source.provider,
    job.source.bucket,
    job.source.rootPrefix.trim(),
    scopePrefix,
  );

  if (manifestScope && !freshnessPolicy.forceRefresh) {
    const ageMs = Date.now() - Date.parse(manifestScope.lastRefreshedAt);

    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= freshnessPolicy.ttlMs) {
      const cachedObjects = listManifestObjects(
        job.source.provider,
        job.source.bucket,
        job.source.rootPrefix.trim(),
        scopePrefix,
      ).map((object) => ({
        key: object.objectKey,
        versionToken: object.versionToken,
        etag: object.etag,
        size: object.size,
        lastModified: object.lastModified,
      }));

      if (cachedObjects.length > 0) {
        return cachedObjects;
      }
    }
  }

  return refreshManifestScope({
    reader,
    provider: job.source.provider,
    bucket: job.source.bucket,
    rootPrefix: job.source.rootPrefix.trim(),
    scopePrefix,
  });
}
