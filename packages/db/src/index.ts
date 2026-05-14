import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CreateSearchJobInput,
  SearchJob,
  SearchJobEvent,
  SearchJobEventType,
  SearchJobStatus,
} from "@waml/shared";

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
  created_at: string;
  updated_at: string;
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

    CREATE TABLE IF NOT EXISTS chunks (
      chunk_pk TEXT PRIMARY KEY,
      object_key TEXT NOT NULL,
      etag TEXT NOT NULL,
      chunk_id TEXT NOT NULL,
      byte_start INTEGER NOT NULL,
      byte_end INTEGER NOT NULL,
      artifact_path TEXT NOT NULL,
      text_cache_path TEXT,
      trigram_count INTEGER NOT NULL DEFAULT 0,
      line_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_accessed_at TEXT NOT NULL
    );
  `);

  ensureColumn(db, "jobs", "notebook_id", "notebook_id TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "jobs", "source_json", "source_json TEXT NOT NULL DEFAULT '{}'");
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

  return db;
}

function normalizeStatus(status: string): SearchJobStatus {
  if (status === "pending") {
    return "queued";
  }

  if (
    status === "queued" ||
    status === "running" ||
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
    startTime: row.start_time,
    endTime: row.end_time,
    source: JSON.parse(row.source_json) as SearchJob["source"],
    prefixFilters: JSON.parse(row.prefix_filters_json) as SearchJob["prefixFilters"],
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
    startTime: input.startTime ?? "",
    endTime: input.endTime ?? "",
    source: input.source,
    prefixFilters: input.prefixFilters ?? {},
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
    createdAt: now,
    updatedAt: now,
  };

  db.prepare(
    `INSERT INTO jobs (
      id, notebook_id, mode, pattern, start_time, end_time, source_json,
      prefix_filters_json, custom_path_pattern, status, bytes_scanned,
      objects_scanned, chunks_scanned, matches_found, error_message,
      cancel_requested_at, started_at, finished_at, created_at, updated_at
    ) VALUES (
      @id, @notebookId, @mode, @pattern, @startTime, @endTime, @sourceJson,
      @prefixFiltersJson, @customPathPattern, @status, @bytesScanned,
      @objectsScanned, @chunksScanned, @matchesFound, @errorMessage,
      @cancelRequestedAt, @startedAt, @finishedAt, @createdAt, @updatedAt
    )`,
  ).run({
    id: job.id,
    notebookId: job.notebookId,
    mode: job.mode,
    pattern: job.pattern,
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
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });

  appendJobEvent(job.id, "job.queued", {
    status: job.status,
  });

  return job;
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

export function updateJobProgress(
  jobId: string,
  progress: Partial<SearchJob["progress"]>,
  extra: {
    status?: SearchJobStatus;
    errorMessage?: string | null;
    finishedAt?: string | null;
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
         matches_found = ?, status = ?, error_message = ?, finished_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    nextProgress.bytesScanned,
    nextProgress.objectsScanned,
    nextProgress.chunksScanned,
    nextProgress.matchesFound,
    extra.status ?? existing.status,
    extra.errorMessage ?? existing.errorMessage,
    extra.finishedAt ?? existing.finishedAt,
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
