# WAML V1 Architecture

## Goal

WAML ("where are my logs") should support grep-like arbitrary substring search over logs stored in S3 under a partitioned path layout, without requiring a heavyweight always-on search cluster for v1.

This design treats the problem as a partition-pruned progressive scan with reusable substring-oriented cache artifacts, not classic full-text search.

## High-Level Architecture

Components:

- `Next.js` application for UI, auth, saved searches, and API surface
- `web` process for HTTP traffic, UI, auth, and API endpoints
- `worker` process for query execution, indexing, and cache management
- `SQLite` for metadata, manifests, locks, and small query/result metadata
- local disk cache for per-chunk search artifacts
- `S3` as the source of truth for log objects

This design standardizes on one application with two process roles: `web` and `worker`.

The roles should live in the same codebase and may be deployed in the same container, task, pod, or VM, but they should run as separate processes.

This is intentionally not a serverless-only design. Search and indexing need stable local disk and long-lived worker processes.

## Deployment Model

Recommended v1 deployment model:

- one repository
- one application
- two long-lived process roles
- shared SQLite database
- shared local cache directory

Role responsibilities:

- `web`
  - serve the Next.js UI
  - authenticate users
  - validate search requests
  - submit jobs to the worker
  - stream results and query state back to clients
- `worker`
  - resolve candidate objects
  - build chunk artifacts
  - execute searches
  - manage cache reuse and eviction
  - coordinate concurrency and backpressure

This preserves operational simplicity while isolating search work from HTTP request handling.

## Data Assumptions

- Logs are line-oriented text
- S3 data is organized using path-derived partitions or prefixes
- One expected layout is a monthly prefix such as `year_date=YYYYMM/` with objects named like `DD-HH-UUID.log`
- Time scoping may therefore come from both directory prefixes and filename parsing, not only `key=value` partition columns
- Objects are versionable using `etag` or version id
- Searches are primarily exact substring searches, not relevance-ranked document search
- Queries are usually bounded by time and at least one additional filter

## Query Model

User queries should include:

- time range
- service, environment, namespace, or similar prefix filters when available
- query mode
- query pattern

Supported query modes should be designed as an extensible interface rather than a single hardcoded search path.

V1 query mode:

- `substring`

Future query modes:

- `regex`
- other specialized matchers if needed

The search engine should return:

- matching lines
- timestamps when available
- object key
- line number or byte offset
- surrounding snippet
- partition metadata

Results should be streamed progressively as chunks complete.

## Search API Extensibility

The search layer should be built around a query-mode abstraction so new match semantics can be added without reworking chunk storage, cache metadata, or request orchestration.

A useful conceptual interface is:

- candidate pruning
- chunk-level verification
- snippet extraction
- result rendering

In practice this means each query mode should be able to plug into the same execution pipeline:

1. resolve candidate objects from prefixes and time filters
2. expand objects into chunks
3. consult cache artifacts
4. prune candidate chunks where possible
5. verify matches against chunk text
6. stream results

For v1, only `substring` needs to be implemented. The API and cache format should still reserve room for future modes such as `regex`.

## Web-Worker Handoff

The `web` and `worker` processes should communicate through a simple internal job handoff model.

Recommended v1 shape:

- `web` writes a search job record
- `worker` claims pending jobs
- `worker` writes progress and result state
- `web` streams that state to the client

This can be implemented using SQLite tables for:

- job submission
- job ownership
- progress updates
- result metadata
- cancellation state

This avoids introducing a separate queueing system in v1 while keeping the roles properly decoupled.

## Core Design

The system should work at chunk granularity, not whole-object granularity.

Flow:

1. Apply prefix and time filters to identify candidate S3 objects.
2. Resolve object metadata and map each object into line-aligned chunks.
3. For each chunk, check whether a cache artifact already exists for that exact object version.
4. Search cached chunks immediately.
5. For uncached chunks, stream from S3, build the chunk artifact, search it, and persist it.
6. Verify matches against chunk text and stream results back incrementally.

This is a scan-first architecture with reusable query prefilters.

## Why Chunk-Level Instead of Whole-Object

Chunk-level caching is preferred because it gives:

- smaller cache entries
- finer-grained eviction
- better reuse for large objects
- faster warm-up
- easier parallelization

Whole-object indexing is more expensive to build, slower to reuse, and more wasteful under fixed cache budgets.

## Search Strategy

Because the requirement is grep-like arbitrary substring search, a token full-text index is the wrong structure.

The practical v1 approach is:

- use prefix and time-derived filters to reduce candidate objects
- use chunk-level trigram prefilters when available
- verify matches by scanning chunk text
- stream results as each chunk finishes

Behavior by pattern length:

- if pattern length is less than `3`, skip trigram prefiltering and scan candidate chunks directly
- if pattern length is `3` or greater, derive pattern trigrams and use cached chunk trigram data to eliminate impossible chunks before verification

This keeps the implementation tractable while still accelerating repeated searches on seen data.

### Future Regex Mode

Regex support should be treated as a future advanced mode built on top of the same chunk pipeline.

Recommended approach for future implementation:

- attempt literal or trigram extraction from the regex
- use extracted literals to prune candidate chunks
- run full regex evaluation only on surviving chunks
- enforce guardrails such as timeouts, cold-scan budgets, and result caps

Important notes:

- some regexes will prune well
- some regexes will degrade to near-full scan behavior
- the architecture should allow this mode without assuming it will always be fast

## Chunk Artifact Design

Each chunk artifact should store:

- object identity
- chunk boundaries
- line offsets
- trigram signature or compact trigram structure
- optional cached compressed text for snippet retrieval and verification
- cache metadata
- room for mode-specific auxiliary data in future versions

Suggested artifact fields:

- `object_key`
- `etag` or `version_id`
- `chunk_id`
- `byte_start`
- `byte_end`
- `line_count`
- `min_ts` and `max_ts` when derivable
- `index_version`
- `artifact_capabilities`
- `created_at`
- `last_accessed_at`

Suggested cache layout:

- `/cache/<object-hash>/<etag>/<chunk-id>.idx`
- `/cache/<object-hash>/<etag>/<chunk-id>.txt.zst`

If disk budget allows it, compressed chunk text should be cached. It significantly improves match verification and snippet retrieval and avoids repeated S3 reads.

## SQLite Responsibilities

SQLite should not be the substring search engine. It should manage metadata, manifests, locks, and small caches.

Recommended tables:

### `objects`

- `object_key`
- `etag`
- `size`
- `last_modified`
- parsed prefix fields
- parsed filename time components
- `discovered_at`

### `chunks`

- `chunk_pk`
- `object_key`
- `etag`
- `chunk_id`
- `byte_start`
- `byte_end`
- `artifact_path`
- `text_cache_path`
- `trigram_count`
- `line_count`
- `created_at`
- `last_accessed_at`

### `build_locks`

- `object_key`
- `etag`
- `chunk_id`
- `owner`
- `expires_at`

### `query_cache`

- normalized filter hash
- pattern hash
- result summary
- `created_at`
- `last_accessed_at`

## Search Execution Flow

1. User submits search request from the Next.js UI.
2. The `web` process validates the request and records a search job.
3. The worker resolves candidate prefixes and objects.
4. The worker sorts objects by recency or another useful heuristic.
5. The worker expands objects into chunks.
6. Cached chunks are searched first.
7. Uncached chunks are queued for bounded concurrent S3 fetch, artifact build, and verification.
8. Results are streamed back as they are found.
9. New artifacts are written to disk and indexed in SQLite.

The `web` process is responsible for reading job state and streaming progress and results to the client.

The worker should prioritize:

- recent prefixes and objects first
- cached chunks first
- quick early hits for interactive UX

## Concurrency Model

HTTP request handlers should not independently index the same chunk.

Use a dedicated search coordinator with:

- bounded worker pool
- per-chunk build locks
- deduplication for concurrent requests touching the same cold chunk
- backpressure to avoid S3 and local disk thrash

Reasonable initial defaults:

- `4` to `8` indexing workers
- `2` to `4` concurrent S3 object streams per query
- per-query cold-scan budget
- global queue limits

## Cache Policy

Use fixed-budget LRU eviction.

Separate budgets for:

- index artifacts
- cached chunk text

Eviction order:

1. cold cached text
2. cold index artifacts
3. stale query cache entries

Metadata should generally outlive file artifacts so the system retains discovery history and can rebuild predictably.

## Match Verification and Snippets

A trigram prefilter only identifies candidate chunks. Actual matches must still be verified against text.

The verification layer should remain query-mode aware. For example:

- substring mode performs exact substring verification
- future regex mode performs regex evaluation against the candidate chunk text

For verified matches, return:

- exact line text
- nearby context lines when needed
- source object key
- byte offset or line number

If compressed chunk text is cached locally, verification and snippet assembly are straightforward. Without text cache, the worker may need targeted S3 reads, which is more complex and slower.

## Operational Constraints

This architecture requires:

- persistent local disk
- two long-lived processes in the same application deployment
- long-lived worker processes
- stable cache directories

Good deployment targets:

- VM
- ECS service
- Kubernetes deployment
- long-lived container platform

Typical process model examples:

- one container running both `web` and `worker`
- one pod with two containers sharing a volume
- one VM process manager supervising both roles

Poor deployment targets:

- purely serverless request handlers
- ephemeral runtimes with no usable disk cache

## Where DuckDB Fits

DuckDB is optional in this design.

It may help with:

- object manifest exploration
- structured prefix and object-manifest filtering
- operational analytics on discovered objects

It should not be the primary grep engine for arbitrary substring search.

For v1, SQLite alone is enough if manifests remain simple.

## Known Limits

This design works well when:

- users search recent or selective time windows
- prefix and time filters are meaningful
- searches overlap on hot data
- the default query mode is substring search

This design degrades when:

- patterns are extremely short, such as `a=` or `::`
- users search across very large cold datasets
- concurrency is high and most queries target unseen partitions
- regex patterns have weak or no extractable literals

These cases naturally approach raw scanning cost.

## Recommended MVP Defaults

- chunk size: `8 MB`
- chunk boundaries aligned to line endings
- trigram-set prefilter only for v1
- query-mode abstraction in place even if only substring is implemented initially
- compressed text cache enabled
- result cap per query: `1000`
- query timeout: `15-30s`
- explicit cold-data scan budget
- strict encouragement of time-bounded queries

## Product Constraint

The UI should strongly encourage or require:

- time range selection
- at least one additional prefix or metadata filter when datasets are large

This is not only a UX choice. It is essential for keeping query latency and cache efficiency within acceptable bounds.

## Future Graduation Path

This architecture is a pragmatic v1, not an end-state universal search platform.

If WAML eventually needs:

- low-latency search across months of cold data
- very high concurrency
- regex-heavy workloads at scale
- globally consistent search performance

then it should graduate to an offline-built distributed search/indexing system rather than relying solely on query-time chunk discovery and local cache reuse.
