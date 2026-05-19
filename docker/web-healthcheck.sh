#!/bin/sh
set -eu

node -e '
const port = process.env.PORT || "3000";
fetch(`http://127.0.0.1:${port}/api/health`, { cache: "no-store" })
  .then((response) => {
    if (!response.ok) {
      process.exit(1);
    }
  })
  .catch(() => {
    process.exit(1);
  });
'
