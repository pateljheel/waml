import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CreateSearchJobInput,
  PrefixFilters,
  SearchJob,
  SearchJobEvent,
  SearchMatch,
  SearchJobEventType,
  SearchJobStatus,
} from "@waml/shared";
import { normalizePrefixFilters } from "@waml/shared";

function resolveRepoRoot() {
  const candidates = [
    process.env.WAML_REPO_ROOT,
    process.cwd(),
    __dirname,
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    let current = path.resolve(candidate);

    while (true) {
      if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) {
        return current;
      }

      const parent = path.dirname(current);

      if (parent === current) {
        break;
      }

      current = parent;
    }
  }

  return path.resolve(process.cwd());
}

const repoRoot = resolveRepoRoot();
const varDirectory = path.join(repoRoot, "var");
const dataDirectory = path.join(varDirectory, "data");
const cacheDirectory = path.join(varDirectory, "cache");
const databaseFile = path.join(dataDirectory, "waml.db");

type JobRow = {
  id: string;
  notebook_id: string;
  mode: SearchJob["mode"];
  pattern: string;
  page_size: number;
  requested_results_count: number;
  search_options_json: string;
  time_config_json: string;
  start_time: string;
  end_time: string;
  source_json: string;
  prefix_filters_json: string;
  custom_path_pattern: string;
  status: string;
  bytes_scanned: number;
  objects_scanned: number;
  chunks_scanned: number;
  matches_found: number;
  error_message: string | null;
  cancel_requested_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  scan_continuation_token: string;
  created_at: string;
  updated_at: string;
};

type ChunkRow = {
  chunk_pk: string;
  bucket: string;
  object_key: string;
  etag: string;
  chunk_id: string;
  byte_start: number;
  byte_end: number;
  artifact_path: string;
  text_cache_path: string | null;
  cache_size_bytes: number;
  trigram_count: number;
  line_count: number;
  min_timestamp_ms: number | null;
  max_timestamp_ms: number | null;
  created_at: string;
  last_accessed_at: string;
};

type ManifestScopeRow = {
  bucket: string;
  root_prefix: string;
  scope_prefix: string;
  last_refreshed_at: string;
  object_count: number;
};

type ManifestObjectRow = {
  bucket: string;
  root_prefix: string;
  scope_prefix: string;
  object_key: string;
  etag: string;
  size: number;
  last_modified: string;
  discovered_at: string;
  last_seen_at: string;
};

export type CacheChunkRecord = {
  chunkPk: string;
  bucket: string;
  objectKey: string;
  etag: string;
  chunkId: string;
  byteStart: number;
  byteEnd: number;
  artifactPath: string;
  textCachePath: string | null;
  cacheSizeBytes: number;
  trigramCount: number;
  lineCount: number;
  minTimestampMs: number | null;
  maxTimestampMs: number | null;
  createdAt: string;
  lastAccessedAt: string;
};

export type UpsertCacheChunkInput = Omit<
  CacheChunkRecord,
  "createdAt" | "lastAccessedAt"
> & {
  createdAt?: string;
  lastAccessedAt?: string;
};

export type ManifestScopeRecord = {
  bucket: string;
  rootPrefix: string;
  scopePrefix: string;
  lastRefreshedAt: string;
  objectCount: number;
};

export type ManifestObjectRecord = {
  bucket: string;
  rootPrefix: string;
  scopePrefix: string;
  objectKey: string;
  etag: string;
  size: number;
  lastModified: string;
  discoveredAt: string;
  lastSeenAt: string;
};

export function getDatabaseFilePath() {
  return databaseFile;
}

export function getCacheDirectoryPath() {
  return cacheDirectory;
}

export function ensureRuntimeDirectories() {
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.mkdirSync(cacheDirectory, { recursive: true });
}

function getConnection() {
  ensureRuntimeDirectories();
  const db = new DatabaseSync(databaseFile);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string) {
  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;

  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function initializeDatabase() {
  const db = getConnection();

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      notebook_id TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL,
      pattern TEXT NOT NULL,
      page_size INTEGER NOT NULL DEFAULT 100,
      requested_results_count INTEGER NOT NULL DEFAULT 200,
      search_options_json TEXT NOT NULL DEFAULT '{}',
      time_config_json TEXT NOT NULL DEFAULT '{}',
      start_time TEXT NOT NULL DEFAULT '',
      end_time TEXT NOT NULL DEFAULT '',
      source_json TEXT NOT NULL DEFAULT '{}',
      prefix_filters_json TEXT NOT NULL DEFAULT '{}',
      custom_path_pattern TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      bytes_scanned INTEGER NOT NULL DEFAULT 0,
      objects_scanned INTEGER NOT NULL DEFAULT 0,
      chunks_scanned INTEGER NOT NULL DEFAULT 0,
      matches_found INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      cancel_requested_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      scan_continuation_token TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      sequence_no INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(job_id, sequence_no)
    );

    CREATE TABLE IF NOT EXISTS job_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      sequence_no INTEGER NOT NULL,
      object_key TEXT NOT NULL,
      etag TEXT NOT NULL DEFAULT '',
      line_number INTEGER NOT NULL,
      timestamp_text TEXT,
      line_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS build_locks (
      object_key TEXT NOT NULL,
      etag TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (object_key, etag, chunk_id)
    );

    CREATE TABLE IF NOT EXISTS objects (
      object_key TEXT NOT NULL,
      etag TEXT NOT NULL,
      size INTEGER NOT NULL,
      last_modified TEXT NOT NULL,
      year_date TEXT,
      day TEXT,
      hour TEXT,
      discovered_at TEXT NOT NULL,
      PRIMARY KEY (object_key, etag)
    );

    CREATE TABLE IF NOT EXISTS manifest_scopes (
      bucket TEXT NOT NULL,
      root_prefix TEXT NOT NULL,
      scope_prefix TEXT NOT NULL,
      last_refreshed_at TEXT NOT NULL,
      object_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (bucket, root_prefix, scope_prefix)
    );

    CREATE TABLE IF NOT EXISTS manifest_objects (
      bucket TEXT NOT NULL,
      root_prefix TEXT NOT NULL,
      scope_prefix TEXT NOT NULL,
      object_key TEXT NOT NULL,
      etag TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      last_modified TEXT NOT NULL DEFAULT '',
      discovered_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (bucket, root_prefix, scope_prefix, object_key)
    );

    CREATE INDEX IF NOT EXISTS idx_manifest_objects_scope_order
      ON manifest_objects (bucket, root_prefix, scope_prefix, object_key);

    CREATE TABLE IF NOT EXISTS chunks (
      chunk_pk TEXT PRIMARY KEY,
      bucket TEXT NOT NULL DEFAULT '',
      object_key TEXT NOT NULL,
      etag TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      byte_start INTEGER NOT NULL,
      byte_end INTEGER NOT NULL,
      artifact_path TEXT NOT NULL,
      text_cache_path TEXT,
      cache_size_bytes INTEGER NOT NULL DEFAULT 0,
      trigram_count INTEGER NOT NULL DEFAULT 0,
      line_count INTEGER NOT NULL DEFAULT 0,
      min_timestamp_ms INTEGER,
      max_timestamp_ms INTEGER,
      created_at TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL
    );
  `);

  ensureColumn(db, "jobs", "notebook_id", "notebook_id TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "jobs", "source_json", "source_json TEXT NOT NULL DEFAULT '{}'");
  ensureColumn(
    db,
    "jobs",
    "search_options_json",
    "search_options_json TEXT NOT NULL DEFAULT '{}'",
  );
  ensureColumn(
    db,
    "jobs",
    "time_config_json",
    "time_config_json TEXT NOT NULL DEFAULT '{}'",
  );
  ensureColumn(
    db,
    "jobs",
    "prefix_filters_json",
    "prefix_filters_json TEXT NOT NULL DEFAULT '{}'",
  );
  ensureColumn(
    db,
    "jobs",
    "custom_path_pattern",
    "custom_path_pattern TEXT NOT NULL DEFAULT ''",
  );
  ensureColumn(
    db,
    "jobs",
    "page_size",
    "page_size INTEGER NOT NULL DEFAULT 100",
  );
  ensureColumn(
    db,
    "jobs",
    "requested_results_count",
    "requested_results_count INTEGER NOT NULL DEFAULT 200",
  );
  ensureColumn(db, "jobs", "bytes_scanned", "bytes_scanned INTEGER NOT NULL DEFAULT 0");
  ensureColumn(
    db,
    "jobs",
    "objects_scanned",
    "objects_scanned INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(
    db,
    "jobs",
    "chunks_scanned",
    "chunks_scanned INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(
    db,
    "jobs",
    "matches_found",
    "matches_found INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(db, "jobs", "error_message", "error_message TEXT");
  ensureColumn(db, "jobs", "cancel_requested_at", "cancel_requested_at TEXT");
  ensureColumn(db, "jobs", "started_at", "started_at TEXT");
  ensureColumn(db, "jobs", "finished_at", "finished_at TEXT");
  ensureColumn(
    db,
    "jobs",
    "scan_continuation_token",
    "scan_continuation_token TEXT NOT NULL DEFAULT ''",
  );
  ensureColumn(db, "chunks", "bucket", "bucket TEXT NOT NULL DEFAULT ''");
  ensureColumn(
    db,
    "chunks",
    "cache_size_bytes",
    "cache_size_bytes INTEGER NOT NULL DEFAULT 0",
  );
  ensureColumn(db, "chunks", "min_timestamp_ms", "min_timestamp_ms INTEGER");
  ensureColumn(db, "chunks", "max_timestamp_ms", "max_timestamp_ms INTEGER");
  ensureColumn(
    db,
    "job_results",
    "etag",
    "etag TEXT NOT NULL DEFAULT ''",
  );

  return db;
}

function mapChunkRow(row: ChunkRow): CacheChunkRecord {
  return {
    chunkPk: row.chunk_pk,
    bucket: row.bucket,
    objectKey: row.object_key,
    etag: row.etag,
    chunkId: row.chunk_id,
    byteStart: row.byte_start,
    byteEnd: row.byte_end,
    artifactPath: row.artifact_path,
    textCachePath: row.text_cache_path,
    cacheSizeBytes: row.cache_size_bytes ?? 0,
    trigramCount: row.trigram_count ?? 0,
    lineCount: row.line_count ?? 0,
    minTimestampMs: row.min_timestamp_ms,
    maxTimestampMs: row.max_timestamp_ms,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
  };
}

function mapManifestScopeRow(row: ManifestScopeRow): ManifestScopeRecord {
  return {
    bucket: row.bucket,
    rootPrefix: row.root_prefix,
    scopePrefix: row.scope_prefix,
    lastRefreshedAt: row.last_refreshed_at,
    objectCount: row.object_count ?? 0,
  };
}

function mapManifestObjectRow(row: ManifestObjectRow): ManifestObjectRecord {
  return {
    bucket: row.bucket,
    rootPrefix: row.root_prefix,
    scopePrefix: row.scope_prefix,
    objectKey: row.object_key,
    etag: row.etag,
    size: row.size ?? 0,
    lastModified: row.last_modified,
    discoveredAt: row.discovered_at,
    lastSeenAt: row.last_seen_at,
  };
}

function normalizeStatus(status: string): SearchJobStatus {
  if (status === "pending") {
    return "queued";
  }

  if (
    status === "queued" ||
    status === "running" ||
    status === "paused" ||
    status === "cancelling" ||
    status === "cancelled" ||
    status === "completed" ||
    status === "failed"
  ) {
    return status;
  }

  return "failed";
}

function mapJobRow(row: JobRow): SearchJob {
  return {
    id: row.id,
    notebookId: row.notebook_id,
    mode: row.mode,
    pattern: row.pattern,
    pageSize: row.page_size ?? 100,
    requestedResultsCount: row.requested_results_count ?? 200,
    searchOptions: JSON.parse(row.search_options_json || "{}") as SearchJob["searchOptions"],
    timeConfig: JSON.parse(row.time_config_json || "{}") as SearchJob["timeConfig"],
    startTime: row.start_time,
    endTime: row.end_time,
    source: JSON.parse(row.source_json) as SearchJob["source"],
    prefixFilters: normalizePrefixFilters(JSON.parse(row.prefix_filters_json || "{}")),
    customPathPattern: row.custom_path_pattern ?? "",
    status: normalizeStatus(row.status),
    progress: {
      bytesScanned: row.bytes_scanned ?? 0,
      objectsScanned: row.objects_scanned ?? 0,
      chunksScanned: row.chunks_scanned ?? 0,
      matchesFound: row.matches_found ?? 0,
    },
    errorMessage: row.error_message,
    cancelRequestedAt: row.cancel_requested_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    scanContinuationToken: row.scan_continuation_token ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createJob(input: CreateSearchJobInput): SearchJob {
  const db = initializeDatabase();
  const now = new Date().toISOString();
  const job: SearchJob = {
    id: crypto.randomUUID(),
    notebookId: input.notebookId,
    mode: input.mode,
    pattern: input.pattern,
    pageSize: input.pageSize ?? 100,
    requestedResultsCount: input.requestedResultsCount ?? (input.pageSize ?? 100) * 2,
    searchOptions: input.searchOptions ?? {
      caseSensitive: false,
    },
    timeConfig: input.timeConfig ?? {
      timezone: "UTC",
      pathMappings: [],
      lineParser: { mode: "none" },
    },
    startTime: input.startTime ?? "",
    endTime: input.endTime ?? "",
    source: input.source,
    prefixFilters: normalizePrefixFilters(input.prefixFilters),
    customPathPattern: input.customPathPattern ?? "",
    status: "queued",
    progress: {
      bytesScanned: 0,
      objectsScanned: 0,
      chunksScanned: 0,
      matchesFound: 0,
    },
    errorMessage: null,
    cancelRequestedAt: null,
    startedAt: null,
    finishedAt: null,
    scanContinuationToken: "",
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(
    `INSERT INTO jobs (
      id, notebook_id, mode, pattern, page_size, requested_results_count, search_options_json, time_config_json, start_time, end_time, source_json,
      prefix_filters_json, custom_path_pattern, status, bytes_scanned,
      objects_scanned, chunks_scanned, matches_found, error_message,
      cancel_requested_at, started_at, finished_at, scan_continuation_token, created_at, updated_at
    ) VALUES (
      @id, @notebookId, @mode, @pattern, @pageSize, @requestedResultsCount, @searchOptionsJson, @timeConfigJson, @startTime, @endTime, @sourceJson,
      @prefixFiltersJson, @customPathPattern, @status, @bytesScanned,
      @objectsScanned, @chunksScanned, @matchesFound, @errorMessage,
      @cancelRequestedAt, @startedAt, @finishedAt, @scanContinuationToken, @createdAt, @updatedAt
    )`,
  ).run({
    id: job.id,
    notebookId: job.notebookId,
    mode: job.mode,
    pattern: job.pattern,
    pageSize: job.pageSize,
    requestedResultsCount: job.requestedResultsCount,
    searchOptionsJson: JSON.stringify(job.searchOptions),
    timeConfigJson: JSON.stringify(job.timeConfig),
    startTime: job.startTime,
    endTime: job.endTime,
    sourceJson: JSON.stringify(job.source),
    prefixFiltersJson: JSON.stringify(job.prefixFilters),
    customPathPattern: job.customPathPattern,
    status: job.status,
    bytesScanned: job.progress.bytesScanned,
    objectsScanned: job.progress.objectsScanned,
    chunksScanned: job.progress.chunksScanned,
    matchesFound: job.progress.matchesFound,
    errorMessage: job.errorMessage,
    cancelRequestedAt: job.cancelRequestedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    scanContinuationToken: job.scanContinuationToken,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });

  appendJobEvent(job.id, "job.queued", {
    status: job.status,
  });

  return job;
}

export function normalizeStoredPrefixFilters(prefixFilters: unknown): PrefixFilters {
  return normalizePrefixFilters(prefixFilters);
}

export function listJobs(): SearchJob[] {
  const db = initializeDatabase();
  const rows = db
    .prepare("SELECT * FROM jobs ORDER BY created_at DESC")
    .all() as JobRow[];

  return rows.map(mapJobRow);
}

export function getJob(jobId: string) {
  const db = initializeDatabase();
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as
    | JobRow
    | undefined;

  return row ? mapJobRow(row) : null;
}

export function claimNextQueuedJob() {
  const db = initializeDatabase();
  const row = db
    .prepare(
      "SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1",
    )
    .get() as { id: string } | undefined;

  if (!row) {
    return null;
  }

  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE jobs
       SET status = 'running', started_at = ?, updated_at = ?
       WHERE id = ? AND status = 'queued'`,
    )
    .run(now, now, row.id);

  if (result.changes === 0) {
    return null;
  }

  appendJobEvent(row.id, "job.started", {
    startedAt: now,
  });

  return getJob(row.id);
}

export function listJobEvents(jobId: string, afterSequenceNo = 0, limit = 500) {
  const db = initializeDatabase();
  const rows = db
    .prepare(
      `SELECT id, job_id, sequence_no, event_type, payload_json, created_at
       FROM job_events
       WHERE job_id = ? AND sequence_no > ?
       ORDER BY sequence_no ASC
       LIMIT ?`,
    )
    .all(jobId, afterSequenceNo, limit) as Array<{
      id: number;
      job_id: string;
      sequence_no: number;
      event_type: SearchJobEventType;
      payload_json: string;
      created_at: string;
    }>;

  return rows.map(
    (row) =>
      ({
        id: row.id,
        jobId: row.job_id,
        sequenceNo: row.sequence_no,
        eventType: row.event_type,
        payload: JSON.parse(row.payload_json) as Record<string, unknown>,
        createdAt: row.created_at,
      }) satisfies SearchJobEvent,
  );
}

export function appendJobEvent(
  jobId: string,
  eventType: SearchJobEventType,
  payload: Record<string, unknown>,
) {
  const db = initializeDatabase();
  const now = new Date().toISOString();
  const current = db
    .prepare("SELECT COALESCE(MAX(sequence_no), 0) AS sequenceNo FROM job_events WHERE job_id = ?")
    .get(jobId) as { sequenceNo: number };
  const sequenceNo = (current.sequenceNo ?? 0) + 1;

  const result = db
    .prepare(
      `INSERT INTO job_events (job_id, sequence_no, event_type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(jobId, sequenceNo, eventType, JSON.stringify(payload), now);

  return {
    id: Number(result.lastInsertRowid),
    jobId,
    sequenceNo,
    eventType,
    payload,
    createdAt: now,
  } satisfies SearchJobEvent;
}

export function appendJobResults(jobId: string, matches: SearchMatch[]) {
  if (matches.length === 0) {
    return 0;
  }

  const db = initializeDatabase();
  const now = new Date().toISOString();
  const current = db
    .prepare(
      "SELECT COALESCE(MAX(sequence_no), 0) AS sequenceNo FROM job_results WHERE job_id = ?",
    )
    .get(jobId) as { sequenceNo: number };
  let sequenceNo = current.sequenceNo ?? 0;

  const insert = db.prepare(
    `INSERT INTO job_results (
      job_id, sequence_no, object_key, etag, line_number, timestamp_text, line_text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const match of matches) {
    sequenceNo += 1;
    insert.run(
      jobId,
      sequenceNo,
      match.objectKey,
      match.etag ?? "",
      match.lineNumber,
      match.timestampText ?? null,
      match.lineText,
      now,
    );
  }

  return matches.length;
}

export function countJobResults(jobId: string) {
  const db = initializeDatabase();
  const row = db
    .prepare("SELECT COUNT(*) AS total FROM job_results WHERE job_id = ?")
    .get(jobId) as { total: number };

  return row.total ?? 0;
}

export function listJobResultsPage(jobId: string, page: number, pageSize: number) {
  const db = initializeDatabase();
  const safePage = Math.max(1, page);
  const safePageSize = Math.max(1, pageSize);
  const offset = (safePage - 1) * safePageSize;
  const rows = db
    .prepare(
      `SELECT object_key, line_number, timestamp_text, line_text
       , etag
       FROM job_results
       WHERE job_id = ?
       ORDER BY sequence_no ASC
       LIMIT ? OFFSET ?`,
    )
    .all(jobId, safePageSize, offset) as Array<{
      object_key: string;
      etag: string;
      line_number: number;
      timestamp_text: string | null;
      line_text: string;
    }>;

  return rows.map((row) => ({
    objectKey: row.object_key,
    etag: row.etag || undefined,
    lineNumber: row.line_number,
    timestampText: row.timestamp_text ?? undefined,
    lineText: row.line_text,
  }));
}

export function updateJobProgress(
  jobId: string,
  progress: Partial<SearchJob["progress"]>,
  extra: {
    status?: SearchJobStatus;
    errorMessage?: string | null;
    finishedAt?: string | null;
    scanContinuationToken?: string;
    requestedResultsCount?: number;
  } = {},
) {
  const db = initializeDatabase();
  const existing = getJob(jobId);

  if (!existing) {
    return null;
  }

  const nextProgress = {
    bytesScanned: progress.bytesScanned ?? existing.progress.bytesScanned,
    objectsScanned: progress.objectsScanned ?? existing.progress.objectsScanned,
    chunksScanned: progress.chunksScanned ?? existing.progress.chunksScanned,
    matchesFound: progress.matchesFound ?? existing.progress.matchesFound,
  };
  const now = new Date().toISOString();

  db.prepare(
    `UPDATE jobs
     SET bytes_scanned = ?, objects_scanned = ?, chunks_scanned = ?,
         matches_found = ?, status = ?, error_message = ?, finished_at = ?,
         scan_continuation_token = ?, requested_results_count = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    nextProgress.bytesScanned,
    nextProgress.objectsScanned,
    nextProgress.chunksScanned,
    nextProgress.matchesFound,
    extra.status ?? existing.status,
    extra.errorMessage ?? existing.errorMessage,
    extra.finishedAt ?? existing.finishedAt,
    extra.scanContinuationToken ?? existing.scanContinuationToken,
    extra.requestedResultsCount ?? existing.requestedResultsCount,
    now,
    jobId,
  );

  return getJob(jobId);
}

export function requestJobCancellation(jobId: string) {
  const db = initializeDatabase();
  const existing = getJob(jobId);

  if (!existing) {
    return null;
  }

  if (
    existing.status === "completed" ||
    existing.status === "failed" ||
    existing.status === "cancelled"
  ) {
    return existing;
  }

  const now = new Date().toISOString();
  const nextStatus = existing.status === "queued" ? "cancelled" : "cancelling";

  db.prepare(
    `UPDATE jobs
     SET status = ?, cancel_requested_at = ?, finished_at = CASE WHEN ? = 'cancelled' THEN ? ELSE finished_at END, updated_at = ?
     WHERE id = ?`,
  ).run(nextStatus, now, nextStatus, now, now, jobId);

  appendJobEvent(jobId, nextStatus === "cancelled" ? "job.cancelled" : "job.cancelling", {
    cancelRequestedAt: now,
  });

  return getJob(jobId);
}

export function isJobCancellationRequested(jobId: string) {
  const job = getJob(jobId);

  return job?.status === "cancelling" || job?.status === "cancelled";
}

export function completeJob(jobId: string) {
  const now = new Date().toISOString();
  const job = updateJobProgress(
    jobId,
    {},
    {
      status: "completed",
      finishedAt: now,
      errorMessage: null,
      scanContinuationToken: "",
    },
  );

  if (job) {
    appendJobEvent(jobId, "job.completed", {
      finishedAt: now,
      progress: job.progress,
    });
  }

  return job;
}

export function failJob(jobId: string, errorMessage: string) {
  const now = new Date().toISOString();
  const job = updateJobProgress(
    jobId,
    {},
    {
      status: "failed",
      finishedAt: now,
      errorMessage,
      scanContinuationToken: "",
    },
  );

  if (job) {
    appendJobEvent(jobId, "job.failed", {
      finishedAt: now,
      errorMessage,
    });
  }

  return job;
}

export function cancelJob(jobId: string) {
  const now = new Date().toISOString();
  const job = updateJobProgress(
    jobId,
    {},
    {
      status: "cancelled",
      finishedAt: now,
      scanContinuationToken: "",
    },
  );

  if (job) {
    appendJobEvent(jobId, "job.cancelled", {
      finishedAt: now,
      progress: job.progress,
    });
  }

  return job;
}

export function pauseJob(jobId: string, scanContinuationToken: string) {
  const now = new Date().toISOString();
  const job = updateJobProgress(
    jobId,
    {},
    {
      status: "paused",
      scanContinuationToken,
      finishedAt: null,
    },
  );

  if (job) {
    appendJobEvent(jobId, "job.paused", {
      bufferedResults: countJobResults(jobId),
      scanContinuationToken,
      progress: job.progress,
    });
  }

  return job;
}

export function requestMoreResults(jobId: string, additionalResults: number) {
  const existing = getJob(jobId);

  if (!existing) {
    return null;
  }

  if (
    existing.status === "completed" ||
    existing.status === "failed" ||
    existing.status === "cancelled"
  ) {
    return existing;
  }

  const nextRequestedResultsCount =
    Math.max(0, existing.requestedResultsCount) + Math.max(1, additionalResults);
  const now = new Date().toISOString();
  const db = initializeDatabase();
  const nextStatus = existing.status === "paused" ? "queued" : existing.status;

  db.prepare(
    `UPDATE jobs
     SET requested_results_count = ?, status = ?, updated_at = ?
     WHERE id = ?`,
  ).run(nextRequestedResultsCount, nextStatus, now, jobId);

  appendJobEvent(jobId, "results.available", {
    requestedResultsCount: nextRequestedResultsCount,
    bufferedResults: countJobResults(jobId),
    resumed: existing.status === "paused",
  });

  return getJob(jobId);
}

export function getCacheChunk(chunkPk: string) {
  const db = initializeDatabase();
  const row = db
    .prepare("SELECT * FROM chunks WHERE chunk_pk = ?")
    .get(chunkPk) as ChunkRow | undefined;

  return row ? mapChunkRow(row) : null;
}

export function listCacheChunksForObject(
  bucket: string,
  objectKey: string,
  etag: string,
) {
  const db = initializeDatabase();
  const rows = db
    .prepare(
      `SELECT * FROM chunks
       WHERE bucket = ? AND object_key = ? AND etag = ?
       ORDER BY CAST(chunk_id AS INTEGER) ASC, created_at ASC`,
    )
    .all(bucket, objectKey, etag) as ChunkRow[];

  return rows.map(mapChunkRow);
}

export function upsertCacheChunk(input: UpsertCacheChunkInput) {
  const db = initializeDatabase();
  const now = new Date().toISOString();
  const createdAt = input.createdAt ?? now;
  const lastAccessedAt = input.lastAccessedAt ?? now;

  db.prepare(
    `INSERT INTO chunks (
      chunk_pk, bucket, object_key, etag, chunk_id, byte_start, byte_end,
      artifact_path, text_cache_path, cache_size_bytes, trigram_count, line_count,
      min_timestamp_ms, max_timestamp_ms, created_at, last_accessed_at
    ) VALUES (
      @chunkPk, @bucket, @objectKey, @etag, @chunkId, @byteStart, @byteEnd,
      @artifactPath, @textCachePath, @cacheSizeBytes, @trigramCount, @lineCount,
      @minTimestampMs, @maxTimestampMs,
      @createdAt, @lastAccessedAt
    )
    ON CONFLICT(chunk_pk) DO UPDATE SET
      bucket = excluded.bucket,
      object_key = excluded.object_key,
      etag = excluded.etag,
      chunk_id = excluded.chunk_id,
      byte_start = excluded.byte_start,
      byte_end = excluded.byte_end,
      artifact_path = excluded.artifact_path,
      text_cache_path = excluded.text_cache_path,
      cache_size_bytes = excluded.cache_size_bytes,
      trigram_count = excluded.trigram_count,
      line_count = excluded.line_count,
      min_timestamp_ms = excluded.min_timestamp_ms,
      max_timestamp_ms = excluded.max_timestamp_ms,
      last_accessed_at = excluded.last_accessed_at`,
  ).run({
    chunkPk: input.chunkPk,
    bucket: input.bucket,
    objectKey: input.objectKey,
    etag: input.etag,
    chunkId: input.chunkId,
    byteStart: input.byteStart,
    byteEnd: input.byteEnd,
    artifactPath: input.artifactPath,
    textCachePath: input.textCachePath,
    cacheSizeBytes: input.cacheSizeBytes,
    trigramCount: input.trigramCount,
    lineCount: input.lineCount,
    minTimestampMs: input.minTimestampMs,
    maxTimestampMs: input.maxTimestampMs,
    createdAt,
    lastAccessedAt,
  });

  return getCacheChunk(input.chunkPk);
}

export function touchCacheChunk(chunkPk: string) {
  const db = initializeDatabase();
  const now = new Date().toISOString();
  db.prepare("UPDATE chunks SET last_accessed_at = ? WHERE chunk_pk = ?").run(
    now,
    chunkPk,
  );
  return getCacheChunk(chunkPk);
}

export function getTotalCacheSizeBytes() {
  const db = initializeDatabase();
  const row = db
    .prepare("SELECT COALESCE(SUM(cache_size_bytes), 0) AS total FROM chunks")
    .get() as { total: number };

  return row.total ?? 0;
}

export function listCacheEvictionCandidates(limit = 100) {
  const db = initializeDatabase();
  const rows = db
    .prepare(
      `SELECT * FROM chunks
       ORDER BY last_accessed_at ASC, created_at ASC
       LIMIT ?`,
    )
    .all(limit) as ChunkRow[];

  return rows.map(mapChunkRow);
}

export function deleteCacheChunk(chunkPk: string) {
  const existing = getCacheChunk(chunkPk);

  if (!existing) {
    return null;
  }

  const db = initializeDatabase();
  db.prepare("DELETE FROM chunks WHERE chunk_pk = ?").run(chunkPk);
  return existing;
}

export function deleteCacheChunksForObject(
  bucket: string,
  objectKey: string,
  etag: string,
) {
  const existing = listCacheChunksForObject(bucket, objectKey, etag);

  if (existing.length === 0) {
    return [];
  }

  const db = initializeDatabase();
  db.prepare(
    "DELETE FROM chunks WHERE bucket = ? AND object_key = ? AND etag = ?",
  ).run(bucket, objectKey, etag);
  return existing;
}

export function listCacheChunksBySourcePrefix(bucket: string, rootPrefix: string) {
  const db = initializeDatabase();
  const normalizedPrefix = rootPrefix.trim();
  const rows = normalizedPrefix
    ? (db
        .prepare(
          `SELECT * FROM chunks
           WHERE bucket = ? AND object_key LIKE ?
           ORDER BY last_accessed_at ASC, created_at ASC`,
        )
        .all(bucket, `${normalizedPrefix}%`) as ChunkRow[])
    : (db
        .prepare(
          `SELECT * FROM chunks
           WHERE bucket = ?
           ORDER BY last_accessed_at ASC, created_at ASC`,
        )
        .all(bucket) as ChunkRow[]);

  return rows.map(mapChunkRow);
}

export function deleteCacheChunksBySourcePrefix(bucket: string, rootPrefix: string) {
  const existing = listCacheChunksBySourcePrefix(bucket, rootPrefix);

  if (existing.length === 0) {
    return [];
  }

  const db = initializeDatabase();
  const normalizedPrefix = rootPrefix.trim();

  if (normalizedPrefix) {
    db.prepare(
      "DELETE FROM chunks WHERE bucket = ? AND object_key LIKE ?",
    ).run(bucket, `${normalizedPrefix}%`);
  } else {
    db.prepare("DELETE FROM chunks WHERE bucket = ?").run(bucket);
  }

  return existing;
}

export function getManifestScope(
  bucket: string,
  rootPrefix: string,
  scopePrefix: string,
) {
  const db = initializeDatabase();
  const row = db
    .prepare(
      `SELECT * FROM manifest_scopes
       WHERE bucket = ? AND root_prefix = ? AND scope_prefix = ?`,
    )
    .get(bucket, rootPrefix, scopePrefix) as ManifestScopeRow | undefined;

  return row ? mapManifestScopeRow(row) : null;
}

export function listManifestObjects(
  bucket: string,
  rootPrefix: string,
  scopePrefix: string,
) {
  const db = initializeDatabase();
  const rows = db
    .prepare(
      `SELECT * FROM manifest_objects
       WHERE bucket = ? AND root_prefix = ? AND scope_prefix = ?
       ORDER BY object_key ASC`,
    )
    .all(bucket, rootPrefix, scopePrefix) as ManifestObjectRow[];

  return rows.map(mapManifestObjectRow);
}

export function replaceManifestScopeObjects({
  bucket,
  rootPrefix,
  scopePrefix,
  objects,
  refreshedAt,
}: {
  bucket: string;
  rootPrefix: string;
  scopePrefix: string;
  objects: Array<{
    objectKey: string;
    etag: string;
    size: number;
    lastModified: string;
  }>;
  refreshedAt?: string;
}) {
  const db = initializeDatabase();
  const now = refreshedAt ?? new Date().toISOString();
  const deleteObjects = db.prepare(
    `DELETE FROM manifest_objects
     WHERE bucket = ? AND root_prefix = ? AND scope_prefix = ?`,
  );
  const insertObject = db.prepare(
    `INSERT INTO manifest_objects (
      bucket, root_prefix, scope_prefix, object_key, etag, size, last_modified, discovered_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertScope = db.prepare(
    `INSERT INTO manifest_scopes (
      bucket, root_prefix, scope_prefix, last_refreshed_at, object_count
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(bucket, root_prefix, scope_prefix) DO UPDATE SET
      last_refreshed_at = excluded.last_refreshed_at,
      object_count = excluded.object_count`,
  );

  db.exec("BEGIN");

  try {
    deleteObjects.run(bucket, rootPrefix, scopePrefix);

    for (const object of objects) {
      insertObject.run(
        bucket,
        rootPrefix,
        scopePrefix,
        object.objectKey,
        object.etag,
        object.size,
        object.lastModified,
        now,
        now,
      );
    }

    upsertScope.run(bucket, rootPrefix, scopePrefix, now, objects.length);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return getManifestScope(bucket, rootPrefix, scopePrefix);
}
