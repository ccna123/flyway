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

from flask import Flask, render_template, request, jsonify, session
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "flyway-secret-change-in-prod")
app.config["MAX_CONTENT_LENGTH"] = 50 * 1024 * 1024  # 50MB

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# In-memory execution store (ECS task = single process, fine for this use case)
executions: dict = {}
executions_lock = threading.Lock()


# ── Config ────────────────────────────────────────────────────────────────────

def get_db_config() -> dict:
    """Session overrides ENV vars — UI settings take priority."""
    return {
        "db_type":        session.get("db_type")        or os.environ.get("DB_TYPE", "postgresql"),
        "host":           session.get("db_host")         or os.environ.get("DB_HOST", ""),
        "port":           session.get("db_port")         or os.environ.get("DB_PORT", "5432"),
        "database":       session.get("db_name")         or os.environ.get("DB_NAME", ""),
        "username":       session.get("db_user")         or os.environ.get("DB_USER", ""),
        "password":       session.get("db_password")     or os.environ.get("DB_PASSWORD", ""),
        "schema":         session.get("db_schema")       or os.environ.get("DB_SCHEMA", "public"),
        "sql_dir":        session.get("sql_dir")         or os.environ.get("SQL_DIR", "/tmp/flyway-sql"),
        # env mode (local vs prod) — drives UI visibility
        "env_mode":   session.get("env_mode")  or os.environ.get("APP_ENV", "local"),
        "env_label":  session.get("env_mode")  or os.environ.get("APP_ENV", "local"),
        # S3 — PROD only, credentials via IAM role
        "s3_bucket":  session.get("s3_bucket") or os.environ.get("S3_BUCKET", ""),
        "s3_region":  session.get("s3_region") or os.environ.get("S3_REGION", "ap-northeast-1"),
        "s3_prefix":  session.get("s3_prefix") or os.environ.get("S3_PREFIX", "flyway/"),
    }


def save_db_config(form):
    field_map = {
        "db_type": "db_type", "host": "db_host", "port": "db_port",
        "database": "db_name", "username": "db_user", "password": "db_password",
        "schema": "db_schema", "sql_dir": "sql_dir",
        "env_mode": "env_mode",
        "s3_bucket": "s3_bucket", "s3_region": "s3_region", "s3_prefix": "s3_prefix",
    }
    for form_key, session_key in field_map.items():
        val = form.get(form_key, "").strip()
        session[session_key] = val


# ── Helpers ────────────────────────────────────────────────────────────────────

def parse_filename(filename: str):
    m = re.match(r"^V([\d]+(?:[._]\d+)*)__(.+)\.sql$", filename, re.IGNORECASE)
    if not m:
        return None
    version = m.group(1).replace("_", ".")
    description = m.group(2).replace("_", " ")
    return {"version": f"V{version}", "raw_version": version, "description": description}


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
        f"-outOfOrder={out_of_order}",
        "migrate",
    ]

    log("INFO", "Launching Flyway...")

    try:
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
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
            with executions_lock:
                executions[execution_id].update({"status": "SUCCESS", "finishedAt": finished})
            log("SUCCESS", "Migration completed successfully.")
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

@app.route("/")
def index():
    config = get_db_config()
    with executions_lock:
        history = sorted(executions.values(), key=lambda x: x["startedAt"], reverse=True)
    return render_template("index.html", config=config, history=history, active="migrate")


@app.route("/settings", methods=["GET", "POST"])
def settings():
    saved = False
    if request.method == "POST":
        save_db_config(request.form)
        saved = True
    config = get_db_config()
    return render_template("settings.html", config=config, active="settings", saved=saved)


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
        dest = sql_dir / f.filename
        f.save(dest)
        parsed = parse_filename(f.filename)
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
    config = get_db_config()
    d = request.get_json() or {}
    target_version = d.get("version")

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
    }
    with executions_lock:
        executions[exec_id] = record

    thread = threading.Thread(
        target=run_flyway_async, args=(exec_id, config, target_version), daemon=True
    )
    thread.start()

    return jsonify({"executionId": exec_id, "status": "RUNNING"})


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
    return boto3.client("s3", region_name=config.get("s3_region", "ap-northeast-1"))


@app.route("/api/s3/test", methods=["POST"])
def api_s3_test():
    d = request.get_json() or {}
    cfg = get_db_config()
    bucket = d.get("bucket") or cfg["s3_bucket"]
    if not bucket:
        return jsonify({"success": False, "message": "S3 bucket name is required."})
    try:
        s3 = _s3_client(cfg)
        s3.head_bucket(Bucket=bucket)
        return jsonify({"success": True, "message": f"s3://{bucket} reachable via IAM role ✓"})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)})


@app.route("/api/s3/files", methods=["GET"])
def api_s3_files():
    config = get_db_config()
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
        return jsonify({"files": files})
    except Exception as e:
        return jsonify({"files": [], "error": str(e)})


@app.route("/api/s3/upload", methods=["POST"])
def api_s3_upload():
    config = get_db_config()
    bucket = config["s3_bucket"]
    prefix = config["s3_prefix"].rstrip("/") + "/" if config["s3_prefix"] else ""
    if not bucket:
        return jsonify({"success": False, "message": "S3 bucket not configured in Settings."})

    d = request.get_json() or {}
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
    config = get_db_config()
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
    config = get_db_config()
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
    config = get_db_config()
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


@app.route("/api/dev/query", methods=["GET"])
def api_dev_query():
    err = _require_local()
    if err:
        return err
    config = get_db_config()
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
    config = get_db_config()
    bucket = config["s3_bucket"]
    prefix = config["s3_prefix"].rstrip("/") + "/" if config["s3_prefix"] else ""
    if not bucket:
        return jsonify({"success": False, "message": "S3 bucket not configured."})

    d = request.get_json() or {}
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
    config = get_db_config()
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


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=port, debug=debug)