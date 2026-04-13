# FlywayOps — CLAUDE.md

Hướng dẫn context cho Claude Code khi mở session mới trong project này.

---

## Project Overview

**FlywayOps** — Web UI để chạy Flyway SQL migration lên PostgreSQL/Aurora trên AWS ECS.

| Layer | Stack |
|-------|-------|
| Frontend | React + Vite + Tailwind CSS (trong `ecs-controller/`) |
| Backend | Python Flask — thuần API, không render HTML cho React |
| Migration engine | Flyway CLI (chạy trong backend container) |
| DB (local) | PostgreSQL container |
| DB (prod) | Amazon Aurora PostgreSQL (private subnet) |

---

## Cấu trúc thư mục

```
flyway/
├── app.py                      # Flask API — tất cả routes
├── requirements.txt
├── Dockerfile                  # Backend container
├── docker-compose.yml          # Local dev: backend + postgresql + frontend nginx
│
├── ecs-controller/             # React frontend (Vite + React + Tailwind)
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Dashboard.jsx   # Trang chính: upload, version, migrate, history
│   │   │   └── Settings.jsx    # Settings: DB, S3, staging config
│   │   ├── App.jsx
│   │   ├── api.js              # Tất cả API calls
│   │   ├── index.css
│   │   └── main.jsx
│   ├── Dockerfile.frontend     # (TODO) Nginx serve React build
│   ├── nginx.conf              # (TODO) Nginx config cho frontend
│   ├── package.json
│   ├── vite.config.js          # Dev proxy: /api → localhost:5000
│   └── tailwind.config.js
├── tests/
│   └── test_api.py             # pytest (chạy: python -m pytest tests/test_api.py -v)
├── sample-migrations/          # File SQL mẫu để test upload
├── migrations/                 # Mount vào container tại /tmp/flyway-sql (volume)
├── .env.template
├── .env                        # KHÔNG commit (gitignored)
└── PSD.md
```

---

## Architecture

### Local

```
Browser
  └─→ React dev server (Vite :5173)
        └─→ proxy /api/* → Flask :5000
                            └─→ PostgreSQL :5432 (container)
                            └─→ /tmp/flyway-sql (Docker volume)
```

SQL files upload → lưu vào Docker volume (`migrations/` mount tại `/tmp/flyway-sql`).

### Production

```
Browser
  └─→ React (S3 static hosting / CloudFront)  [TODO: chưa deploy]
        └─→ API Gateway (x-api-key header)
              └─→ Lambda (proxy forward)
                    └─→ Flask backend (ECS Fargate — private subnet)
                          via AWS CloudMap service discovery
                          └─→ Aurora PostgreSQL (private subnet)
                          └─→ S3 (persistent SQL file storage)
```

**Prod storage:** SQL files upload → lưu vào volume ECS task + sync lên S3.  
S3 là persistent storage — khi task restart, download lại từ S3 về volume.

**Auth:** Frontend gửi `x-api-key` header → API Gateway validate key → forward tới Lambda → Lambda proxy tới backend qua CloudMap domain name.

### Prod flow diagram

> **TODO: chèn diagram ảnh ở đây**  
> ![Architecture diagram placeholder](docs/arch-prod.png)

---

## Chạy local

```bash
# Lần đầu hoặc sau khi thay đổi Dockerfile
docker compose up --build

# Những lần sau
docker compose up

# Backend API tại http://localhost:5000
# React dev server tại http://localhost:5173 (cd ecs-controller && npm run dev)
# PostgreSQL local tại localhost:5432
```

`.env` cần có ít nhất:
```
APP_ENV=local
SECRET_KEY=any-secret
SQL_DIR=/tmp/flyway-sql
RELEASE=false
```

---

## Biến môi trường quan trọng

| Biến | Ý nghĩa |
|------|---------|
| `APP_ENV` | `local` hoặc `prod` — ảnh hưởng badge và dev tools |
| `RELEASE` | `false` = local mode (ẩn S3); `true` = prod mode (hiện S3) |
| `SQL_DIR` | Thư mục Flyway đọc file SQL, trong container là `/tmp/flyway-sql` |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | PostgreSQL/Aurora connection |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | AWS (S3) |
| `API_KEY` | API key để validate request từ frontend (prod) |

---

## API Endpoints

### Config & Pages

| Method | Path | Mô tả |
|--------|------|--------|
| GET | `/api/config` | Server metadata: `env_mode`, `release` flag |
| GET | `/` | Legacy Flask page (index) |
| GET | `/settings` | Legacy Flask page (settings) |

### Files

| Method | Path | Mô tả |
|--------|------|--------|
| POST | `/api/upload` | Upload SQL files, validate Flyway naming |
| GET | `/api/files` | List files trong volume |
| DELETE | `/api/files/<filename>` | Xóa một file |
| POST | `/api/files/delete` | Bulk delete (`{"files": [...]}` hoặc `{"files": null}` = xóa hết) |

### Migration

| Method | Path | Mô tả |
|--------|------|--------|
| POST | `/api/migrate` | Bắt đầu migration async, trả về `executionId` |
| GET | `/api/migrate/status/<id>` | Poll trạng thái + logs |
| GET | `/api/migrate/history` | Lịch sử migration |
| POST | `/api/migrate/staging` | Chạy migration trên staging DB |
| POST | `/api/test-connection` | Test DB connection |

### S3

| Method | Path | Mô tả |
|--------|------|--------|
| POST | `/api/s3/test` | Test S3 connection |
| POST | `/api/s3/files` | List files trên S3 |
| POST | `/api/s3/upload` | Upload files từ volume lên S3 |
| POST | `/api/s3/download` | Download files từ S3 về volume |
| POST | `/api/s3/delete` | Xóa files trên S3 |

### ECS Task Control

| Method | Path | Mô tả |
|--------|------|--------|
| POST | `/api/task/stop` | Stop ECS task hiện tại |

### Dev Tools (chỉ khi `APP_ENV=local`)

| Method | Path | Mô tả |
|--------|------|--------|
| POST | `/api/dev/seed` | Insert test data |
| POST | `/api/dev/query` | Query test data |
| POST | `/api/dev/update` | Update test data |
| POST | `/api/dev/clear` | Drop tables + clear files + reset history |

---

## Flyway CLI invocation (trong app.py)

```python
cmd = [
    "flyway",
    f"-url=jdbc:postgresql://{host}:{port}/{db}",
    f"-user={user}",
    f"-password={password}",
    f"-schemas={schema}",
    f"-locations=filesystem:{sql_dir}",
    "-baselineOnMigrate=true",
    "-baselineVersion=0",       # critical: baseline ở 0 để V1 không bị skip
    f"-outOfOrder={out_of_order}",
    "migrate",
]
```

`-baselineVersion=0` là critical bug fix — nếu bỏ, Flyway baseline tại V1 và skip V1.

---

## Migration flow

> **TODO: chèn flow diagram ảnh ở đây**  
> ![Migration flow placeholder](docs/migration-flow.png)

---

## UI Layout

> **TODO: chèn UI screenshot ở đây**  
> ![UI layout placeholder](docs/ui-layout.png)

```
Dashboard page:
  Card 01 — Upload SQL Files
  Card 02 — Select Target Version (version chips + delete toolbar)
  Card 03 — Execute Migration
    ├── STEP 1 · OPTIONAL: Test on Staging  [Run on Staging]
    └── STEP 2 · PRODUCTION: Apply to Production  [Run on Production]
         (shared Execution Log + Post-Migration Verification panel ở cột phải)
  Card — S3 Files (chỉ hiện khi RELEASE=true + s3_bucket configured)
  Card — Dev Tools (chỉ hiện khi APP_ENV=local)
  Card — Migration History (table)

Settings page:
  Grid 2 cột: DB Connection card | S3 card (S3 ẩn khi RELEASE=false)
  Port + DB Name + Schema gom 1 hàng
  Staging DB fields phía dưới
```

---

## Test suite

```bash
# Backend phải đang chạy tại localhost:5000
python -m pytest tests/test_api.py -v

# Kết quả hiện tại: 33 passed, 1 skipped
```

Test classes: `TestPages`, `TestUpload`, `TestFileManagement`, `TestMigrate`, `TestStaging`, `TestConnection`, `TestSettings`, `TestDevTools`

---

## Những gì đã làm (tóm tắt)

- Flyway naming validation khi upload (`parse_filename()` trong `app.py`)
- `-baselineVersion=0` fix để V1+V2 không bị skip
- Settings: S3 card ẩn khi `RELEASE=false`, layout 3 fields/hàng
- Staging: luôn hiện (cả khi chưa configure), show log + verification giống production
- Migration history: bỏ stat cards (Total/Passed/Failed), chỉ giữ table
- Button states: success → reset về "Run on Production"; failed → đỏ + "Retry Migration"
- `refreshHistory()` await đúng cách trong `onDone()` để stats update ngay
- CORS: allow `x-api-key` header cho prod auth flow
- `/api/task/stop` endpoint để frontend stop ECS task khi xong việc
- React frontend (`ecs-controller/`) với Vite + Tailwind, proxy `/api` về Flask khi dev

---

## TODO / Chưa làm

- [ ] `Dockerfile.frontend` + `nginx.conf` cho React build (phục vụ qua nginx trong docker-compose)
- [ ] Cập nhật `docker-compose.yml` thêm service `frontend` (nginx)
- [ ] API Gateway + Lambda setup cho prod (proxy tới backend qua CloudMap)
- [ ] CloudMap service discovery config cho ECS task
- [ ] S3 static hosting / CloudFront cho React app
- [ ] Auto-stop ECS task sau X phút (EventBridge Scheduler)
- [ ] Thêm `docs/arch-prod.png`, `docs/migration-flow.png`, `docs/ui-layout.png`
