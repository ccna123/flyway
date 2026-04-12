# FlywayOps — CLAUDE.md

Hướng dẫn context cho Claude Code khi mở session mới trong project này.

---

## Project Overview

**FlywayOps** — Web UI để chạy Flyway SQL migration lên PostgreSQL/Aurora trên AWS ECS.  
Stack: Python Flask + Jinja2 (server-side render) + vanilla JS + Flyway CLI.  
Không có frontend framework, không có build step — edit file là chạy được ngay.

---

## Cấu trúc thư mục

```
flyway/
├── app.py                  # Flask app, tất cả API routes
├── templates/
│   ├── base.html           # Layout chung
│   ├── index.html          # Trang chính: upload, version, migrate, history
│   └── settings.html       # Settings page: DB, S3, staging config
├── static/
│   ├── index.js            # Toàn bộ frontend logic (vanilla JS)
│   └── styles.css          # CSS
├── tests/
│   └── test_api.py         # pytest test suite (chạy: python -m pytest tests/test_api.py -v)
├── sample-migrations/      # File SQL mẫu để test upload
├── migrations/             # Mount vào container tại /tmp/flyway-sql (volume)
├── Dockerfile
├── docker-compose.yml      # Local dev: Flask app + PostgreSQL
├── .env.template           # Template cho .env
├── .env                    # KHÔNG commit (gitignored)
└── PSD.md                  # Product requirements doc
```

---

## Chạy local

```bash
# Lần đầu hoặc sau khi thay đổi Dockerfile
docker compose up --build

# Những lần sau
docker compose up

# App chạy tại http://localhost:5000
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
| `APP_ENV` | `local` hoặc `prod` — ảnh hưởng badge sidebar và dev tools |
| `RELEASE` | `false` = local mode (ẩn S3, tắt auth); `true` = prod mode (hiện S3, bật Basic Auth) |
| `SQL_DIR` | Thư mục Flyway đọc file SQL, trong container là `/tmp/flyway-sql` |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | PostgreSQL connection |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | AWS (S3 + staging) |
| `SSM_PARAM_USER` | SSM path cho Basic Auth username (default: `/flywayops/basic_user`) |
| `SSM_PARAM_PASS` | SSM path cho Basic Auth password (default: `/flywayops/basic_pass`) |

---

## API Endpoints

| Method | Path | Mô tả |
|--------|------|--------|
| GET | `/` | Main page |
| GET | `/settings` | Settings page |
| POST | `/settings` | Save settings vào session |
| POST | `/api/upload` | Upload SQL files, validate Flyway naming |
| GET | `/api/files` | List files trong volume |
| DELETE | `/api/files/<filename>` | Xóa một file |
| POST | `/api/files/delete` | Bulk delete (`{"files": [...]}` hoặc `{"files": null}` = xóa hết) |
| POST | `/api/migrate` | Bắt đầu migration async, trả về `executionId` |
| GET | `/api/migrate/status/<id>` | Poll trạng thái + logs |
| GET | `/api/migrate/history` | Lịch sử migration |
| POST | `/api/migrate/staging` | Chạy migration trên staging DB |
| POST | `/api/test-connection` | Test DB connection |
| POST | `/api/s3/upload` | Upload files từ volume lên S3 |
| GET | `/api/s3/files` | List files trên S3 |
| POST | `/api/s3/download` | Download files từ S3 về volume |
| POST | `/api/dev/seed` | Dev: insert test data |
| GET | `/api/dev/query` | Dev: query test data |
| POST | `/api/dev/update` | Dev: update test data |
| POST | `/api/dev/clear` | Dev: drop tables + clear files + reset history |

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
    "-baselineVersion=0",       # quan trọng: baseline ở 0 để V1 không bị skip
    f"-outOfOrder={out_of_order}",
    "migrate",
]
```

`-baselineVersion=0` là critical bug fix — nếu bỏ, Flyway baseline tại V1 và skip V1.

---

## Frontend (index.js) — Key flows

**Migration flow:**
1. `runMigration()` → POST `/api/migrate` → nhận `executionId`
2. `startPolling()` → poll `/api/migrate/status/{id}` mỗi 3s
3. `setLog(data.logs)` update log panel
4. `onDone(ok, errMsg, verification)` → `renderVerification()` + `refreshHistory()`

**Staging flow** (tương tự production):
1. `runStagingTest()` → POST `/api/migrate/staging` → nhận `executionId`
2. `pollStaging()` → cùng poll như production, cùng dùng log panel + verify panel
3. `stagingDone()` → hiện result + `renderVerification()`

**State:**
```js
const state = { files, selectedVersion, executionId, pollTimer, pollCount, running }
let stagingState = { running, executionId, pollTimer }
```

---

## UI Layout (index.html)

```
Card 01 — Upload SQL Files
Card 02 — Select Target Version (version chips + delete toolbar)
Card 03 — Execute Migration
  ├── STEP 1 · OPTIONAL: Test on Staging  [Run on Staging]
  └── STEP 2 · PRODUCTION: Apply to Production  [Run on Production]
       (shared Execution Log + Post-Migration Verification panel ở cột phải)
Card — S3 Files (chỉ hiện khi prod + s3_bucket configured)
Card — Dev Tools (chỉ hiện khi APP_ENV=local)
Card — Migration History (table, không có stat cards)
```

Settings page (`settings.html`):
- Grid 2 cột: DB Connection card | S3 card (S3 ẩn khi `RELEASE=false`)
- Port + DB Name + Schema gom 1 hàng: `grid-template-columns: 110px 1fr 120px`
- Staging DB fields phía dưới

---

## Test suite

```bash
# App phải đang chạy tại localhost:5000
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
- HTTP Basic Auth: bật khi `RELEASE=true`, credentials fetch từ SSM Parameter Store lúc startup

## Basic Auth — Setup trên AWS

Tạo 2 SSM Parameter (SecureString) trước khi deploy:
```bash
aws ssm put-parameter --name "/flywayops/basic_user" --value "admin" --type SecureString
aws ssm put-parameter --name "/flywayops/basic_pass" --value "your-strong-password" --type SecureString
```

App Runner task role cần có IAM permission:
```json
{
  "Effect": "Allow",
  "Action": "ssm:GetParameter",
  "Resource": [
    "arn:aws:ssm:REGION:ACCOUNT:parameter/flywayops/basic_user",
    "arn:aws:ssm:REGION:ACCOUNT:parameter/flywayops/basic_pass"
  ]
}
```

Credentials được load 1 lần lúc startup (`_load_basic_auth_credentials()` trong `app.py`), cache vào module-level vars — không fetch lại mỗi request.

---

## Next project: ECS Controller (chưa build)

Một React app riêng (repo khác hoặc subfolder `ecs-controller/`) để:

**Mục đích:** Admin có thể bật/tắt ECS task chạy FlywayOps mà không cần vào AWS Console.

**Architecture:**
```
React (static) → API Gateway (x-api-key header) → Lambda → ECS Fargate
```

**3 Lambda endpoints:**
| Endpoint | Lambda làm gì |
|----------|---------------|
| `POST /start` | `ecs.run_task()` với `assignPublicIp=ENABLED` |
| `GET /status` | `describe_tasks()` → lấy ENI → `describe_network_interfaces()` → trả public IP |
| `POST /stop` | `ecs.stop_task()` |

**React UI (đơn giản):**
- Input nhập API key (lưu localStorage)
- Badge trạng thái: STOPPED / STARTING / RUNNING
- Nếu RUNNING: hiện URL (public IP:5000), link bấm vào mở FlywayOps
- Nút "Start App" và "Stop App"
- Poll `/status` mỗi 5s khi đang STARTING

**Lưu ý khi build:**
- Public IP không có ngay, phải poll cho đến khi task RUNNING (~30-60s)
- IP lấy qua 2 bước: `describe_tasks` → ENI attachment → `describe_network_interfaces`
- FlywayOps chạy trên HTTP (port 5000), không có HTTPS — chấp nhận được cho internal tool
- Nên thêm auto-stop sau X phút (EventBridge Scheduler) để tránh quên tắt tốn tiền
- ECS task phải nằm trong public subnet, security group mở port 5000 inbound

**Chưa làm gì, bắt đầu từ đầu.**
