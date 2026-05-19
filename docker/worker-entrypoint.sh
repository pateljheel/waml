#!/bin/sh
set -eu

mkdir -p /app/var/data /app/var/cache /app/var/health

cd /app
exec node apps/worker/dist/apps/worker/src/index.js
