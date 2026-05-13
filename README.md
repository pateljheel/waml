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

