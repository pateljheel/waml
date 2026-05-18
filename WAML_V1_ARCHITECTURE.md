# WAML Architecture

## Purpose

WAML is a notebook-style log search application for object storage.

It is designed for:
- S3
- GCS

without requiring a dedicated remote search cluster.

## Main Components

- `apps/web`
  - Next.js UI
  - notebook state
  - source discovery APIs
  - search APIs
  - context APIs

- `apps/worker`
  - long-lived search worker
  - object listing and streaming
  - cache build and reuse
  - manifest refresh

- `packages/db`
  - SQLite schema and helpers

- `packages/shared`
  - shared schemas and types

- local runtime state
  - `var/data` for SQLite
  - `var/cache` for cached chunk artifacts

## Execution Model

The system runs as two cooperating processes:

- `web`
- `worker`

The web app creates search jobs in SQLite.
The worker claims jobs, executes them, writes progress and results back, and the web app streams state to the browser.

## Search Model

WAML uses progressive object scanning with local reuse.

Search flow:
1. select a notebook source
2. infer partitions from object paths
3. narrow scope with filters and time range
4. discover candidate objects
5. consult local manifest and cache
6. stream matching objects
7. write result rows and cache artifacts

Supported modes:
- substring
- all tokens

## Source Model

Each notebook defines:
- provider
- credentials source
- bucket
- root prefix
- optional custom path pattern

Current providers:
- `s3`
- `gcs`

## Partition Model

Partitions come from:
- Hive-style `key=value` paths
- custom path patterns

Custom path patterns support captures such as:
- `{category:name}`
- `{range:name}`

Dynamic filters are notebook-scoped and can be overridden in the UI.

## Time Model

WAML uses a universal time-range model:
- `startTime`
- `endTime`

Time can come from:
- path-derived partition values
- parsed timestamps from log lines

The worker uses:
- coarse object pruning from path time
- exact line filtering from parsed timestamps when configured

## Result Model

Search results are:
- persisted in SQLite
- paginated lazily
- streamed to the UI with SSE job events

Context lookup is file-based:
- cache first
- live object read fallback

## Cache Model

WAML maintains a local chunk cache.

Per chunk it stores:
- compressed text
- trigram artifact
- line-range metadata
- timestamp bounds

Cache identity is provider-neutral:
- provider
- bucket
- object key
- version token
- chunk id

## Manifest Model

WAML maintains scoped object manifests in SQLite.

The manifest is:
- not a full bucket inventory
- scoped by source and search window
- refreshed more aggressively for recent windows

It exists to reduce repeated object listing cost.

## Provider Abstraction

Storage access is abstracted behind provider-specific adapters.

Current implementations:
- S3 browser + worker reader
- GCS browser + worker reader

This keeps notebook, manifest, cache, and search logic provider-neutral.

## Security and Credentials

S3 currently uses local AWS profile-based credentials.

GCS currently supports:
- ADC
- service account key path

Both web and worker use the same provider-specific auth settings from the notebook source.

## Non-Goals

WAML is not currently:
- a remote full-text indexing cluster
- a globally sorted analytics engine
- a cross-object context browser
- a general remote shell or file-management tool

