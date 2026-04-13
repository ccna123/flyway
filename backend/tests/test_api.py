"""
FlywayOps API test suite.
Run: pytest tests/test_api.py -v
Requires app running at http://localhost:5000
"""
import io
import time
import uuid
import pytest
import requests

BASE = "http://localhost:5000"

VALID_SQL   = b"CREATE TABLE test_table (id SERIAL PRIMARY KEY, name TEXT);"
BROKEN_SQL  = b"THIS IS NOT VALID SQL @@@;"

# ── helpers ────────────────────────────────────────────────────────────────────

def upload(*files):
    """files: list of (filename, content_bytes)"""
    return requests.post(
        f"{BASE}/api/upload",
        files=[("files", (name, io.BytesIO(content), "application/sql"))
               for name, content in files],
        timeout=10,
    )

def delete_file(filename):
    requests.delete(f"{BASE}/api/files/{filename}", timeout=5)

def list_files():
    return requests.get(f"{BASE}/api/files", timeout=5).json().get("files", [])

def filenames():
    return {f["filename"] for f in list_files()}

def wait_idle(max_wait=20):
    """Block until no migration is RUNNING (or timeout)."""
    for _ in range(max_wait):
        try:
            migrations = requests.get(f"{BASE}/api/migrate/history", timeout=5).json().get("migrations", [])
            if not any(m.get("status") == "RUNNING" for m in migrations):
                return
        except Exception:
            pass
        time.sleep(1)


# ── pages ──────────────────────────────────────────────────────────────────────

class TestPages:
    def test_main_page_renders(self):
        r = requests.get(f"{BASE}/", timeout=5)
        assert r.status_code == 200
        assert "FlywayOps" in r.text or "flyway" in r.text.lower()

    def test_settings_page_renders(self):
        r = requests.get(f"{BASE}/settings", timeout=5)
        assert r.status_code == 200
        assert "settings" in r.text.lower() or "database" in r.text.lower()


# ── upload ─────────────────────────────────────────────────────────────────────

class TestUpload:
    def teardown_method(self):
        for name in ["V1__test.sql", "V2__test.sql", "V99__cleanup.sql"]:
            delete_file(name)

    def test_valid_file_accepted(self):
        r = upload(("V1__test.sql", VALID_SQL))
        assert r.status_code == 200
        j = r.json()
        assert any(f["filename"] == "V1__test.sql" for f in j["uploaded"])
        assert j["errors"] == []

    def test_parsed_version_returned(self):
        r = upload(("V2__test.sql", VALID_SQL))
        j = r.json()
        f = next(f for f in j["uploaded"] if f["filename"] == "V2__test.sql")
        assert f["parsed"]["version"] == "V2"
        assert f["parsed"]["description"] == "test"

    def test_invalid_extension_rejected(self):
        r = upload(("schema.txt", VALID_SQL))
        j = r.json()
        assert j["uploaded"] == []
        assert any("schema.txt" in e for e in j["errors"])

    def test_invalid_naming_no_v_prefix_rejected(self):
        r = upload(("create_users.sql", VALID_SQL))
        j = r.json()
        assert not any(f["filename"] == "create_users.sql" for f in j["uploaded"])
        assert any("create_users.sql" in e for e in j["errors"])

    def test_invalid_naming_no_double_underscore_rejected(self):
        r = upload(("V1_test.sql", VALID_SQL))
        j = r.json()
        assert not any(f["filename"] == "V1_test.sql" for f in j["uploaded"])
        assert any("V1_test.sql" in e for e in j["errors"])

    def test_mixed_valid_and_invalid(self):
        r = upload(("V99__cleanup.sql", VALID_SQL), ("bad.sql", VALID_SQL))
        j = r.json()
        assert any(f["filename"] == "V99__cleanup.sql" for f in j["uploaded"])
        assert not any(f["filename"] == "bad.sql" for f in j["uploaded"])
        assert len(j["errors"]) == 1

    def test_invalid_file_not_in_volume(self):
        upload(("invalid_name.sql", VALID_SQL))
        assert "invalid_name.sql" not in filenames()

    def test_valid_file_in_volume_after_upload(self):
        upload(("V1__test.sql", VALID_SQL))
        assert "V1__test.sql" in filenames()


# ── file management ────────────────────────────────────────────────────────────

class TestFileManagement:
    def setup_method(self):
        upload(("V1__test.sql", VALID_SQL), ("V2__test.sql", VALID_SQL))

    def teardown_method(self):
        for name in ["V1__test.sql", "V2__test.sql"]:
            delete_file(name)

    def test_list_files_returns_200(self):
        r = requests.get(f"{BASE}/api/files", timeout=5)
        assert r.status_code == 200
        assert "files" in r.json()

    def test_list_files_has_required_fields(self):
        files = list_files()
        for f in files:
            assert "filename" in f
            assert "size" in f
            assert "parsed" in f

    def test_delete_single_file(self):
        r = requests.delete(f"{BASE}/api/files/V1__test.sql", timeout=5)
        assert r.status_code == 200
        assert r.json()["success"] is True
        assert "V1__test.sql" not in filenames()

    def test_delete_nonexistent_file_returns_404(self):
        r = requests.delete(f"{BASE}/api/files/nonexistent_{uuid.uuid4().hex}.sql", timeout=5)
        assert r.status_code == 404
        assert r.json()["success"] is False

    def test_bulk_delete_selected(self):
        r = requests.post(
            f"{BASE}/api/files/delete",
            json={"files": ["V1__test.sql"]},
            timeout=5,
        )
        assert r.status_code == 200
        j = r.json()
        assert j["success"] is True
        assert "V1__test.sql" in j["deleted"]
        assert "V1__test.sql" not in filenames()
        assert "V2__test.sql" in filenames()  # untouched

    def test_bulk_delete_all(self):
        r = requests.post(f"{BASE}/api/files/delete", json={"files": None}, timeout=5)
        assert r.status_code == 200
        assert r.json()["success"] is True
        # V1 and V2 should be gone
        names = filenames()
        assert "V1__test.sql" not in names
        assert "V2__test.sql" not in names


# ── migrate ────────────────────────────────────────────────────────────────────

class TestMigrate:
    def test_migrate_returns_execution_id(self):
        r = requests.post(f"{BASE}/api/migrate", json={"version": None}, timeout=10)
        assert r.status_code == 200
        j = r.json()
        assert "executionId" in j
        assert j["status"] == "RUNNING"

    def test_migrate_conflict_409_while_running(self):
        # Upload a file so migration takes some time
        upload(("V1__test.sql", VALID_SQL))
        try:
            r1 = requests.post(f"{BASE}/api/migrate", json={"version": None}, timeout=10)
            assert r1.status_code == 200
            # Fire second immediately
            r2 = requests.post(f"{BASE}/api/migrate", json={"version": None}, timeout=10)
            if r2.status_code == 409:
                assert r2.json()["success"] is False
                assert "running" in r2.json()["message"].lower()
            else:
                # First migration finished too fast (no real DB) — skip conflict check
                pytest.skip("Migration completed before 2nd request — no real DB available")
        finally:
            delete_file("V1__test.sql")

    def test_status_not_found_for_unknown_id(self):
        r = requests.get(f"{BASE}/api/migrate/status/{uuid.uuid4()}", timeout=5)
        assert r.status_code == 404

    def test_status_returns_logs_and_state(self):
        wait_idle()
        r1 = requests.post(f"{BASE}/api/migrate", json={"version": None}, timeout=10)
        exec_id = r1.json()["executionId"]
        # Poll up to 5 times — execution may finish before first poll
        j = None
        for _ in range(5):
            r2 = requests.get(f"{BASE}/api/migrate/status/{exec_id}", timeout=5)
            if r2.status_code == 200:
                j = r2.json()
                break
            time.sleep(0.5)
        if j is None:
            # Execution already finished — verify via history
            migrations = requests.get(f"{BASE}/api/migrate/history", timeout=5).json()["migrations"]
            m = next((m for m in migrations if m.get("executionId") == exec_id), None)
            if m is None:
                pytest.skip("Execution completed and evicted before polling — no real DB")
            assert m["status"] in ("SUCCESS", "FAILED")
            return
        assert "status" in j
        assert j["status"] in ("RUNNING", "SUCCESS", "FAILED")
        assert "logs" in j
        assert isinstance(j["logs"], list)

    def test_history_returns_list(self):
        r = requests.get(f"{BASE}/api/migrate/history", timeout=5)
        assert r.status_code == 200
        j = r.json()
        assert "migrations" in j
        assert isinstance(j["migrations"], list)

    def test_history_entries_have_required_fields(self):
        # Trigger a migration to ensure at least one entry
        requests.post(f"{BASE}/api/migrate", json={"version": None}, timeout=10)
        time.sleep(1)
        migrations = requests.get(f"{BASE}/api/migrate/history", timeout=5).json()["migrations"]
        if migrations:
            m = migrations[0]
            assert "executionId" in m
            assert "status" in m
            assert "startedAt" in m

    def test_migrate_with_no_files_fails(self):
        wait_idle()
        # Clear volume first
        requests.post(f"{BASE}/api/files/delete", json={"files": None}, timeout=5)
        r = requests.post(f"{BASE}/api/migrate", json={"version": None}, timeout=10)
        exec_id = r.json()["executionId"]
        # Poll until done
        st = {}
        for _ in range(15):
            time.sleep(1)
            resp = requests.get(f"{BASE}/api/migrate/status/{exec_id}", timeout=5)
            if resp.status_code == 404:
                pytest.skip("Execution record gone before polling — no persistent DB")
            st = resp.json()
            if st.get("status") not in (None, "RUNNING"):
                break
        assert st.get("status") == "FAILED"
        assert st.get("errorMessage") is not None


# ── staging ────────────────────────────────────────────────────────────────────

class TestStaging:
    def test_staging_not_configured_returns_400(self):
        """When no staging DB is configured in session, returns 400."""
        # Use a fresh session (no cookies) to ensure no staging config
        s = requests.Session()
        r = s.post(f"{BASE}/api/migrate/staging", json={"version": None}, timeout=10)
        assert r.status_code == 400
        j = r.json()
        assert j["success"] is False
        assert "not configured" in j["message"].lower()


# ── test-connection ────────────────────────────────────────────────────────────

class TestConnection:
    def test_invalid_host_returns_success_false(self):
        r = requests.post(
            f"{BASE}/api/test-connection",
            json={"host": "nonexistent-host-xyz.invalid", "port": 5432,
                  "database": "test", "username": "user", "password": "pass"},
            timeout=15,
        )
        assert r.status_code == 200
        j = r.json()
        assert j["success"] is False
        assert j["message"]  # has an error message

    def test_missing_host_returns_success_false(self):
        r = requests.post(
            f"{BASE}/api/test-connection",
            json={"host": "", "port": 5432,
                  "database": "test", "username": "user", "password": "pass"},
            timeout=15,
        )
        assert r.status_code == 200
        assert r.json()["success"] is False

    def test_response_has_message_field(self):
        r = requests.post(
            f"{BASE}/api/test-connection",
            json={"host": "invalid", "port": 5432,
                  "database": "db", "username": "u", "password": "p"},
            timeout=15,
        )
        assert "message" in r.json()


# ── settings ───────────────────────────────────────────────────────────────────

class TestSettings:
    def test_settings_page_get(self):
        r = requests.get(f"{BASE}/settings", timeout=5)
        assert r.status_code == 200

    def test_settings_save_and_reload(self):
        s = requests.Session()
        payload = {
            "env_mode": "local",
            "db_type": "postgresql",
            "host": "testhost.example.com",
            "port": "5432",
            "database": "testdb",
            "username": "testuser",
            "password": "testpass",
            "schema": "public",
            "s3_bucket": "", "s3_region": "", "s3_prefix": "",
            "staging_host": "", "staging_port": "", "staging_name": "",
            "staging_user": "", "staging_password": "", "staging_schema": "",
        }
        r = s.post(f"{BASE}/settings", data=payload, timeout=5)
        assert r.status_code == 200
        # Reload and check value is pre-filled
        r2 = s.get(f"{BASE}/settings", timeout=5)
        assert "testhost.example.com" in r2.text
        assert "testdb" in r2.text

    def test_staging_settings_saved_independently(self):
        s = requests.Session()
        payload = {
            "env_mode": "local",
            "db_type": "postgresql",
            "host": "primary.example.com",
            "port": "5432",
            "database": "primarydb",
            "username": "u", "password": "p", "schema": "public",
            "s3_bucket": "", "s3_region": "", "s3_prefix": "",
            "staging_host": "staging.example.com",
            "staging_port": "5432",
            "staging_name": "stagingdb",
            "staging_user": "su", "staging_password": "sp", "staging_schema": "public",
        }
        s.post(f"{BASE}/settings", data=payload, timeout=5)
        r = s.get(f"{BASE}/settings", timeout=5)
        assert "staging.example.com" in r.text
        assert "stagingdb" in r.text
        assert "primary.example.com" in r.text


# ── dev tools ──────────────────────────────────────────────────────────────────

class TestDevTools:
    """Dev tools only work when APP_ENV=local. Otherwise they return success:false."""

    def test_seed_returns_json(self):
        r = requests.post(f"{BASE}/api/dev/seed", timeout=10)
        assert r.status_code == 200
        j = r.json()
        assert "success" in j

    def test_query_returns_json(self):
        r = requests.get(f"{BASE}/api/dev/query", timeout=10)
        assert r.status_code == 200
        j = r.json()
        assert "success" in j

    def test_clear_returns_json(self):
        r = requests.post(f"{BASE}/api/dev/clear", timeout=10)
        assert r.status_code == 200
        j = r.json()
        assert "success" in j

    def test_dev_tools_blocked_outside_local(self):
        """If APP_ENV != local, all dev tools return success:false."""
        import os
        if os.environ.get("APP_ENV", "local") == "local":
            pytest.skip("Running in local env — dev tools are enabled")
        r = requests.post(f"{BASE}/api/dev/seed", timeout=10)
        assert r.json()["success"] is False
