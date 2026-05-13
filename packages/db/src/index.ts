import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { CreateSearchJobInput, SearchJob } from "@waml/shared";

const repoRoot = path.resolve(__dirname, "../../..");
const varDirectory = path.join(repoRoot, "var");
const dataDirectory = path.join(varDirectory, "data");
const cacheDirectory = path.join(varDirectory, "cache");
const databaseFile = path.join(dataDirectory, "waml.db");

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

export function initializeDatabase() {
  ensureRuntimeDirectories();

  const db = new DatabaseSync(databaseFile);

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      pattern TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      prefix_filters_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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

  return db;
}

function getConnection() {
  return initializeDatabase();
}

export function createJob(input: CreateSearchJobInput): SearchJob {
  const db = getConnection();
  const now = new Date().toISOString();
  const job: SearchJob = {
    id: crypto.randomUUID(),
    mode: input.mode,
    pattern: input.pattern,
    startTime: input.startTime,
    endTime: input.endTime,
    prefixFilters: input.prefixFilters,
    status: "pending",
    createdAt: now,
  };

  db.prepare(
    `INSERT INTO jobs (
      id,
      mode,
      pattern,
      start_time,
      end_time,
      prefix_filters_json,
      status,
      created_at,
      updated_at
    ) VALUES (
      @id,
      @mode,
      @pattern,
      @startTime,
      @endTime,
      @prefixFiltersJson,
      @status,
      @createdAt,
      @updatedAt
    )`,
  ).run({
    ...job,
    prefixFiltersJson: JSON.stringify(job.prefixFilters),
    updatedAt: now,
  });

  return job;
}

export function listJobs(): SearchJob[] {
  const db = getConnection();
  const rows = db
    .prepare(
      `SELECT id, mode, pattern, start_time, end_time, prefix_filters_json, status, created_at
       FROM jobs
       ORDER BY created_at DESC`,
    )
    .all() as Array<{
      id: string;
      mode: SearchJob["mode"];
      pattern: string;
      start_time: string;
      end_time: string;
      prefix_filters_json: string;
      status: SearchJob["status"];
      created_at: string;
    }>;

  return rows.map((row) => ({
    id: row.id,
    mode: row.mode,
    pattern: row.pattern,
    startTime: row.start_time,
    endTime: row.end_time,
    prefixFilters: JSON.parse(row.prefix_filters_json) as Record<string, string>,
    status: row.status,
    createdAt: row.created_at,
  }));
}
