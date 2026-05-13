# Sample S3 Log Dataset

This directory contains a small synthetic dataset for local WAML development.

Layout:

- `year_month=YYYYMM/`
- files named like `DD-HH-UUID.log`

Example:

- `year_month=202605/13-13-a1f4.log`

Properties:

- line-oriented plain text logs
- multiple services mixed across files
- realistic repeated phrases for substring search
- month-prefixed object layout compatible with the current WAML design

Suggested test patterns:

- `timeout while awaiting headers`
- `token refresh failed`
- `consumer lag`
- `circuit=half-open`
- `year_date=202605`

