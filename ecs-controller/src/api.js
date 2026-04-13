const API_BASE = import.meta.env.VITE_API_BASE || "";
const MOCK = import.meta.env.VITE_MOCK === "true";

// ── Mock data ────────────────────────────────────────────────────────────────
let _mockFiles = [];
let _mockHistory = [];
let _mockExec = {};
let _mockStopped = false;

async function delay(ms = 400) {
  return new Promise((r) => setTimeout(r, ms));
}

async function mockCall(path, method = "GET", body = null) {
  await delay();

  // App meta
  if (path === "/api/config") return { env_mode: "local", release: false };

  // Task stop (local mock)
  if (path === "/api/task/stop" && method === "POST") {
    _mockStopped = true;
    return {
      success: true,
      local: true,
      status: "STOPPED",
      message: "Local mode: UI updated only.",
    };
  }

  // Files
  if (path === "/api/files" && method === "GET") return { files: _mockFiles };
  if (path === "/api/upload" && method === "POST") {
    const file = {
      filename: "V1__test.sql",
      size: 512,
      parsed: { version: "V1", raw_version: "1", description: "test" },
    };
    _mockFiles = [file];
    return { uploaded: ["V1__test.sql"], errors: [] };
  }
  if (path === "/api/files/delete" && method === "POST") {
    _mockFiles = [];
    return { success: true, deleted: [] };
  }
  if (path.startsWith("/api/files/") && method === "DELETE") {
    const name = decodeURIComponent(path.split("/api/files/")[1]);
    _mockFiles = _mockFiles.filter((f) => f.filename !== name);
    return { success: true };
  }

  // Migration
  if (path === "/api/migrate" && method === "POST") {
    const id = "mock-" + Date.now();
    _mockExec[id] = {
      status: "RUNNING",
      logs: [],
      startedAt: new Date().toISOString(),
    };
    setTimeout(() => {
      _mockExec[id].status = "SUCCESS";
      _mockExec[id].finishedAt = new Date().toISOString();
      _mockExec[id].logs = [
        {
          level: "INFO",
          timestamp: new Date().toISOString(),
          message: "Flyway Community Edition 10.x",
        },
        {
          level: "INFO",
          timestamp: new Date().toISOString(),
          message: "Database: jdbc:postgresql://localhost:5432/flywaydb",
        },
        {
          level: "SUCCESS",
          timestamp: new Date().toISOString(),
          message: 'Successfully applied 1 migration to schema "public"',
        },
      ];
      _mockHistory.unshift({
        executionId: id,
        version: body?.version || "latest",
        status: "SUCCESS",
        startedAt: _mockExec[id].startedAt,
        finishedAt: _mockExec[id].finishedAt,
      });
    }, 4000);
    return { executionId: id };
  }
  if (path === "/api/migrate/staging" && method === "POST") {
    const id = "stg-" + Date.now();
    _mockExec[id] = {
      status: "RUNNING",
      logs: [],
      startedAt: new Date().toISOString(),
    };
    setTimeout(() => {
      _mockExec[id].status = "SUCCESS";
      _mockExec[id].finishedAt = new Date().toISOString();
      _mockExec[id].logs = [
        {
          level: "INFO",
          timestamp: new Date().toISOString(),
          message: "Staging migration OK",
        },
      ];
    }, 3000);
    return { executionId: id };
  }
  if (path.startsWith("/api/migrate/status/")) {
    const id = path.split("/").pop();
    return _mockExec[id] || { status: "FAILED", errorMessage: "Not found" };
  }
  if (path === "/api/migrate/history") return { migrations: _mockHistory };

  // Connection test
  if (path === "/api/test-connection" && method === "POST")
    return { success: true, message: "Connection OK ✓" };
  if (path === "/api/s3/test" && method === "POST")
    return {
      success: true,
      message: "s3://mock-bucket reachable via IAM role ✓",
    };

  // S3
  if (path === "/api/s3/files" && method === "POST") return { files: [], error: null };

  // Dev tools
  if (path === "/api/dev/clear" && method === "POST") {
    _mockFiles = [];
    _mockHistory = [];
    return { success: true, message: "Cleared." };
  }
  if (path === "/api/dev/seed" && method === "POST")
    return { success: true, message: "Seeded 1 user" };
  if (path === "/api/dev/update" && method === "POST")
    return { success: true, message: "Updated user" };
  if (path === "/api/dev/query" && method === "POST")
    return {
      success: true,
      rows: [{ id: 1, name: "Test User", email: "test@example.com" }],
    };

  return { error: "Mock: unknown route " + path };
}

// ── Real fetch ───────────────────────────────────────────────────────────────
async function realCall(path, method = "GET", body = null, isFormData = false) {
  const opts = { method, headers: {} };
  if (body && !isFormData) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  if (body && isFormData) {
    opts.body = body;
  }
  const res = await fetch(`${API_BASE}${path}`, opts);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // Non-JSON response — surface the raw text so caller can show it
    throw new Error(
      `Server returned non-JSON (${res.status}): ${text.slice(0, 200)}`,
    );
  }
}

// ── Public API ───────────────────────────────────────────────────────────────
export async function call(
  path,
  method = "GET",
  body = null,
  isFormData = false,
) {
  return MOCK
    ? mockCall(path, method, body)
    : realCall(path, method, body, isFormData);
}

// App meta
export const getConfig = () => call("/api/config");

// Files
export const listFiles = () => call("/api/files");
export const deleteFile = (name) =>
  call(`/api/files/${encodeURIComponent(name)}`, "DELETE");
export const deleteFiles = (files) =>
  call("/api/files/delete", "POST", { files });
export const uploadFiles = (fd) => call("/api/upload", "POST", fd, true);

// Migration
export const startMigration = (version, db) =>
  call("/api/migrate", "POST", { version, db });
export const startStaging = (version, stagingDb) =>
  call("/api/migrate/staging", "POST", { version, staging_db: stagingDb });
export const pollStatus = (id) => call(`/api/migrate/status/${id}`);
export const getHistory = () => call("/api/migrate/history");
export const testConnection = (cfg) =>
  call("/api/test-connection", "POST", cfg);

// ── S3 config from localStorage (set by Settings page) ───────────────────────
function _s3Cfg() {
  try {
    const c = JSON.parse(localStorage.getItem("flyway_config") || "{}");
    return { bucket: c.s3_bucket || "", region: c.s3_region || "ap-northeast-1", prefix: c.s3_prefix || "flyway/" };
  } catch { return {}; }
}

export const testS3         = ()      => call("/api/s3/test",     "POST", { s3: _s3Cfg() });
export const listS3Files    = ()      => call("/api/s3/files",    "POST", { s3: _s3Cfg() });
export const uploadToS3     = (files) => call("/api/s3/upload",   "POST", { s3: _s3Cfg(), files });
export const downloadFromS3 = (files) => call("/api/s3/download", "POST", { s3: _s3Cfg(), files });

// Dev tools
export const devClear = (db) => call("/api/dev/clear", "POST", { db });
export const devSeed = (db) => call("/api/dev/seed", "POST", { db });
export const devUpdate = (db) => call("/api/dev/update", "POST", { db });
export const devQuery = (db) => call("/api/dev/query", "POST", { db });