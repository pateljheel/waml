#!/bin/sh
set -eu

mkdir -p /app/var/data /app/var/cache /app/var/health

if [ -e /app/apps/web/var ] && [ ! -L /app/apps/web/var ]; then
  rm -rf /app/apps/web/var
fi

if [ ! -e /app/apps/web/var ]; then
  ln -s /app/var /app/apps/web/var
fi

cd /app
exec node apps/web/server.js
