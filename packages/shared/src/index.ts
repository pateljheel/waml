import { z } from "zod";
export * from "./path-patterns";

export const queryModeSchema = z.enum(["substring", "all_tokens"]);
export type QueryMode = z.infer<typeof queryModeSchema>;

export const searchJobStatusSchema = z.enum([
  "queued",
  "running",
  "paused",
  "cancelling",
  "cancelled",
  "completed",
  "failed",
]);
export type SearchJobStatus = z.infer<typeof searchJobStatusSchema>;

export const DEFAULT_QUERY_MODE: QueryMode = "substring";

export const searchOptionsSchema = z.object({
  caseSensitive: z.boolean().default(false),
});

export type SearchOptions = z.infer<typeof searchOptionsSchema>;

export const storageProviderSchema = z.enum(["s3", "gcs"]);
export type StorageProvider = z.infer<typeof storageProviderSchema>;

export const gcsAuthModeSchema = z.enum(["adc", "service_account"]);
export type GcsAuthMode = z.infer<typeof gcsAuthModeSchema>;

export const notebookSourceSchema = z.object({
  provider: storageProviderSchema.default("s3"),
  awsProfile: z.string().default(""),
  gcpProject: z.string().default(""),
  authMode: gcsAuthModeSchema.default("adc"),
  serviceAccountKeyPath: z.string().default(""),
  bucket: z.string().min(1),
  rootPrefix: z.string().default(""),
});

export type NotebookSource = z.infer<typeof notebookSourceSchema>;

export const timeComponentSchema = z.enum([
  "none",
  "year",
  "month",
  "day",
  "hour",
  "minute",
  "second",
  "date",
  "datetime",
]);

export type TimeComponent = z.infer<typeof timeComponentSchema>;

export const partitionTimeMappingSchema = z.object({
  partitionKey: z.string().min(1),
  component: timeComponentSchema.default("none"),
  format: z.string().optional(),
});

export type PartitionTimeMapping = z.infer<typeof partitionTimeMappingSchema>;

export const lineTimestampParserSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("none"),
  }),
  z.object({
    mode: z.literal("auto"),
  }),
  z.object({
    mode: z.literal("regex"),
    pattern: z.string().min(1),
    group: z.number().int().positive(),
    format: z.string().optional(),
  }),
]);

export type LineTimestampParser = z.infer<typeof lineTimestampParserSchema>;

export const notebookTimeConfigSchema = z.object({
  timezone: z.string().default("UTC"),
  pathMappings: z.array(partitionTimeMappingSchema).default([]),
  lineParser: lineTimestampParserSchema.default({ mode: "none" }),
});

export type NotebookTimeConfig = z.infer<typeof notebookTimeConfigSchema>;

export const searchProgressSchema = z.object({
  bytesScanned: z.number().int().nonnegative().default(0),
  objectsScanned: z.number().int().nonnegative().default(0),
  chunksScanned: z.number().int().nonnegative().default(0),
  matchesFound: z.number().int().nonnegative().default(0),
});

export type SearchProgress = z.infer<typeof searchProgressSchema>;

export const searchMatchSchema = z.object({
  objectKey: z.string().min(1),
  versionToken: z.string().min(1).optional(),
  etag: z.string().min(1).optional(),
  lineNumber: z.number().int().positive(),
  lineText: z.string(),
  timestampText: z.string().optional(),
});

export type SearchMatch = z.infer<typeof searchMatchSchema>;

export const prefixFilterValuesSelectionSchema = z.object({
  mode: z.literal("values"),
  values: z.array(z.string()).default([]),
});

export const prefixFilterRangeSelectionSchema = z.object({
  mode: z.literal("range"),
  start: z.string().default(""),
  end: z.string().default(""),
});

export const prefixFilterSelectionSchema = z.discriminatedUnion("mode", [
  prefixFilterValuesSelectionSchema,
  prefixFilterRangeSelectionSchema,
]);

export type PrefixFilterSelection = z.infer<typeof prefixFilterSelectionSchema>;

function normalizePrefixFilterSelection(
  value: string | string[] | PrefixFilterSelection,
): PrefixFilterSelection | null {
  if (typeof value === "string" || Array.isArray(value)) {
    const values = (Array.isArray(value) ? value : [value]).filter(
      (entry) => entry.trim().length > 0,
    );

    return values.length > 0 ? { mode: "values", values } : null;
  }

  if (value.mode === "values") {
    const values = value.values.filter((entry) => entry.trim().length > 0);
    return values.length > 0 ? { mode: "values", values } : null;
  }

  const start = value.start.trim();
  const end = value.end.trim();

  return start || end ? { mode: "range", start, end } : null;
}

export const prefixFiltersSchema = z
  .record(
    z.string(),
    z.union([
      prefixFilterSelectionSchema,
      z.string(),
      z.array(z.string()),
    ]),
  )
  .transform((filters) => {
    const normalizedEntries: Array<[string, PrefixFilterSelection]> = [];

    for (const [key, value] of Object.entries(filters)) {
      const normalizedValue = normalizePrefixFilterSelection(value);

      if (normalizedValue) {
        normalizedEntries.push([key, normalizedValue]);
      }
    }

    return Object.fromEntries(normalizedEntries);
  })
  .default({});

export type PrefixFilters = z.infer<typeof prefixFiltersSchema>;

export const searchJobSchema = z.object({
  id: z.string().min(1),
  notebookId: z.string().min(1),
  mode: queryModeSchema.default(DEFAULT_QUERY_MODE),
  pattern: z.string().min(1),
  pageSize: z.number().int().positive().default(100),
  requestedResultsCount: z.number().int().nonnegative().default(200),
  searchOptions: searchOptionsSchema.default({}),
  startTime: z.string().default(""),
  endTime: z.string().default(""),
  source: notebookSourceSchema,
  timeConfig: notebookTimeConfigSchema.default({
    timezone: "UTC",
    pathMappings: [],
    lineParser: { mode: "none" },
  }),
  prefixFilters: prefixFiltersSchema,
  customPathPattern: z.string().default(""),
  status: searchJobStatusSchema.default("queued"),
  progress: searchProgressSchema.default({}),
  errorMessage: z.string().nullable().default(null),
  cancelRequestedAt: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  finishedAt: z.string().nullable().default(null),
  scanContinuationToken: z.string().default(""),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type SearchJob = z.infer<typeof searchJobSchema>;

export function normalizePrefixFilters(input: unknown): PrefixFilters {
  const parsed = prefixFiltersSchema.safeParse(input);

  if (parsed.success) {
    return parsed.data;
  }

  return {};
}

export const createSearchJobInputSchema = searchJobSchema.omit({
  id: true,
  status: true,
  progress: true,
  errorMessage: true,
  cancelRequestedAt: true,
  startedAt: true,
  finishedAt: true,
  createdAt: true,
  updatedAt: true,
});

export type CreateSearchJobInput = z.infer<typeof createSearchJobInputSchema>;

export const timePreviewInputSchema = z.object({
  timezone: z.string().default("UTC"),
  pathMappings: z.array(partitionTimeMappingSchema).default([]),
  partitionValues: z.record(z.string(), z.string()).default({}),
  lineParser: lineTimestampParserSchema.default({ mode: "none" }),
  sampleLine: z.string().default(""),
});

export type TimePreviewInput = z.infer<typeof timePreviewInputSchema>;

export const searchJobEventTypeSchema = z.enum([
  "job.queued",
  "job.started",
  "job.progress",
  "job.paused",
  "job.cancelling",
  "job.cancelled",
  "job.completed",
  "job.failed",
  "results.available",
  "cache.hit",
  "cache.miss",
  "cache.write",
  "cache.evicted",
  "object.started",
  "object.skipped",
  "chunk.started",
  "match.batch",
]);

export type SearchJobEventType = z.infer<typeof searchJobEventTypeSchema>;

export const searchJobEventSchema = z.object({
  id: z.number().int().positive(),
  jobId: z.string().min(1),
  sequenceNo: z.number().int().positive(),
  eventType: searchJobEventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().min(1),
});

export type SearchJobEvent = z.infer<typeof searchJobEventSchema>;

export const searchResultsPageSchema = z.object({
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  totalResults: z.number().int().nonnegative(),
  results: z.array(searchMatchSchema),
});

export type SearchResultsPage = z.infer<typeof searchResultsPageSchema>;

export {
  deriveCoarseTimeRangeFromMappings,
  doesRangeOverlap,
  extractLineTimestamp,
  isTimestampInRange,
  parseQueryTimestamp,
  previewTimeConfig,
} from "./time";
