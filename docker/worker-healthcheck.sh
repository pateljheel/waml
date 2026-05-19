#!/bin/sh
set -eu

node -e '
const fs = require("node:fs");
const filepath = process.env.WAML_WORKER_HEARTBEAT_FILE || "/app/var/health/worker-heartbeat";
const maxAgeMs = Number(process.env.WAML_WORKER_HEALTH_MAX_AGE_MS || "15000");
const stats = fs.statSync(filepath);
if (Date.now() - stats.mtimeMs > maxAgeMs) {
  process.exit(1);
}
'
