# WAML

WAML is a notebook-style log investigation application for object storage.

It lets you search logs in:
- Amazon S3
- Google Cloud Storage

The current product combines:
- notebook-scoped source configuration
- dynamic partition inference from object paths
- time-aware search pruning
- paginated lazy search execution
- local cache and manifest reuse
- inline context around matched log lines

## What WAML Does

WAML is built for large log archives stored as objects rather than in a traditional log index.

A notebook in WAML defines:
- a storage provider
- a bucket
- a root prefix
- optional custom path parsing rules
- partition filters
- time configuration
- a search query

The worker then scans matching objects, streams results back to the UI, and builds reusable local cache artifacts while it searches.

## Current Capabilities

### Search

- substring search
- unordered `all tokens` search
- case-sensitive or case-insensitive matching
- paginated lazy result loading
- cancelable searches
- time-range filtering
- inline log context around hits

### Storage Providers

- S3
  - bucket browsing
  - prefix browsing
  - search execution
  - context lookup
  - cache + manifest invalidation

- GCS
  - bucket browsing
  - prefix browsing
  - search execution
  - context lookup
  - cache + manifest invalidation

### Path and Partition Handling

- Hive-style partition inference from `key=value` path segments
- custom path pattern parsing for directories and filenames
- dynamic partition filters
- category filters with multi-select
- range filters with value mode or inclusive start/end bounds
- partition-to-time mapping for coarse time pruning

### Performance Features

- SQLite-backed search jobs
- local object manifest per scoped search prefix
- local compressed chunk cache
- chunk trigram prefilter
- cache invalidation
- manifest invalidation

## Repository Layout

- `apps/web`
  - Next.js application
  - notebook UI
  - storage discovery routes
  - search and context APIs

- `apps/worker`
  - long-lived search worker
  - S3 and GCS object streaming
  - manifest refresh
  - cache build and reuse

- `packages/shared`
  - shared schemas and types

- `packages/db`
  - SQLite schema
  - job, result, cache, and manifest helpers

- `fixtures`
  - local sample data and helper docs

- `var/data`
  - SQLite database files

- `var/cache`
  - local cached chunk artifacts

## Requirements

- Node.js 22
- pnpm 10

Cloud access depends on the provider you use:

### AWS

WAML expects local AWS credentials/profile access for the web app and worker.

Typical setup:
- `~/.aws/config`
- `~/.aws/credentials`
- `aws sso login` or another supported profile flow

### GCP

WAML currently supports:
- Application Default Credentials
- service account key path

Typical ADC setup:

```bash
gcloud auth application-default login
```

Or use a service account key file and configure its path in the notebook source settings.

## Installation

```bash
pnpm install
```

## Running Locally

Start the web app:

```bash
pnpm dev:web
```

Start the worker in a separate terminal:

```bash
pnpm dev:worker
```

Typecheck everything:

```bash
pnpm typecheck
```

Build everything:

```bash
pnpm build
```

## Running With Docker

WAML includes:
- `Dockerfile`
- `docker-compose.yml`

The container setup runs two services:
- `web`
- `worker`

They share Docker volumes for:
- SQLite data
- local cache artifacts

Start everything:

```bash
docker compose up --build
```

Then open:

```text
http://localhost:3000
```

Current container behavior:
- the web service runs the built Next.js app
- the worker service runs the compiled Node.js worker
- AWS and GCP credentials are mounted from the host by default

Default mounts in `docker-compose.yml`:
- `${HOME}/.aws:/root/.aws`
- `${HOME}/.config/gcloud:/root/.config/gcloud:ro`

AWS is mounted writable on purpose so SSO and `aws login` token refresh can update cache files inside the container.

Docker volumes:
- `waml_data`
- `waml_cache`
- `waml_health`

Stop everything:

```bash
docker compose down
```

Remove containers plus volumes:

```bash
docker compose down -v
```

## How To Use WAML

### 1. Create or select a notebook

Each notebook is an isolated investigation workspace.

### 2. Choose a storage provider

Select:
- `Amazon S3`
- `Google Cloud Storage`

### 3. Configure the source

For S3:
- AWS profile
- bucket
- root prefix

For GCS:
- GCP project (optional depending on your auth setup)
- auth mode
- bucket
- root prefix

### 4. Optional: define a custom path pattern

Examples:

```text
service={category:service}/year_month={range:year_month}/{range:day}-{range:hour}-{category:file_id}.log
```

```text
env={category:env}/year={range:year}/month={range:month}
```

Custom path patterns let WAML infer partitions from:
- directory names
- file names

### 5. Review dynamic filters

WAML will infer filter keys from object paths and let you:
- rename them
- hide them
- override type as category or range
- select multiple category values
- set range bounds

### 6. Configure time behavior

Map partition keys into time components such as:
- year
- month
- day
- hour
- date
- datetime

You can also configure how timestamps are parsed from log lines.

### 7. Run a search

Enter:
- a query
- a mode
  - `Substring`
  - `All tokens`
- optional time range
- page size
- context line count

Then run the search.

### 8. Review results

WAML shows:
- job state
- match count
- bytes scanned
- object count
- cache hit/miss/write/eviction counters
- paginated results

### 9. Open context

Each result can expand to show surrounding lines from the same object.

### 10. Manage local state

You can invalidate:
- cache
- object manifest

for the current notebook source scope.

## Search Model

WAML does not rely on a central remote full-text service.

Instead it:
- discovers candidate objects
- prunes by prefix, partition filters, and time range
- streams matching objects
- writes local cache artifacts while searching

Searches are:
- resumable within the current lazy paging model
- pausable after buffering enough results
- cancelable

## Time Model

WAML uses a universal time-range model:
- `startTime`
- `endTime`

It combines:
- coarse object pruning from path-derived time
- exact line filtering from parsed log timestamps

If line timestamp parsing is disabled, time filtering relies on coarse object pruning only.

## Cache and Manifest

### Cache

WAML maintains a local chunk cache under `var/cache`.

It stores:
- compressed cached text
- compact trigram artifacts
- per-chunk metadata in SQLite

Default cache budget:
- `512 MB`

Override with:

```bash
WAML_INDEX_CACHE_MAX_BYTES=5368709120
```

### Manifest

WAML also maintains scoped object manifests in SQLite to reduce repeated object listing work.

Manifest behavior:
- scoped by source and derived search window
- refreshed more aggressively for recent windows
- reusable for repeated searches

## Environment Notes

### AWS credentials refresh

WAML is designed to pick up refreshed AWS credentials without restarting the web or worker processes.

### GCS auth behavior

For GCS:
- ADC failures surface with guidance
- missing service account key paths fail fast
- permission failures are surfaced explicitly

## Known Limitations

- result ordering is effectively key-order streaming, not a global timestamp sort
- partition inference is still discovery-based, not backed by a persisted partition value index
- same-object context is supported; cross-object spillover context is not enabled
- WAML is optimized for targeted investigation, not as a replacement for a full remote indexing system

## Additional Docs

- [WAML_V1_ARCHITECTURE.md](/home/jheel/waml/WAML_V1_ARCHITECTURE.md)
