# WAML

WAML is a web application for grep-like search over logs stored in S3.

## Workspace Layout

- `apps/web`: Next.js application
- `apps/worker`: long-lived search worker
- `packages/shared`: shared types and query contracts
- `packages/db`: SQLite paths, schema setup, and job helpers
- `var/cache`: local cache artifacts
- `var/data`: local SQLite database files

## Initial Setup

1. Install dependencies with `pnpm install`.
2. Start the web app with `pnpm dev:web`.
3. Start the worker with `pnpm dev:worker`.

This scaffold includes a SQLite-backed job skeleton that both processes can share.

## Current Scaling Bottlenecks

The current implementation works for targeted exploration, but a few scale limits are still important:

- Search execution still lists S3 objects under the selected prefix on each run.
  A persisted object manifest in SQLite does not exist yet, so very large prefixes will incur repeated `ListObjectsV2` cost.
- Results pagination currently uses SQLite `OFFSET`.
  This is fine for early pages, but deep pagination should move to cursor or sequence-based paging.
- Context lookup is still linear within an object.
  Showing surrounding lines currently requires counting through cached text or streamed object text by line number.
- Warm-cache reads still decompress full cached chunks after the trigram prefilter passes.
  This keeps the implementation simple, but large chunks still have non-trivial warm-hit cost.
- Search pause and resume happens at coarse boundaries.
  The worker can pause after buffering enough results, but resume is still driven by S3 listing progress rather than a finer object or chunk cursor.
- Dynamic partition value search is UI-paginated but still backend-scan-backed.
  High-cardinality filter keys need a persisted manifest or value index to scale cleanly.
- Cache eviction runs inline in the worker path.
  Under heavier churn, eviction should move toward a more incremental or background-oriented model.

## Likely Next Fixes

- Add a SQLite object manifest keyed by `bucket + rootPrefix + objectKey`.
- Replace `OFFSET` result paging with cursor or sequence-based paging.
- Add chunk line-range metadata for faster context lookup.
- Improve pause and resume granularity to object or chunk level.
- Persist partition value indexes instead of deriving them from repeated S3 scans.
