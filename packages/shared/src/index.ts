import { z } from "zod";

export const queryModeSchema = z.enum(["substring"]);
export type QueryMode = z.infer<typeof queryModeSchema>;

export const DEFAULT_QUERY_MODE: QueryMode = "substring";

export const searchJobSchema = z.object({
  id: z.string().min(1),
  mode: queryModeSchema.default(DEFAULT_QUERY_MODE),
  pattern: z.string().min(1),
  startTime: z.string().min(1),
  endTime: z.string().min(1),
  prefixFilters: z.record(z.string(), z.string()).default({}),
  status: z.enum(["pending", "running", "completed", "failed"]).default("pending"),
  createdAt: z.string().min(1),
});

export type SearchJob = z.infer<typeof searchJobSchema>;

export const createSearchJobInputSchema = searchJobSchema.omit({
  id: true,
  status: true,
  createdAt: true,
});

export type CreateSearchJobInput = z.infer<typeof createSearchJobInputSchema>;
