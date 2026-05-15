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

## Source Scope And Partition Inference

Each notebook should define its search scope with:

- AWS profile
- bucket
- root prefix
- optional custom path pattern

The selected `root prefix` is the logical boundary for both:

- object discovery
- dynamic filter inference

All filter inference should be relative to that root, not the full bucket key space.

### Prefix Browser Model

The UI should treat the selected bucket and prefix as a lightweight S3 browser:

- users pick an AWS profile
- users pick a bucket
- users navigate prefixes under that bucket
- the chosen prefix becomes the notebook search root

This is not only a convenience feature. It defines the search universe from which partitions and filters are inferred.

### Inference Sources

Dynamic filters may come from two sources:

- Hive-style path segments such as `service=checkout/year_month=202605/`
- custom path pattern captures applied relative to the selected root

The system should discover candidate relative paths by traversing:

- child prefixes under the selected root
- object keys under those prefixes

This is important because some filters may live in directory-like segments while others may be encoded in filenames.

### Hive Inference

Hive inference should inspect each relative path segment and detect:

- `key=value`

Example:

```text
service=checkout/year_month=202605/14-10-a1.log
```

This should infer:

- `service=checkout`
- `year_month=202605`

Hive-inferred partitions default to:

- filter type: `category`
- source: `hive`

### Custom Path Pattern Inference

The notebook may optionally define a `custom path pattern` relative to the selected root prefix.

Supported capture forms:

- `{category:name}`
- `{range:name}`

Example:

```text
service={category:service}/year_month={range:year_month}/{range:day}-{range:hour}-{category:file_id}.log
```

If the relative object path is:

```text
service=checkout/year_month=202605/14-10-a1.log
```

the system should infer:

- `service`
- `year_month`
- `day`
- `hour`
- `file_id`

The custom pattern may match:

- directory segments
- filename segments

It is intentionally a structured capture syntax, not arbitrary regex.

### Precedence Rules

Inference precedence should be:

1. discover relative prefixes and object paths under the selected root
2. infer Hive partitions
3. apply custom path pattern inference
4. apply notebook-specific partition overrides

Behavior should be:

- if no custom path pattern is present, use Hive inference
- if a custom path pattern is present and produces matches, use the custom result set as the primary dynamic filter set

This avoids showing redundant Hive and custom filters at the same time when custom captures are intended to replace the raw Hive view.

### Filter Types

Each inferred filter should be classified as one of:

- `category`
- `range`

Rules:

- Hive-inferred filters default to `category`
- custom captures explicitly define `category` or `range`
- notebook overrides may change the displayed type later

In v1, `range` is primarily a semantic/UI distinction rather than a fully separate query engine primitive.

### Hierarchy Ordering

Dynamic filters should be ordered by path hierarchy, not alphabetically.

Each inferred filter should carry:

- `level`: the hierarchy depth relative to the selected root
- `order`: the left-to-right capture order within that level

Ordering rules:

- sort first by `level`
- then by `order`
- then by key only as a final tie-breaker

This matters for patterns where multiple fields come from the same filename segment. For example:

```text
service={category:service}/year_month={range:year_month}/{range:day}-{range:hour}-{category:file_id}.log
```

should render filters in this order:

- `service`
- `year_month`
- `day`
- `hour`
- `file_id`

not alphabetically.

### Notebook Partition Overrides

Inferred partitions should remain machine-derived, but each notebook may overlay user-managed overrides.

Notebook overrides should support:

- label rename
- type override
- hide/show

This is safer than editing inference directly because the underlying path scan may change over time without losing notebook-specific intent.

## Universal Time Range Design

Time filtering should be built around one canonical query interval:

- `start_ts`
- `end_ts`

These should be treated as the authoritative search bounds. Everything inferred from paths or parsed from lines should be normalized into this same model.

The system should use time in two layers:

- coarse path-derived time for pruning candidate objects
- exact line-derived time for final result inclusion

### Canonical Time Semantics

Use a universal interval model:

- `start_ts`: inclusive
- `end_ts`: exclusive

Internally, these should be normalized to UTC and stored as epoch milliseconds or canonical UTC ISO timestamps.

### Notebook Time Configuration

Each notebook should have a `time config` that contains:

- path time mapping
- line timestamp parser
- timezone context

Suggested conceptual schema:

```ts
type TimeComponent =
  | "none"
  | "year"
  | "month"
  | "day"
  | "hour"
  | "minute"
  | "second"
  | "date"
  | "datetime";

type PartitionTimeMapping = {
  partitionKey: string;
  component: TimeComponent;
  format?: string;
};

type LineTimestampParser =
  | { mode: "none" }
  | { mode: "auto" }
  | {
      mode: "regex";
      pattern: string;
      group: number;
      format?: string;
    };

type NotebookTimeConfig = {
  timezone: string;
  pathMappings: PartitionTimeMapping[];
  lineParser: LineTimestampParser;
};
```

### Path Time Mapping

The system should not hardcode partition keys such as `year`, `month`, `day`, or `hour`.

Instead, inferred or custom partition keys should be optionally mapped to timestamp roles.

Examples:

- `year -> year`
- `month -> month`
- `day -> day`
- `hour -> hour`
- `year_month -> date`, format `YYYYMM`
- `dt -> date`, format `YYYY-MM-DD`
- `ts_hour -> datetime`, format `YYYYMMDDHH`

This allows arbitrary partition layouts to participate in coarse time pruning.

### Coarse Object Time Derivation

Once path mappings are configured, the worker should derive a coarse object interval from path metadata.

Examples:

- `year=2026, month=05, day=14, hour=13`
  - object coarse range:
    - `[2026-05-14T13:00:00Z, 2026-05-14T14:00:00Z)`
- `year_month=202605, day=14, hour=13`
  - same effective interval after parsing `year_month`
- `year=2026, month=05`
  - coarse range:
    - `[2026-05-01T00:00:00Z, 2026-06-01T00:00:00Z)`

This interval should be used only for candidate pruning, not as the final truth for line inclusion.

### Line Timestamp Parsing

Line timestamps should be parsed independently from object path metadata.

Recommended parser modes:

- `none`
- `auto`
- `regex`

Behavior:

- `none`
  - no line-level timestamp parsing
  - only coarse object time is available
- `auto`
  - try common timestamp shapes such as ISO-like values
- `regex`
  - extract timestamp text with a capture group
  - optionally parse it with an explicit format

Examples:

- line:
  - `2026-05-14T13:42:11Z level=info ...`
  - parser mode: `auto`
- line:
  - `[2026-05-14 13:42:11] request failed`
  - parser mode: `regex`
  - pattern:
    - `^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]`
  - group:
    - `1`
  - format:
    - `YYYY-MM-DD HH:mm:ss`

The parsed line timestamp should be the authoritative value for final time-range filtering whenever available.

### Time Filtering Semantics

Execution should use both time layers:

1. build coarse object intervals from path mappings
2. prune objects by overlap with the requested interval
3. stream candidate objects
4. parse line timestamps where configured
5. include a line only if its parsed timestamp overlaps the canonical query interval

Overlap rule for objects:

- include object only if:
  - `object_end > start_ts`
  - `object_start < end_ts`

Final inclusion rule for lines:

- include line only if:
  - `line_ts >= start_ts`
  - `line_ts < end_ts`

### Missing Or Invalid Line Timestamps

When a time filter is active and a line timestamp parser is configured:

- if line timestamp parsing fails, the line should be excluded by default

When line parser mode is `none`:

- rely on coarse object time only

This keeps time filtering predictable and avoids leaking unrelated lines into a bounded search window.

### Time Mapping UI

The notebook UI should expose a `time mapping` section alongside dynamic filters.

Recommended columns:

- `partition key`
- `time role`
- `format`

Example rows:

- `year_month | date | YYYYMM`
- `day | day |`
- `hour | hour |`
- `service | none |`

This lets users decide which inferred/custom partitions participate in time pruning.

### Line Parser UI

The notebook UI should also expose a `line timestamp parser` section.

Recommended fields:

- parser mode
- regex pattern
- capture group
- format
- sample line
- parsed result preview

The preview is important because users need to validate timestamp extraction before running expensive scans.

### Preview API

Add a preview endpoint for validating time configuration:

- `POST /api/time/preview`

Example request:

```json
{
  "pathMappings": [
    { "partitionKey": "year_month", "component": "date", "format": "YYYYMM" },
    { "partitionKey": "day", "component": "day" },
    { "partitionKey": "hour", "component": "hour" }
  ],
  "partitionValues": {
    "year_month": "202605",
    "day": "14",
    "hour": "13"
  },
  "lineParser": {
    "mode": "regex",
    "pattern": "^\\[(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})\\]",
    "group": 1,
    "format": "YYYY-MM-DD HH:mm:ss"
  },
  "sampleLine": "[2026-05-14 13:42:11] timeout while awaiting headers"
}
```

Example response:

```json
{
  "coarseRange": {
    "start": "2026-05-14T13:00:00Z",
    "end": "2026-05-14T14:00:00Z"
  },
  "lineTimestamp": "2026-05-14T13:42:11Z",
  "errors": []
}
```

### Recommended Initial Format Support

Keep format support narrow in v1.

Recommended initial path or line formats:

- `YYYY`
- `YYYYMM`
- `YYYY-MM-DD`
- `YYYYMMDD`
- `YYYYMMDDHH`
- `YYYY-MM-DD HH:mm:ss`
- `YYYY-MM-DDTHH:mm:ssZ`
- `unix_seconds`
- `unix_millis`

This covers most real log layouts without committing to a very broad formatting DSL too early.

### Future Optimization

As chunks are scanned and cached, the system should record:

- `chunk_min_ts`
- `chunk_max_ts`

This will allow future searches to skip cached chunks whose exact line time bounds do not overlap the requested interval.

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

## Search Job And Streaming Design

Search execution should be implemented as a worker-owned job with progressive event streaming to the UI.

Recommended flow:

1. the `web` process creates a search job
2. the `worker` process claims and runs it
3. the `worker` emits structured progress and match events
4. the `web` process streams those events to the browser over `SSE`

This is a better fit than polling for line-level changes or keeping the entire search inside a request handler.

### Why SSE

`SSE` is the preferred v1 transport because:

- the flow is mostly server-to-client
- it is browser-native
- it is simpler than WebSockets
- it is well-suited to append-only progress and result streams

Use separate endpoints for:

- job submission
- event streaming
- cancellation

### Job Lifecycle

Recommended job states:

- `queued`
- `running`
- `cancelling`
- `cancelled`
- `completed`
- `failed`

Do not collapse user-requested cancellation directly into `cancelled`. `cancelling` is important because in-flight S3 reads and chunk work must stop asynchronously.

### Search API Shape

Recommended endpoints:

- `POST /api/search`
  - create a job and return `jobId`
- `GET /api/search/:jobId`
  - return the latest job snapshot
- `GET /api/search/:jobId/events`
  - open an `SSE` stream
- `POST /api/search/:jobId/cancel`
  - request cancellation

The browser should submit a search once, then observe the job through the event stream.

### SQLite Tables For Search

Recommended v1 tables:

#### `search_jobs`

- `id`
- `notebook_id`
- `status`
- `bucket`
- `root_prefix`
- `aws_profile`
- `query_text`
- `query_mode`
- `filters_json`
- `custom_path_pattern`
- `bytes_scanned`
- `objects_scanned`
- `chunks_scanned`
- `matches_found`
- `error_message`
- `cancel_requested_at`
- `started_at`
- `finished_at`
- `created_at`
- `updated_at`

#### `search_job_events`

- `id`
- `job_id`
- `sequence_no`
- `event_type`
- `payload_json`
- `created_at`

#### `search_job_results`

- `id`
- `job_id`
- `sequence_no`
- `object_key`
- `line_number`
- `timestamp_text`
- `line_text`
- `context_json`
- `created_at`

The event log does not need to be retained forever. It only needs to support reconnect, replay, and recent inspection.

### Event Model

Recommended event types:

- `job.queued`
- `job.started`
- `job.progress`
- `job.cancelling`
- `job.cancelled`
- `job.completed`
- `job.failed`
- `partition.started`
- `object.started`
- `object.skipped`
- `chunk.started`
- `chunk.cached`
- `chunk.indexed`
- `match.batch`

The worker should stream structured events, not raw unframed log text.

### Result Batching

Do not emit one event per matching line unless result volume is tiny.

Recommended behavior:

- emit `match.batch` every `N` results or every small time window
- emit `job.progress` on a timer

Reasonable v1 defaults:

- result batching every `250 ms`
- progress events every `500 ms`

This reduces event overhead and keeps the UI stable.

### Cancellation Design

Cancellation should be a first-class part of the job model because it directly affects S3 cost and user trust.

Recommended flow:

1. user clicks cancel
2. `web` marks the job `cancelling`
3. worker observes the cancellation flag
4. worker stops scheduling new work
5. worker aborts in-flight S3 reads where possible
6. worker flushes final progress
7. worker marks the job `cancelled`

The event stream should surface:

- `job.cancelling`
- `job.cancelled`

### Cancellation Granularity

Cancellation should be checked at small work boundaries:

- before listing the next object batch
- before starting each object
- before starting each chunk
- during streaming reads every byte or line batch
- before writing cache artifacts

The cancellation unit should effectively be:

- partition
- object
- chunk
- line batch

not an entire full-object scan.

### Abortable S3 Reads

The worker should use abortable S3 requests so cancellation saves real cost rather than merely preventing future scheduling.

Without abortable reads, a cancelled job may still finish downloading the active object or chunk, which weakens the cost-control goal.

### Cache Commit Rules Under Cancellation

Cache writes should be conservative:

- keep fully completed chunk artifacts
- discard partial chunk artifacts
- write cache metadata only after the artifact is valid

The chunk should be the atomic unit of durable cache commit.

This allows partial work from cancelled jobs to remain useful without corrupting cache state.

### Cost Guardrails

In addition to manual cancellation, the system should support hard limits such as:

- max bytes scanned
- max objects scanned
- max runtime
- max matches returned

These should act as policy-based stop conditions even when the user does not press cancel.

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
