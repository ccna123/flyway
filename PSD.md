# FlywayOps — Product Requirements Document

## Overview
FlywayOps is a web-based UI for running Flyway SQL migrations against PostgreSQL/Aurora databases on AWS ECS. Admins upload SQL migration files and trigger migrations through the UI.

## Users
- Database admin / DevOps engineer (single user, no authentication required)

## Core Features

### 1. Upload SQL Files
- Admin uploads .sql files following Flyway naming convention: `V{version}__{description}.sql`
- System validates filename format before saving
- Files are stored on container volume at `/tmp/flyway-sql`
- Uploaded files appear in the version selector

### 2. Run Migration
- Admin selects a specific version (e.g. V3) or runs all (latest)
- Clicking "Run Migration" triggers Flyway CLI in background
- UI polls for status every 3 seconds and streams logs
- On success: button turns green, verification panel shows schema diff + migration history
- On failure: button turns red with "Retry" option, error logged

### 3. Post-Migration Verification
- After successful migration, UI displays:
  - DB health status (connected / error)
  - Schema diff: tables added/removed/modified
  - Recent 5 migrations from flyway_schema_history

### 4. S3 File Browser (prod only)
- Shows SQL files stored in S3 bucket
- Displays latest version and what next file should be named
- Admin can download all or selected files to volume

### 5. Settings
- Configure DB connection (host, port, db name, user, password, schema)
- Configure S3 (bucket, region, prefix) — prod mode only
- Configure staging/test DB for pre-production testing
- Test connection button validates DB connectivity

### 6. Staging Migration
- If staging DB is configured, "Run on Test DB" button appears
- Runs same migration against staging DB first
- Result shown inline below migration card

## Acceptance Criteria

### Upload
- [ ] Valid file (V1__create_users.sql) → accepted, appears in list
- [ ] Invalid filename (create_users.sql) → rejected with error
- [ ] Non-.sql file → rejected

### Migration
- [ ] Select V1, click Run → only V1.sql executes, not V2
- [ ] Select "latest" → all pending files run in version order
- [ ] Second migration while one is running → rejected with 409
- [ ] Flyway not found → error shown in log

### Settings
- [ ] Empty required fields on Save → toast error + red highlight
- [ ] Test Connection with valid creds → success alert
- [ ] Test Connection with wrong host → error alert
