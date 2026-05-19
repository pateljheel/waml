#!/bin/sh
set -eu

mkdir -p /app/var/data /app/var/cache /app/var/health

cd /app/apps/web
exec pnpm start
