import os
import re
import uuid
import shutil
import tempfile
import subprocess
import threading
import logging
from datetime import datetime
from pathlib import Path

from flask import Flask, render_template, request, jsonify, Response
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50MB

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# ── CORS (local dev: Vite :5173 → Flask :5000) ───────────────────────────────
@app.after_request
def add_cors(response):
    origin = request.headers.get("Origin", "")
    if origin.startswith("http://localhost") or origin.startswith("http://127.0.0.1"):
        response.headers["Access-Control-Allow-Origin"]  = origin
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type, x-api-key"
    return response

@app.route("/<path:path>", methods=["OPTIONS"])
@app.route("/", methods=["OPTIONS"])
def handle_options(path=""):
    resp = jsonify({}); resp.status_code = 204; return resp

# In-memory execution store (ECS task = single process, fine for this use case)
executions: dict = {}
executions_lock = threading.Lock()


# ── Basic Auth (prod only) ─────────────────────────────────────────────────────

_RELEASE     = os.environ.get("RELEASE", "false").lower() not in ("false", "0", "no")
# ── Config ────────────────────────────────────────────────────────────────────

def get_db_config() -> dict:
    """Read only app-level config from env vars.
    DB / S3 / staging credentials are supplied by the frontend per-request.
    """
    release  = os.environ.get("RELEASE", "false").lower() not in ("false", "0", "no")
    env_mode = "prod" if release else os.environ.get("APP_ENV", "local")
    return {
        "sql_dir":   os.environ.get("SQL_DIR", "/tmp/flyway-sql"),
        "env_mode":  env_mode,
        "env_label": env_mode,
        "release":   release,
    }


def _s3_from_body() -> dict:
    """Extract S3 config sent by frontend. Never falls back to env vars."""
    body = request.get_json(silent=True) or {}
    s3   = body.get("s3", {})
    return {
        "s3_bucket": s3.get("bucket", ""),
        "s3_region": s3.get("region") or "ap-northeast-1",
        "s3_prefix": s3.get("prefix", "flyway/"),
        "sql_dir":   os.environ.get("SQL_DIR", "/tmp/flyway-sql"),
    }


# ── Helpers ────────────────────────────────────────────────────────────────────

def parse_filename(filename: str):
    m = re.match(r"^V([\d]+(?:[._]\d+)*)__(.+)\.sql$", filename, re.IGNORECASE)
    if not m:
        return None
    version = m.group(1).replace("_", ".")
    description = m.group(2).replace("_", " ")
    return {"version": f"V{version}", "raw_version": version, "description": description}


def get_staging_config() -> dict | None:
    """Returns staging DB config from env vars, or None if not configured."""
    host = os.environ.get("STAGING_DB_HOST", "").strip()
    if not host:
        return None
    base = get_db_config()
    return {
        **base,
        "host":     host,
        "port":     os.environ.get("STAGING_DB_PORT") or base["port"],
        "database": os.environ.get("STAGING_DB_NAME") or base["database"],
        "username": os.environ.get("STAGING_DB_USER") or base["username"],
        "password": os.environ.get("STAGING_DB_PASSWORD") or base["password"],
        "schema":   os.environ.get("STAGING_DB_SCHEMA") or base["schema"],
        "is_staging": True,
    }


# ── Post-migration verification helpers ───────────────────────────────────────

def _schema_snapshot(config: dict) -> dict:
    """Capture tables + columns from information_schema."""
    try:
        conn = _pg_conn(config)
        cur  = conn.cursor()
        sch  = config.get("schema", "public")
        cur.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema=%s AND table_type='BASE TABLE' ORDER BY table_name",
            (sch,),
        )
        tables = [r[0] for r in cur.fetchall()]
        cur.execute(
            "SELECT table_name, column_name, data_type "
            "FROM information_schema.columns WHERE table_schema=%s "
            "ORDER BY table_name, ordinal_position",
            (sch,),
        )
        columns: dict = {}
        for tbl, col, dtype in cur.fetchall():
            columns.setdefault(tbl, []).append({"name": col, "type": dtype})
        cur.close(); conn.close()
        return {"tables": tables, "columns": columns, "error": None}
    except Exception as e:
        return {"tables": [], "columns": {}, "error": str(e)}


def _diff_schemas(before: dict, after: dict) -> dict:
    """Compute structural diff between two schema snapshots."""
    if before.get("error") or after.get("error"):
        return {"error": before.get("error") or after.get("error")}
    b_set = set(before["tables"]); a_set = set(after["tables"])
    added   = sorted(a_set - b_set)
    removed = sorted(b_set - a_set)
    modified: dict = {}
    for tbl in b_set & a_set:
        b_cols = {c["name"] for c in before["columns"].get(tbl, [])}
        a_cols = {c["name"] for c in after["columns"].get(tbl, [])}
        add_c = sorted(a_cols - b_cols); rem_c = sorted(b_cols - a_cols)
        if add_c or rem_c:
            modified[tbl] = {"added": add_c, "removed": rem_c}
    return {
        "added_tables":    added,
        "removed_tables":  removed,
        "modified_tables": modified,
        "unchanged_count": len(b_set & a_set) - len(modified),
    }


def _db_health(config: dict) -> dict:
    """Quick connectivity + version check."""
    try:
        conn = _pg_conn(config)
        cur  = conn.cursor()
        cur.execute("SELECT version()")
        ver = cur.fetchone()[0].split(",")[0]
        cur.close(); conn.close()
        return {"ok": True, "message": ver}
    except Exception as e:
        return {"ok": False, "message": str(e)}


def _flyway_history(config: dict, limit: int = 5) -> list:
    """Query flyway_schema_history for recent applied migrations."""
    try:
        conn = _pg_conn(config)
        cur  = conn.cursor()
        cur.execute(
            "SELECT version, description, success, execution_time, installed_on "
            "FROM flyway_schema_history ORDER BY installed_rank DESC LIMIT %s",
            (limit,),
        )
        cols = [d[0] for d in cur.description]
        rows = []
        for r in cur.fetchall():
            row = dict(zip(cols, r))
            if row.get("installed_on"):
                row["installed_on"] = row["installed_on"].isoformat()
            rows.append(row)
        cur.close(); conn.close()
        return rows
    except Exception:
        return []


def test_pg_connection(host, port, database, username, password, schema):
    try:
        import psycopg2
        conn = psycopg2.connect(
            host=host, port=int(port), dbname=database,
            user=username, password=password, connect_timeout=5,
        )
        cur = conn.cursor()
        cur.execute("SELECT version()")
        ver = cur.fetchone()[0]
        cur.close()
        conn.close()
        short = ver.split(",")[0]
        return True, f"Connected ✓  {short}"
    except Exception as e:
        return False, str(e)


def run_flyway_async(execution_id: str, config: dict, target_version: str | None):
    def log(level: str, message: str):
        ts = datetime.utcnow().isoformat() + "Z"
        with executions_lock:
            executions[execution_id]["logs"].append(
                {"level": level, "message": message, "timestamp": ts}
            )
        logger.info("[%s][%s] %s", execution_id[:8], level, message)

    sql_dir  = Path(config["sql_dir"])
    jdbc_url = f"jdbc:postgresql://{config['host']}:{config['port']}/{config['database']}"

    sql_files = list(sql_dir.glob("*.sql")) if sql_dir.exists() else []
    if not sql_files:
        log("ERROR", "No .sql files found in volume. Upload files first.")
        with executions_lock:
            executions[execution_id].update({
                "status": "FAILED",
                "finishedAt": datetime.utcnow().isoformat() + "Z",
                "errorMessage": "No SQL files found.",
            })
        return

    # Capture schema state before migration (for post-migration diff)
    schema_before = _schema_snapshot(config)

    # For single-version run: copy only the matching file to a temp dir
    tmp_dir = None
    effective_dir = sql_dir
    out_of_order = "false"

    if target_version and target_version.lower() != "latest":
        target_up = target_version.upper()
        matching = [f for f in sql_files
                    if (parse_filename(f.name) or {}).get("version", "").upper() == target_up]
        if not matching:
            log("ERROR", f"No SQL file found for version {target_version} in volume.")
            with executions_lock:
                executions[execution_id].update({
                    "status": "FAILED",
                    "finishedAt": datetime.utcnow().isoformat() + "Z",
                    "errorMessage": f"No SQL file found for {target_version}.",
                })
            return
        tmp_dir = tempfile.mkdtemp(prefix="flyway-single-")
        shutil.copy2(str(matching[0]), tmp_dir)
        effective_dir = Path(tmp_dir)
        out_of_order = "true"
        log("INFO", f"Single migration : {matching[0].name}")
    else:
        log("INFO", f"SQL files : {', '.join(f.name for f in sql_files)}")

    log("INFO", f"JDBC URL  : {jdbc_url}")
    log("INFO", f"SQL dir   : {effective_dir}")

    cmd = [
        "flyway",
        f"-url={jdbc_url}",
        f"-user={config['username']}",
        f"-password={config['password']}",
        f"-locations=filesystem:{effective_dir}",
        "-validateOnMigrate=true",
        "-ignoreMigrationPatterns=*:Missing",
        "-baselineOnMigrate=true",
        "-baselineVersion=0",
        f"-outOfOrder={out_of_order}",
        "migrate",
    ]

    log("INFO", "Launching Flyway...")

    try:
        env = os.environ.copy()
        # Force IPv4: Java prefers IPv6 by default, which fails in many Docker setups
        env['JAVA_ARGS'] = '-Djava.net.preferIPv4Stack=true ' + env.get('JAVA_ARGS', '')
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env
        )
        for line in proc.stdout:
            line = line.rstrip()
            if not line:
                continue
            ll = line.lower()
            if any(k in ll for k in ("error", "failed", "exception")):
                lvl = "ERROR"
            elif any(k in ll for k in ("success", "applied", "migrated")):
                lvl = "SUCCESS"
            else:
                lvl = "INFO"
            log(lvl, line)

        proc.wait()
        finished = datetime.utcnow().isoformat() + "Z"
        if proc.returncode == 0:
            log("SUCCESS", "Migration completed successfully.")
            # Run verification before marking done so UI gets it atomically
            log("INFO", "Verifying database state…")
            schema_after = _schema_snapshot(config)
            verification = {
                "health":         _db_health(config),
                "schema_diff":    _diff_schemas(schema_before, schema_after),
                "recent_history": _flyway_history(config, limit=5),
            }
            with executions_lock:
                executions[execution_id].update({
                    "status": "SUCCESS",
                    "finishedAt": finished,
                    "verification": verification,
                })
        else:
            with executions_lock:
                executions[execution_id].update({
                    "status": "FAILED", "finishedAt": finished,
                    "errorMessage": f"Flyway exit code {proc.returncode}",
                })
            log("ERROR", f"Migration FAILED (exit code {proc.returncode}).")

    except FileNotFoundError:
        with executions_lock:
            executions[execution_id].update({
                "status": "FAILED", "finishedAt": datetime.utcnow().isoformat() + "Z",
                "errorMessage": "flyway not found",
            })
        log("ERROR", "Cannot find `flyway`. Ensure it is installed and in PATH.")
    except Exception as e:
        with executions_lock:
            executions[execution_id].update({
                "status": "FAILED", "finishedAt": datetime.utcnow().isoformat() + "Z",
                "errorMessage": str(e),
            })
        log("ERROR", f"Unexpected error: {e}")
    finally:
        if tmp_dir:
            shutil.rmtree(tmp_dir, ignore_errors=True)


# ── Page Routes ───────────────────────────────────────────────────────────────

@app.route("/api/config")
def api_config():
    """Return only server-side metadata; DB config is managed by the frontend."""
    release  = os.environ.get("RELEASE", "false").lower() not in ("false", "0", "no")
    env_mode = "prod" if release else os.environ.get("APP_ENV", "local")
    return jsonify({"env_mode": env_mode, "release": release})


@app.route("/")
def index():
    config = get_db_config()
    with executions_lock:
        history = sorted(executions.values(), key=lambda x: x["startedAt"], reverse=True)
    return render_template("index.html", config=config, history=history, active="migrate")


@app.route("/settings", methods=["GET"])
def settings():
    config = get_db_config()
    return render_template("settings.html", config=config, active="settings")


# ── API Routes ────────────────────────────────────────────────────────────────

@app.route("/api/test-connection", methods=["POST"])
def api_test_connection():
    d = request.get_json() or {}
    ok, msg = test_pg_connection(
        d.get("host", ""), d.get("port", 5432), d.get("database", ""),
        d.get("username", ""), d.get("password", ""), d.get("schema", "public"),
    )
    return jsonify({"success": ok, "message": msg})


@app.route("/api/upload", methods=["POST"])
def api_upload():
    files = request.files.getlist("files")
    config = get_db_config()
    sql_dir = Path(config["sql_dir"])
    sql_dir.mkdir(parents=True, exist_ok=True)

    uploaded, errors = [], []
    for f in files:
        if not f.filename.endswith(".sql"):
            errors.append(f"{f.filename}: not a .sql file")
            continue
        parsed = parse_filename(f.filename)
        if not parsed:
            errors.append(f"{f.filename}: invalid Flyway filename — expected V{{n}}__description.sql")
            continue
        dest = sql_dir / f.filename
        f.save(dest)
        uploaded.append({"filename": f.filename, "size": dest.stat().st_size, "parsed": parsed})

    return jsonify({"uploaded": uploaded, "errors": errors})


@app.route("/api/files", methods=["GET"])
def api_files():
    config = get_db_config()
    sql_dir = Path(config["sql_dir"])
    files = []
    if sql_dir.exists():
        for f in sorted(sql_dir.glob("*.sql")):
            parsed = parse_filename(f.name)
            files.append({"filename": f.name, "size": f.stat().st_size, "parsed": parsed})
    return jsonify({"files": files})


@app.route("/api/files/<filename>", methods=["DELETE"])
def api_delete_file(filename):
    config = get_db_config()
    path = Path(config["sql_dir"]) / filename
    if path.exists() and path.suffix == ".sql":
        path.unlink()
        return jsonify({"success": True})
    return jsonify({"success": False, "message": "File not found"}), 404


@app.route("/api/migrate", methods=["POST"])
def api_migrate():
    d = request.get_json() or {}
    target_version = d.get("version")
    db = d.get("db", {})
    config = {
        "host":     db.get("host", ""),
        "port":     db.get("port", "5432"),
        "database": db.get("database", ""),
        "username": db.get("username", ""),
        "password": db.get("password", ""),
        "schema":   db.get("schema", "public"),
        "sql_dir":  os.environ.get("SQL_DIR", "/tmp/flyway-sql"),
    }
    if not config["host"] or not config["database"]:
        return jsonify({"success": False, "message": "DB host and database name are required. Configure in Settings."}), 400

    with executions_lock:
        running = [e for e in executions.values() if e["status"] == "RUNNING"]
    if running:
        return jsonify({
            "success": False,
            "message": f"Migration already running ({running[0]['executionId'][:8]})"
        }), 409

    exec_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat() + "Z"
    record = {
        "executionId": exec_id,
        "version": target_version or "latest",
        "status": "RUNNING",
        "startedAt": now,
        "finishedAt": None,
        "logs": [],
        "errorMessage": None,
        "verification": None,
        "is_staging": False,
    }
    with executions_lock:
        executions[exec_id] = record

    thread = threading.Thread(
        target=run_flyway_async, args=(exec_id, config, target_version), daemon=True
    )
    thread.start()

    return jsonify({"executionId": exec_id, "status": "RUNNING"})


@app.route("/api/migrate/staging", methods=["POST"])
def api_migrate_staging():
    """Run migration against the staging/test DB (config sent from frontend)."""
    d = request.get_json() or {}
    target_version = d.get("version")
    stg = d.get("staging_db", {})
    if not stg.get("host"):
        return jsonify({"success": False, "message": "Staging DB not configured in Settings."}), 400
    staging = {
        "host":       stg.get("host", ""),
        "port":       stg.get("port", "5432"),
        "database":   stg.get("database", ""),
        "username":   stg.get("username", ""),
        "password":   stg.get("password", ""),
        "schema":     stg.get("schema", "public"),
        "sql_dir":    os.environ.get("SQL_DIR", "/tmp/flyway-sql"),
        "is_staging": True,
    }

    exec_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat() + "Z"
    record = {
        "executionId": exec_id,
        "version": target_version or "latest",
        "status": "RUNNING",
        "startedAt": now,
        "finishedAt": None,
        "logs": [],
        "errorMessage": None,
        "verification": None,
        "is_staging": True,
    }
    with executions_lock:
        executions[exec_id] = record

    thread = threading.Thread(
        target=run_flyway_async, args=(exec_id, staging, target_version), daemon=True
    )
    thread.start()
    return jsonify({"executionId": exec_id, "status": "RUNNING", "is_staging": True})


@app.route("/api/migrate/status/<execution_id>", methods=["GET"])
def api_migrate_status(execution_id):
    with executions_lock:
        record = executions.get(execution_id)
    if not record:
        return jsonify({"message": "Not found"}), 404
    return jsonify(record)


@app.route("/api/migrate/history", methods=["GET"])
def api_migrate_history():
    with executions_lock:
        history = sorted(executions.values(), key=lambda x: x["startedAt"], reverse=True)
    return jsonify({"migrations": list(history)})


# ── S3 Routes ─────────────────────────────────────────────────────────────────

def _s3_client(config):
    import boto3
    region = config.get("s3_region") or "ap-northeast-1"
    logger.info("Creating S3 client with region=%s", region)
    return boto3.client("s3", region_name=region)





@app.route("/api/s3/test", methods=["POST"])
def api_s3_test():
    cfg    = _s3_from_body()
    bucket = cfg["s3_bucket"]
    region = cfg.get("s3_region") or "ap-northeast-1"
    prefix = cfg["s3_prefix"].rstrip("/") + "/" if cfg["s3_prefix"] else ""
    logger.info("S3 test — bucket=%s region=%s prefix=%s", bucket, region, prefix)
    if not bucket:
        return jsonify({"success": False, "message": "S3 bucket name is required."})
    try:
        import botocore
        s3 = _s3_client(cfg)
        # get_bucket_location requires only s3:GetBucketLocation — less restrictive than HeadBucket
        # Falls back to list_objects_v2 to confirm read access
        try:
            loc = s3.get_bucket_location(Bucket=bucket)
            actual_region = loc.get("LocationConstraint") or "us-east-1"
            if actual_region != region:
                logger.warning("Bucket %s is in region %s but config says %s — reconnecting", bucket, actual_region, region)
                cfg["s3_region"] = actual_region
                s3 = _s3_client(cfg)
        except botocore.exceptions.ClientError as loc_err:
            # If GetBucketLocation is denied, proceed — not all policies allow it
            logger.warning("get_bucket_location denied (%s), skipping region check", loc_err.response["Error"]["Code"])

        s3.list_objects_v2(Bucket=bucket, Prefix=prefix, MaxKeys=1)
        return jsonify({"success": True, "message": f"s3://{bucket} reachable ✓"})
    except Exception as e:
        err_str = str(e)
        logger.error("S3 test failed: %s", err_str)
        # Surface the real AWS error so it's visible in the UI
        return jsonify({"success": False, "message": f"S3 connection failed: {err_str}"})


@app.route("/api/s3/files", methods=["POST"])
def api_s3_files():
    config = _s3_from_body()
    bucket = config["s3_bucket"]
    prefix = config["s3_prefix"].rstrip("/") + "/" if config["s3_prefix"] else ""
    if not bucket:
        return jsonify({"files": [], "error": "S3 bucket not configured."})
    try:
        s3 = _s3_client(config)
        paginator = s3.get_paginator("list_objects_v2")
        files = []
        for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                key  = obj["Key"]
                name = key[len(prefix):] if key.startswith(prefix) else key
                if name.endswith(".sql") and "/" not in name:
                    files.append({"filename": name, "size": obj["Size"],
                                  "parsed": parse_filename(name), "s3_key": key})
        files.sort(key=lambda x: x["filename"])
        parsed = [f for f in files if f.get("parsed")]
        latest_version = parsed[-1]["parsed"]["version"] if parsed else None
        return jsonify({"files": files, "latest_version": latest_version})
    except Exception as e:
        logger.error("S3 list files failed: %s", e)
        return jsonify({"files": [], "error": "S3 unavailable"})


@app.route("/api/s3/upload", methods=["POST"])
def api_s3_upload():
    config = _s3_from_body()
    bucket = config["s3_bucket"]
    prefix = config["s3_prefix"].rstrip("/") + "/" if config["s3_prefix"] else ""
    if not bucket:
        return jsonify({"success": False, "message": "S3 bucket not configured in Settings."})

    d = request.get_json(silent=True) or {}
    selected = d.get("files")  # None = upload all

    sql_dir = Path(config["sql_dir"])
    if selected:
        sql_files = [sql_dir / f for f in selected if (sql_dir / f).exists() and f.endswith(".sql")]
    else:
        sql_files = sorted(sql_dir.glob("*.sql")) if sql_dir.exists() else []
    if not sql_files:
        return jsonify({"success": False, "message": "No SQL files to upload."})

    try:
        s3 = _s3_client(config)
        uploaded = []
        for f in sql_files:
            key = prefix + f.name
            s3.upload_file(str(f), bucket, key)
            uploaded.append({"file": f.name, "s3_key": key})
        return jsonify({"success": True, "bucket": bucket, "uploaded": uploaded})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})


# ── Dev-only Routes (APP_ENV=local) ──────────────────────────────────────────

def _require_local():
    if os.environ.get("APP_ENV", "local") != "local":
        return jsonify({"success": False, "message": "Only available in local env"}), 403
    return None


def _db_from_body() -> dict:
    """Extract DB connection config from request JSON body (key: 'db')."""
    d = request.get_json() or {}
    db = d.get("db", {})
    return {
        "host":     db.get("host", ""),
        "port":     db.get("port", "5432"),
        "database": db.get("database", ""),
        "username": db.get("username", ""),
        "password": db.get("password", ""),
        "schema":   db.get("schema", "public"),
        "sql_dir":  os.environ.get("SQL_DIR", "/tmp/flyway-sql"),
    }


def _pg_conn(config):
    import psycopg2
    return psycopg2.connect(
        host=config["host"], port=int(config["port"]), dbname=config["database"],
        user=config["username"], password=config["password"], connect_timeout=5,
    )


@app.route("/api/dev/clear", methods=["POST"])
def api_dev_clear():
    err = _require_local()
    if err:
        return err
    config = _db_from_body()
    try:
        conn = _pg_conn(config)
        conn.autocommit = True
        cur = conn.cursor()
        cur.execute("""
            DROP TABLE IF EXISTS activity_log, order_items, orders, discount_codes,
                                 products, users, flyway_schema_history CASCADE;
            DROP VIEW  IF EXISTS v_recent_activity CASCADE;
        """)
        cur.close()
        conn.close()
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})

    sql_dir = Path(config["sql_dir"])
    if sql_dir.exists():
        for f in sql_dir.glob("*.sql"):
            f.unlink()

    with executions_lock:
        executions.clear()

    return jsonify({"success": True, "message": "DB cleared, files removed, history reset."})


@app.route("/api/dev/seed", methods=["POST"])
def api_dev_seed():
    err = _require_local()
    if err:
        return err
    config = _db_from_body()
    try:
        conn = _pg_conn(config)
        cur = conn.cursor()
        email = f"user_{uuid.uuid4().hex[:8]}@test.local"
        name  = f"Test User {uuid.uuid4().hex[:4].upper()}"
        cur.execute(
            "INSERT INTO users (email, name) VALUES (%s, %s) RETURNING id, email, name",
            (email, name),
        )
        row = cur.fetchone()
        conn.commit()
        cur.close()
        conn.close()
        return jsonify({"success": True, "row": {"id": str(row[0]), "email": row[1], "name": row[2]}})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})


@app.route("/api/dev/update", methods=["POST"])
def api_dev_update():
    err = _require_local()
    if err:
        return err
    config = _db_from_body()
    try:
        conn = _pg_conn(config)
        cur = conn.cursor()
        new_name = f"Updated {uuid.uuid4().hex[:6].upper()}"
        cur.execute("""
            UPDATE users SET name = %s, updated_at = NOW()
            WHERE id = (SELECT id FROM users ORDER BY created_at DESC LIMIT 1)
            RETURNING id, email, name
        """, (new_name,))
        row = cur.fetchone()
        conn.commit()
        cur.close()
        conn.close()
        if not row:
            return jsonify({"success": False, "message": "No users found — seed first."})
        return jsonify({"success": True, "row": {"id": str(row[0]), "email": row[1], "name": row[2]}})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})


@app.route("/api/dev/query", methods=["POST"])
def api_dev_query():
    err = _require_local()
    if err:
        return err
    config = _db_from_body()
    try:
        conn = _pg_conn(config)
        cur = conn.cursor()
        cur.execute("""
            SELECT id, email, name, created_at, updated_at
            FROM users ORDER BY created_at DESC LIMIT 10
        """)
        cols = [d[0] for d in cur.description]
        rows = [dict(zip(cols, [str(v) if v is not None else None for v in r])) for r in cur.fetchall()]
        cur.close()
        conn.close()
        return jsonify({"success": True, "rows": rows, "count": len(rows)})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})
    
# ── Delete Routes ─────────────────────────────────────────────────────────────

@app.route("/api/files/delete", methods=["POST"])
def api_delete_files():
    """Xóa file trên container volume (Local)"""
    config = get_db_config()
    sql_dir = Path(config["sql_dir"])
    d = request.get_json() or {}
    to_delete = d.get("files")  # list of filenames or None = all

    if not sql_dir.exists():
        return jsonify({"success": True, "deleted": []})

    deleted = []
    if to_delete is None:  # delete all
        for f in sql_dir.glob("*.sql"):
            try:
                f.unlink()
                deleted.append(f.name)
            except:
                pass
    else:
        for name in to_delete:
            path = sql_dir / name
            if path.exists() and path.suffix == ".sql":
                try:
                    path.unlink()
                    deleted.append(name)
                except:
                    pass

    return jsonify({"success": True, "deleted": deleted})


@app.route("/api/s3/download", methods=["POST"])
def api_s3_download():
    """Download files from S3 to local volume."""
    config = _s3_from_body()
    bucket = config["s3_bucket"]
    prefix = config["s3_prefix"].rstrip("/") + "/" if config["s3_prefix"] else ""
    if not bucket:
        return jsonify({"success": False, "message": "S3 bucket not configured."})

    d = request.get_json(silent=True) or {}
    selected = d.get("files")  # None = download all

    sql_dir = Path(config["sql_dir"])
    sql_dir.mkdir(parents=True, exist_ok=True)

    try:
        s3 = _s3_client(config)
        downloaded = []

        if selected is None:
            paginator = s3.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
                for obj in page.get("Contents", []):
                    key  = obj["Key"]
                    name = key[len(prefix):] if key.startswith(prefix) else key
                    if name.endswith(".sql") and "/" not in name:
                        s3.download_file(bucket, key, str(sql_dir / name))
                        downloaded.append(name)
        else:
            for name in selected:
                key = prefix + name
                s3.download_file(bucket, key, str(sql_dir / name))
                downloaded.append(name)

        return jsonify({"success": True, "downloaded": downloaded})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})


@app.route("/api/s3/delete", methods=["POST"])
def api_s3_delete():
    """Xóa file trên S3 (Prod)"""
    config = _s3_from_body()
    bucket = config["s3_bucket"]
    prefix = config["s3_prefix"].rstrip("/") + "/" if config["s3_prefix"] else ""
    
    if not bucket:
        return jsonify({"success": False, "message": "S3 bucket not configured"})

    d = request.get_json() or {}
    to_delete = d.get("files")  # list or None = all

    s3 = _s3_client(config)
    deleted = []

    try:
        if to_delete is None:  # delete all
            paginator = s3.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
                for obj in page.get("Contents", []):
                    key = obj["Key"]
                    name = key[len(prefix):] if key.startswith(prefix) else key
                    if name.endswith(".sql") and "/" not in name:
                        s3.delete_object(Bucket=bucket, Key=key)
                        deleted.append(name)
        else:
            for name in to_delete:
                key = prefix + name
                s3.delete_object(Bucket=bucket, Key=key)
                deleted.append(name)

        return jsonify({"success": True, "deleted": deleted})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})


# ── ECS Task Self-Stop ────────────────────────────────────────────────────────

def _ecs_stop_task() -> dict:
    """Call ECS StopTask on this running task using metadata endpoint v4."""
    import urllib.request, json as _json
    meta_uri = os.environ.get("ECS_CONTAINER_METADATA_URI_V4", "")
    if not meta_uri:
        raise RuntimeError("ECS_CONTAINER_METADATA_URI_V4 not set.")
    with urllib.request.urlopen(f"{meta_uri}/task", timeout=3) as r:
        meta = _json.loads(r.read())
    task_arn    = meta.get("TaskARN", "")
    cluster_arn = meta.get("Cluster", "")
    if not task_arn:
        raise RuntimeError("Could not determine TaskARN from ECS metadata.")
    import boto3
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION", "ap-northeast-1")
    ecs = boto3.client("ecs", region_name=region)
    ecs.stop_task(cluster=cluster_arn, task=task_arn, reason="Stopped by user via FlywayOps UI")
    logger.info("ECS stop_task called: cluster=%s task=%s", cluster_arn, task_arn)
    return {"taskArn": task_arn, "cluster": cluster_arn}


@app.route("/api/task/stop", methods=["POST"])
def api_task_stop():
    """
    Local  (RELEASE=false): trả về status=STOPPED để frontend update UI, container vẫn chạy.
    Prod   (RELEASE=true) : gọi ECS StopTask, container sẽ bị kill sau đó.
    """
    if not _RELEASE:
        # Local docker — chỉ phản hồi để frontend biết "đã stop" mà không tắt gì cả
        logger.info("Local stop requested — returning STOPPED status without killing container.")
        return jsonify({"success": True, "status": "STOPPED", "local": True,
                        "message": "Local mode: container still running, UI updated only."})

    # Prod — gọi ECS API thật
    try:
        info = _ecs_stop_task()
        return jsonify({"success": True, "status": "STOPPING", "local": False,
                        "message": "ECS task is stopping.", **info})
    except Exception as e:
        logger.error("Failed to stop ECS task: %s", e)
        return jsonify({"success": False, "message": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=port, debug=debug)