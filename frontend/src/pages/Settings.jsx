import { useState } from "react";
import { Link } from "react-router-dom";
import { testConnection, testS3 } from "../api.js";

export const STORAGE_KEY = "flyway_config";
export const DEFAULT_CONFIG = {
  host: "",
  port: "5432",
  database: "",
  username: "",
  password: "",
  schema: "public",
  s3_bucket: "",
  s3_prefix: "flyway/",
  s3_region: "ap-northeast-1",
  staging_host: "",
  staging_port: "",
  staging_db_name: "",
  staging_username: "",
  staging_password: "",
  staging_schema: "",
};

function readConfig() {
  try {
    return {
      ...DEFAULT_CONFIG,
      ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

const S = {
  input: {
    background: "#0d1117",
    border: "1px solid #30363d",
    color: "#f0f6fc",
  },
  label: { color: "#6b7280" },
  hint: { color: "#4b5563" },
};
const focusGreen = (e) => (e.target.style.borderColor = "#3ecf8e");
const blurGray = (e) => (e.target.style.borderColor = "#30363d");

function Label({ children }) {
  return (
    <label
      className="block text-xs font-mono mb-1.5 uppercase tracking-wider"
      style={S.label}
    >
      {children}
    </label>
  );
}

function Field({
  label,
  name,
  value,
  onChange,
  type = "text",
  placeholder = "",
  hint,
}) {
  return (
    <div>
      <Label>{label}</Label>
      <input
        type={type}
        name={name}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete="off"
        className="w-full rounded-lg px-3 py-2 text-xs font-mono outline-none"
        style={S.input}
        onFocus={focusGreen}
        onBlur={blurGray}
      />
      {hint && (
        <p className="text-xs mt-1" style={S.hint}>
          {hint}
        </p>
      )}
    </div>
  );
}

function PwdField({ label, name, value, onChange, placeholder = "••••••••" }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <Label>{label}</Label>
      <div style={{ position: "relative" }}>
        <input
          type={show ? "text" : "password"}
          name={name}
          value={value}
          onChange={onChange}
          autoComplete="new-password"
          placeholder={placeholder}
          className="w-full rounded-lg px-3 py-2 text-xs font-mono outline-none"
          style={{ ...S.input, paddingRight: 32 }}
          onFocus={focusGreen}
          onBlur={blurGray}
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          style={{
            position: "absolute",
            right: 8,
            top: "50%",
            transform: "translateY(-50%)",
            background: "none",
            border: "none",
            color: "#4b5563",
            cursor: "pointer",
            padding: 2,
            display: "flex",
          }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {show ? (
              <>
                <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </>
            ) : (
              <>
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </>
            )}
          </svg>
        </button>
      </div>
    </div>
  );
}

function CardHd({ accent, icon, title }) {
  return (
    <div
      className="flex items-center gap-2 px-4 py-3"
      style={{ borderBottom: "1px solid #21262d" }}
    >
      <span style={{ color: accent }}>{icon}</span>
      <span className="text-sm font-medium" style={{ color: "#f0f6fc" }}>
        {title}
      </span>
    </div>
  );
}

function TestBtn({ loading, accent, borderColor, bgColor, onClick, children }) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
      style={{
        border: `1px solid ${borderColor}`,
        color: accent,
        background: bgColor,
        cursor: "pointer",
      }}
    >
      {loading ? (
        <>
          <span
            className="w-3 h-3 rounded-full border-2 animate-spin inline-block"
            style={{ borderColor: accent, borderTopColor: "transparent" }}
          />
          Testing…
        </>
      ) : (
        <>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="22,12 18,12 15,21 9,3 6,12 2,12" />
          </svg>
          {children}
        </>
      )}
    </button>
  );
}

function TestResult({ result, okColor = "#3ecf8e" }) {
  if (!result) return null;
  return (
    <div
      className="flex items-start gap-2 rounded-lg px-3 py-2 text-xs font-mono mt-2"
      style={{
        background: result.ok ? `${okColor}14` : "rgba(246,96,112,0.08)",
        border: `1px solid ${result.ok ? `${okColor}40` : "rgba(246,96,112,0.25)"}`,
        color: result.ok ? okColor : "#f66070",
      }}
    >
      <span style={{ flexShrink: 0 }}>{result.ok ? "✓" : "✗"}</span>
      <span style={{ wordBreak: "break-word" }}>{result.text}</span>
    </div>
  );
}

function Sidebar() {
  return (
    <div
      className="fixed left-0 top-0 h-full flex flex-col"
      style={{
        width: 200,
        background: "#0d1117",
        borderRight: "1px solid #21262d",
      }}
    >
      <div
        className="px-4 py-4 flex items-center gap-2"
        style={{ borderBottom: "1px solid #21262d" }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#3ecf8e"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <ellipse cx="12" cy="5" rx="9" ry="3" />
          <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
          <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
        </svg>
        <span className="font-semibold text-sm" style={{ color: "#f0f6fc" }}>
          FlywayOps
        </span>
      </div>
      <div className="px-3 py-3 flex-1">
        <div className="text-xs mb-1 px-2" style={{ color: "#4b5563" }}>
          Navigation
        </div>
        <Link
          to="/dashboard"
          className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm mb-0.5"
          style={{ color: "#6b7280" }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
          </svg>
          Dashboard
        </Link>
        <Link
          to="/settings"
          className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm"
          style={{ color: "#3ecf8e", background: "rgba(62,207,142,0.08)" }}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.07 4.93l-1.41 1.41M4.93 4.93l1.41 1.41M19.07 19.07l-1.41-1.41M4.93 19.07l1.41-1.41M12 2v2M12 20v2M2 12h2M20 12h2" />
          </svg>
          Settings
        </Link>
      </div>
    </div>
  );
}

export default function Settings() {
  const [cfg, setCfg] = useState(readConfig);
  const [saved, setSaved] = useState(false);
  const [dbResult, setDbResult] = useState(null);
  const [dbLoading, setDbLoading] = useState(false);
  const [stgResult, setStgResult] = useState(null);
  const [stgLoading, setStgLoading] = useState(false);
  const [s3Result, setS3Result] = useState(null);
  const [s3Loading, setS3Loading] = useState(false);

  function onChange(e) {
    setSaved(false);
    setCfg((c) => ({ ...c, [e.target.name]: e.target.value }));
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  async function handleTestDb() {
    setDbLoading(true);
    setDbResult(null);
    try {
      const d = await testConnection({
        host: cfg.host,
        port: cfg.port,
        database: cfg.database,
        username: cfg.username,
        password: cfg.password,
        schema: cfg.schema,
      });
      setDbResult({ ok: d.success, text: d.message });
    } catch (e) {
      setDbResult({ ok: false, text: e.message });
    } finally {
      setDbLoading(false);
    }
  }

  async function handleTestStaging() {
    setStgLoading(true);
    setStgResult(null);
    try {
      const d = await testConnection({
        host: cfg.staging_host,
        port: cfg.staging_port || cfg.port,
        database: cfg.staging_db_name || cfg.database,
        username: cfg.staging_username || cfg.username,
        password: cfg.staging_password || cfg.password,
        schema: cfg.staging_schema || cfg.schema,
      });
      setStgResult({ ok: d.success, text: d.message });
    } catch (e) {
      setStgResult({ ok: false, text: e.message });
    } finally {
      setStgLoading(false);
    }
  }

  async function handleTestS3() {
    // Flush current cfg to localStorage so _s3Cfg() in api.js reads latest values
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
    setS3Loading(true);
    setS3Result(null);
    try {
      const d = await testS3();
      setS3Result({ ok: d.success, text: d.message });
    } catch (e) {
      setS3Result({ ok: false, text: e.message });
    } finally {
      setS3Loading(false);
    }
  }

  const saveStyle = {
    background: saved ? "rgba(62,207,142,0.15)" : "#3ecf8e",
    color: saved ? "#3ecf8e" : "#0f1117",
    border: saved ? "1px solid rgba(62,207,142,0.4)" : "none",
    transition: "all .2s",
  };

  return (
    <div style={{ background: "#0f1117", minHeight: "100vh" }}>
      <Sidebar />

      <div
        style={{
          marginLeft: 200,
          padding: "24px 28px",
          maxWidth: 980,
          display: "flex",
          flexDirection: "column",
          gap: 16,
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <div>
            <h1
              className="text-base font-semibold"
              style={{ color: "#f0f6fc" }}
            >
              Settings
            </h1>
            <p className="text-xs mt-0.5" style={{ color: "#6b7280" }}>
              Stored in localStorage · overridden by ENV vars on backend
            </p>
          </div>
          <button
            onClick={save}
            className="px-4 py-1.5 rounded-lg text-sm font-semibold"
            style={saveStyle}
          >
            {saved ? "✓ Saved" : "Save Settings"}
          </button>
        </div>

        {/* ── DB + S3 same row, same height ── */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 16,
            alignItems: "stretch",
          }}
        >
          {/* DB Connection */}
          <div
            className="rounded-xl flex flex-col overflow-hidden"
            style={{
              background: "#161b22",
              border: "1px solid rgba(62,207,142,0.25)",
            }}
          >
            <CardHd
              accent="#3ecf8e"
              title="Production DB"
              icon={
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <ellipse cx="12" cy="5" rx="9" ry="3" />
                  <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                  <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
                </svg>
              }
            />
            <div className="p-4 flex flex-col gap-3 flex-1">
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 80px",
                  gap: 10,
                }}
              >
                <Field
                  label="Host / RDS Endpoint"
                  name="host"
                  value={cfg.host}
                  onChange={onChange}
                  placeholder="my-cluster.cluster-xxx.rds.amazonaws.com"
                />
                <Field
                  label="Port"
                  name="port"
                  value={cfg.port}
                  onChange={onChange}
                  placeholder="5432"
                />
              </div>
              <Field
                label="Database Name"
                name="database"
                value={cfg.database}
                onChange={onChange}
                placeholder="mydb"
              />
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 10,
                }}
              >
                <Field
                  label="Username"
                  name="username"
                  value={cfg.username}
                  onChange={onChange}
                  placeholder="flyway_user"
                />
                <PwdField
                  label="Password"
                  name="password"
                  value={cfg.password}
                  onChange={onChange}
                />
              </div>
              <Field
                label="Schema"
                name="schema"
                value={cfg.schema}
                onChange={onChange}
                placeholder="public"
                hint="Flyway history table will be created here."
              />
              <div style={{ flex: 1 }} />
              <div>
                <TestBtn
                  loading={dbLoading}
                  accent="#3ecf8e"
                  borderColor="rgba(62,207,142,0.4)"
                  bgColor="rgba(62,207,142,0.06)"
                  onClick={handleTestDb}
                >
                  Test Production DB
                </TestBtn>
                <TestResult result={dbResult} okColor="#3ecf8e" />
              </div>
            </div>
          </div>

          {/* S3 Storage */}
          <div
            className="rounded-xl flex flex-col overflow-hidden"
            style={{ background: "#161b22", border: "1px solid #21262d" }}
          >
            <CardHd
              accent="#f5a623"
              title="S3 Storage"
              icon={
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                  <polyline points="17,8 12,3 7,8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              }
            />
            <div className="p-4 flex flex-col gap-3 flex-1">
              <Field
                label="S3 Bucket"
                name="s3_bucket"
                value={cfg.s3_bucket}
                onChange={onChange}
                placeholder="my-migrations-bucket"
              />
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 10,
                }}
              >
                <Field
                  label="Region"
                  name="s3_region"
                  value={cfg.s3_region}
                  onChange={onChange}
                  placeholder="ap-northeast-1"
                />
                <Field
                  label="Prefix"
                  name="s3_prefix"
                  value={cfg.s3_prefix}
                  onChange={onChange}
                  placeholder="flyway/"
                  hint="e.g. flyway/ → s3://bucket/flyway/V1.sql"
                />
              </div>
              <div>
                <TestBtn
                  loading={s3Loading}
                  accent="#f5a623"
                  borderColor="rgba(245,166,35,0.4)"
                  bgColor="rgba(245,166,35,0.06)"
                  onClick={handleTestS3}
                >
                  Test S3 Connection
                </TestBtn>
                <TestResult result={s3Result} okColor="#f5a623" />
              </div>
            </div>
          </div>
        </div>

        {/* ── Staging DB ── */}
        <div
          className="rounded-xl overflow-hidden"
          style={{
            background: "#161b22",
            border: "1px solid rgba(96,165,250,0.25)",
          }}
        >
          <CardHd
            accent="#60a5fa"
            title="Staging Database (optional)"
            icon={
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            }
          />
          <div className="p-4 flex flex-col gap-3">
            <p className="text-xs" style={S.hint}>
              Leave blank to skip staging test before prod migration.
            </p>
            <Field
              label="Staging Host"
              name="staging_host"
              value={cfg.staging_host}
              onChange={onChange}
              placeholder="staging.cluster-xxx.rds.amazonaws.com"
            />
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 80px",
                gap: 10,
              }}
            >
              <Field
                label="Database Name"
                name="staging_db_name"
                value={cfg.staging_db_name}
                onChange={onChange}
                placeholder="same as prod if blank"
              />
              <Field
                label="Port"
                name="staging_port"
                value={cfg.staging_port}
                onChange={onChange}
                placeholder="same"
              />
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
              }}
            >
              <Field
                label="Username"
                name="staging_username"
                value={cfg.staging_username}
                onChange={onChange}
                placeholder="same as prod if blank"
              />
              <PwdField
                label="Password"
                name="staging_password"
                value={cfg.staging_password}
                onChange={onChange}
                placeholder="same as prod if blank"
              />
            </div>
            <Field
              label="Schema"
              name="staging_schema"
              value={cfg.staging_schema}
              onChange={onChange}
              placeholder="same as prod if blank"
            />
            <div>
              <TestBtn
                loading={stgLoading}
                accent="#60a5fa"
                borderColor="rgba(96,165,250,0.4)"
                bgColor="rgba(96,165,250,0.06)"
                onClick={handleTestStaging}
              >
                Test Staging DB
              </TestBtn>
              <TestResult result={stgResult} okColor="#60a5fa" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
