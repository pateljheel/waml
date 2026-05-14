import { z } from "zod";

export const queryModeSchema = z.enum(["substring"]);
export type QueryMode = z.infer<typeof queryModeSchema>;

export const searchJobStatusSchema = z.enum([
  "queued",
  "running",
  "cancelling",
  "cancelled",
  "completed",
  "failed",
]);
export type SearchJobStatus = z.infer<typeof searchJobStatusSchema>;

export const DEFAULT_QUERY_MODE: QueryMode = "substring";

export const notebookSourceSchema = z.object({
  awsProfile: z.string().min(1),
  bucket: z.string().min(1),
  rootPrefix: z.string().default(""),
});

export type NotebookSource = z.infer<typeof notebookSourceSchema>;

export const searchProgressSchema = z.object({
  bytesScanned: z.number().int().nonnegative().default(0),
  objectsScanned: z.number().int().nonnegative().default(0),
  chunksScanned: z.number().int().nonnegative().default(0),
  matchesFound: z.number().int().nonnegative().default(0),
});

export type SearchProgress = z.infer<typeof searchProgressSchema>;

export const searchMatchSchema = z.object({
  objectKey: z.string().min(1),
  lineNumber: z.number().int().positive(),
  lineText: z.string(),
  timestampText: z.string().optional(),
});

export type SearchMatch = z.infer<typeof searchMatchSchema>;

export const searchJobSchema = z.object({
  id: z.string().min(1),
  notebookId: z.string().min(1),
  mode: queryModeSchema.default(DEFAULT_QUERY_MODE),
  pattern: z.string().min(1),
  startTime: z.string().default(""),
  endTime: z.string().default(""),
  source: notebookSourceSchema,
  prefixFilters: z.record(z.string(), z.string()).default({}),
  customPathPattern: z.string().default(""),
  status: searchJobStatusSchema.default("queued"),
  progress: searchProgressSchema.default({}),
  errorMessage: z.string().nullable().default(null),
  cancelRequestedAt: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  finishedAt: z.string().nullable().default(null),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type SearchJob = z.infer<typeof searchJobSchema>;

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

export const searchJobEventTypeSchema = z.enum([
  "job.queued",
  "job.started",
  "job.progress",
  "job.cancelling",
  "job.cancelled",
  "job.completed",
  "job.failed",
  "object.started",
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
