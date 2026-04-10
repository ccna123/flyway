/* ── State ── */
const state = {
  files: [],
  selectedVersion: null,
  executionId: null,
  pollTimer: null,
  pollCount: 0,
  running: false,
};
let cachedVersionFiles = [];
let selectedForDelete = new Set();

/* ── File handling ── */
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("drag-over"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
dropzone.addEventListener("drop", (e) => { e.preventDefault(); dropzone.classList.remove("drag-over"); addFiles(Array.from(e.dataTransfer.files)); });
fileInput.addEventListener("change", (e) => addFiles(Array.from(e.target.files)));

function parseFilename(name) {
  const m = name.match(/^V([\d]+(?:[._]\d+)*)__(.+)\.sql$/i);
  if (!m) return null;
  const ver = m[1].replace(/_/g, ".");
  return { version: `V${ver}`, raw: ver, description: m[2].replace(/_/g, " ") };
}
function fmtSize(b) { return b < 1024 ? `${b}B` : `${(b/1024).toFixed(1)}KB`; }
function escHtml(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

function addFiles(rawFiles) {
  const existing = new Set(state.files.map(f => f.file.name));
  rawFiles.filter(f => f.name.endsWith(".sql") && !existing.has(f.name))
          .forEach(f => state.files.push({ file: f, parsed: parseFilename(f.name) }));
  renderFiles();
  updateUploadBtn();
}

function removeFile(idx) {
  const name = state.files[idx].file.name;
  fetch(`/api/files/${encodeURIComponent(name)}`, { method: "DELETE" });
  state.files.splice(idx, 1);
  renderFiles();
  updateUploadBtn();
  loadVersionList();
}

function renderFiles() {
  const el = document.getElementById("file-list");
  el.innerHTML = state.files.map((f, i) => `
    <div class="file-item">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="color:var(--text3);flex-shrink:0">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14,2 14,8 20,8"/>
      </svg>
      <span class="file-name" title="${f.file.name}">${f.file.name}</span>
      ${f.parsed ? `<span class="file-ver">${f.parsed.version}</span>` : ""}
      ${f.parsed?.description ? `<span class="file-desc">${f.parsed.description}</span>` : ""}
      <span class="file-size">${fmtSize(f.file.size)}</span>
      <button class="file-del" onclick="removeFile(${i})" title="Remove">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`).join("");
}

/* ── Upload to container ── */
function updateUploadBtn() {
  const bar = document.getElementById("upload-bar");
  if (bar) bar.style.display = state.files.length > 0 ? "flex" : "none";
}

async function doUpload() {
  const btn    = document.getElementById("btn-upload-files");
  const status = document.getElementById("upload-status");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner" style="width:11px;height:11px"></span> Uploading…`;
  status.textContent = "";
  const fd = new FormData();
  state.files.forEach(f => fd.append("files", f.file));
  try {
    const res  = await fetch("/api/upload", { method: "POST", body: fd });
    const data = await res.json();
    const ok   = data.uploaded?.length > 0;
    status.textContent = ok ? `✓ ${data.uploaded.length} file(s) saved to container` : (data.errors?.[0] || "Upload failed");
    status.style.color = ok ? "var(--accent)" : "var(--red)";
    if (ok) { state.files = []; renderFiles(); updateUploadBtn(); loadVersionList(); }
  } catch (e) {
    status.textContent = e.message;
    status.style.color = "var(--red)";
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16,16 12,12 8,16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/></svg> Upload to Container`;
  }
}

/* ── Version list — always reads from container volume ── */
async function loadVersionList() {
  const el = document.getElementById("ver-list");
  el.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:16px 0;text-align:center;">Loading…</div>';
  try {
    const res  = await fetch("/api/files");
    const data = await res.json();
    if (data.error) {
      el.innerHTML = `<div style="font-size:12px;color:var(--red);padding:12px 0;text-align:center;">${escHtml(data.error)}</div>`;
      return;
    }
    cachedVersionFiles = (data.files || []).filter(f => f.parsed);
    selectedForDelete.clear();
    renderVersionChips();
  } catch (e) {
    el.innerHTML = `<div style="font-size:12px;color:var(--red);padding:12px 0;text-align:center;">${escHtml(e.message)}</div>`;
  }
}

function selectVersion(v) {
  state.selectedVersion = v;
  renderVersionChips();
  updateRunBtn();
}

function handleChipClick(event, version) {
  const cb = event.currentTarget.querySelector('.ver-delete-cb');
  if (event.target !== cb) {
    cb.checked = !cb.checked;
    toggleDeleteSelect(cb);
  }
  selectVersion(version);
}

function renderVersionChips() {
  const el = document.getElementById("ver-list");

  if (!cachedVersionFiles.length) {
    el.innerHTML = `<div style="font-size:12px;color:var(--text3);padding:16px 0;text-align:center;">No SQL files found in container volume</div>`;
    document.getElementById("delete-toolbar").style.display = "none";
    return;
  }

  document.getElementById("delete-toolbar").style.display = "flex";

  const seen = new Map();
  cachedVersionFiles.forEach(f => {
    if (!seen.has(f.parsed.version)) seen.set(f.parsed.version, f.parsed);
  });

  const unique = [...seen.values()].sort((a, b) => {
    const ra = (a.raw_version || a.raw || "").replace(/_/g, '.');
    const rb = (b.raw_version || b.raw || "").replace(/_/g, '.');
    return ra.localeCompare(rb, undefined, { numeric: true });
  });

  let html = unique.map(p => `
    <div class="ver-chip ${state.selectedVersion === p.version ? "sel" : ""}" onclick="handleChipClick(event, '${p.version}')" style="cursor:pointer; user-select:none">
      <input type="checkbox" class="ver-delete-cb" value="${p.version}"
             ${selectedForDelete.has(p.version) ? "checked" : ""}
             onchange="toggleDeleteSelect(this)" style="margin-right:8px; accent-color:var(--red)">
      <span class="chip-v">${p.version}</span>
      <span class="chip-d">${p.description || ""}</span>
    </div>`).join("");

  html += `
    <button class="ver-chip latest ${state.selectedVersion === "latest" ? "sel" : ""}" onclick="selectVersion('latest')">
      <span class="chip-v" style="color:var(--blue)">latest</span>
      <span class="chip-d">migrate all pending</span>
    </button>`;

  el.innerHTML = html;
}

function toggleDeleteSelect(cb) {
  if (cb.checked) {
    selectedForDelete.add(cb.value);
  } else {
    selectedForDelete.delete(cb.value);
  }
}

async function deleteSelected() {
  if (selectedForDelete.size === 0) {
    alert("Chưa chọn version nào để xóa");
    return;
  }
  if (!confirm(`Xóa ${selectedForDelete.size} file(s)?`)) return;

  const filesToDelete = cachedVersionFiles
    .filter(f => selectedForDelete.has(f.parsed.version))
    .map(f => f.filename);

  await performDelete(filesToDelete);
  selectedForDelete.clear();
}

async function deleteAll() {
  if (!confirm("XÓA TOÀN BỘ file migration? Hành động này không thể hoàn tác!")) return;
  await performDelete(null);
}

async function performDelete(files) {
  const statusEl = document.getElementById("delete-status");
  statusEl.textContent = "Deleting...";
  statusEl.style.color = "var(--amber)";

  const endpoint = "/api/files/delete";

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files: files })
    });
    const data = await res.json();

    if (data.success) {
      statusEl.textContent = `✓ Đã xóa ${data.deleted.length} file`;
      statusEl.style.color = "var(--accent)";
      setTimeout(() => loadVersionList(), 800);
    } else {
      statusEl.textContent = "❌ " + (data.message || "Delete failed");
      statusEl.style.color = "var(--red)";
    }
  } catch (e) {
    statusEl.textContent = "❌ Error: " + e.message;
    statusEl.style.color = "var(--red)";
  }
}

/* ── S3 file selection ── */
async function toggleS3Panel() {
  const panel = document.getElementById("s3-panel");
  const open  = panel.style.display !== "none";
  panel.style.display = open ? "none" : "block";
  if (open) return;
  const el = document.getElementById("s3-file-checkboxes");
  el.innerHTML = '<span style="font-size:11px;color:var(--text3)">Loading container files…</span>';
  try {
    const res   = await fetch("/api/files");
    const { files } = await res.json();
    if (!files.length) {
      el.innerHTML = '<span style="font-size:11px;color:var(--text3)">No files in container — upload first.</span>';
      return;
    }
    el.innerHTML = files.map(f => `
      <label style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;font-size:12px">
        <input type="checkbox" name="s3-file" value="${escHtml(f.filename)}" checked style="accent-color:var(--accent)">
        <span style="font-family:var(--mono)">${escHtml(f.filename)}</span>
        ${f.parsed ? `<span style="font-size:10px;color:var(--text3)">${f.parsed.version}</span>` : ""}
      </label>`).join("");
  } catch (e) {
    el.innerHTML = `<span style="font-size:11px;color:var(--red)">${escHtml(e.message)}</span>`;
  }
}

async function doS3Upload(mode) {
  const resultEl = document.getElementById("s3-push-result");
  const pre      = document.getElementById("s3-push-output");
  resultEl.style.display = "none";
  let selectedFiles = null;
  if (mode === "selected") {
    const checked = [...document.querySelectorAll("[name=s3-file]:checked")];
    selectedFiles  = checked.map(cb => cb.value);
    if (!selectedFiles.length) {
      resultEl.style.display = "block";
      pre.textContent = "No files selected.";
      pre.style.color = "var(--red)";
      return;
    }
  }
  try {
    const res  = await fetch("/api/s3/upload", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(selectedFiles ? { files: selectedFiles } : {}),
    });
    const data = await res.json();
    resultEl.style.display = "block";
    pre.textContent = JSON.stringify(data, null, 2);
    pre.style.color = data.success ? "var(--accent)" : "var(--red)";
    if (data.success) loadVersionList();
  } catch (e) {
    resultEl.style.display = "block";
    pre.textContent = e.message;
    pre.style.color = "var(--red)";
  }
}

/* ── Run ── */
function updateRunBtn() {
  document.getElementById("btn-run").disabled = !state.selectedVersion || state.running;
}

async function runMigration() {
  if (state.running) return;
  state.running = true;
  state.pollCount = 0;
  const btn = document.getElementById("btn-run");
  btn.disabled = true;
  btn.classList.add("running");
  btn.innerHTML = `<span class="spinner" style="width:13px;height:13px"></span> Running…`;
  document.getElementById("log-wrap").style.display = "block";
  setLog([]);
  try {
    const res  = await fetch("/api/migrate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: state.selectedVersion }),
    });
    const data = await res.json();
    if (!res.ok || !data.executionId) { showRunError(data.message || "Failed to start migration"); return; }
    state.executionId = data.executionId;
    startPolling();
  } catch (e) { showRunError(e.message); }
}

function showRunError(msg) {
  state.running = false;
  const btn = document.getElementById("btn-run");
  btn.classList.remove("running");
  btn.classList.add("failed");
  btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg> Retry`;
  btn.disabled = false;
  btn.onclick = runMigration;
  appendLog("ERROR", msg);
}

/* ── Polling ── */
function startPolling() { state.pollTimer = setInterval(poll, 3000); poll(); }

async function poll() {
  state.pollCount++;
  if (state.pollCount > 120) { clearInterval(state.pollTimer); showRunError("Timeout: exceeded 6 minutes."); return; }
  try {
    const res  = await fetch(`/api/migrate/status/${state.executionId}`);
    const data = await res.json();
    if (data.logs) setLog(data.logs);
    if (data.status === "SUCCESS") { clearInterval(state.pollTimer); onDone(true); }
    else if (data.status === "FAILED") { clearInterval(state.pollTimer); onDone(false, data.errorMessage); }
  } catch (e) { console.error("poll error", e); }
}

function onDone(ok, errMsg) {
  state.running = false;
  const btn = document.getElementById("btn-run");
  btn.classList.remove("running");
  if (ok) {
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20,6 9,17 4,12"/></svg> Migration Successful`;
    btn.style.background = "var(--accent-d)";
    btn.style.color      = "var(--accent)";
    btn.style.borderColor = "var(--accent-b)";
  } else {
    btn.classList.add("failed");
    btn.innerHTML = `↺ Retry Migration`;
    btn.disabled  = false;
    btn.onclick   = runMigration;
    if (errMsg) appendLog("ERROR", errMsg);
  }
  refreshHistory();
  loadVersionList();
}

/* ── Logs ── */
function setLog(logs) {
  const el = document.getElementById("log-panel");
  if (!logs.length) { el.innerHTML = '<div class="log-empty">Waiting for logs…</div>'; return; }
  el.innerHTML = logs.map(l => `
    <div class="log-line log-${l.level}">
      <span class="log-ts">${l.timestamp.slice(11, 19)}</span>
      <span class="log-msg">${escHtml(l.message)}</span>
    </div>`).join("");
  el.scrollTop = el.scrollHeight;
}

function appendLog(level, msg) {
  const el = document.getElementById("log-panel");
  const ts = new Date().toISOString().slice(11, 19);
  if (el.querySelector(".log-empty")) el.innerHTML = "";
  el.insertAdjacentHTML("beforeend", `<div class="log-line log-${level}"><span class="log-ts">${ts}</span><span class="log-msg">${escHtml(msg)}</span></div>`);
  el.scrollTop = el.scrollHeight;
}

/* ── History ── */
async function refreshHistory() {
  try {
    const res = await fetch("/api/migrate/history");
    const { migrations } = await res.json();
    document.getElementById("stat-total").textContent   = migrations.length;
    document.getElementById("stat-success").textContent = migrations.filter(m => m.status === "SUCCESS").length;
    document.getElementById("stat-running").textContent = migrations.filter(m => m.status === "RUNNING").length;
    document.getElementById("stat-failed").textContent  = migrations.filter(m => m.status === "FAILED").length;
    const tbody = document.getElementById("history-tbody");
    if (!migrations.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:24px">No migrations recorded yet.</td></tr>';
      return;
    }
    tbody.innerHTML = migrations.map(h => {
      const dur = h.finishedAt ? Math.round((new Date(h.finishedAt) - new Date(h.startedAt)) / 1000) + "s" : "—";
      return `<tr>
        <td class="mono" style="font-size:11px;color:var(--text3)">${h.executionId.slice(0,8)}…</td>
        <td class="mono">${h.version}</td>
        <td><span class="badge badge-${h.status}">${h.status}</span></td>
        <td class="mono text2" style="font-size:11px;">${h.startedAt.slice(0,19).replace("T"," ")}</td>
        <td class="mono text2" style="font-size:11px;">${h.finishedAt ? h.finishedAt.slice(0,19).replace("T"," ") : "—"}</td>
        <td class="mono text2" style="font-size:11px;">${dur}</td>
      </tr>`;
    }).join("");
  } catch (e) { console.error(e); }
}

/* ── Dev Tools ── */
function showDevResult(data) {
  const el = document.getElementById("dev-result");
  const pre = document.getElementById("dev-output");
  el.style.display = "block";
  pre.textContent  = JSON.stringify(data, null, 2);
  pre.style.color  = data.success === false ? "var(--red)" : "var(--accent)";
}

async function devClear() {
  if (!confirm("Drop all tables + clear files + reset history?")) return;
  const btn = document.getElementById("btn-clear");
  btn.disabled = true;
  const data = await (await fetch("/api/dev/clear", { method: "POST" })).json();
  showDevResult(data);
  btn.disabled = false;
  if (data.success) { state.files = []; renderFiles(); updateUploadBtn(); loadVersionList(); refreshHistory(); }
}
async function devSeed()   { showDevResult(await (await fetch("/api/dev/seed",   { method: "POST" })).json()); }
async function devUpdate() { showDevResult(await (await fetch("/api/dev/update", { method: "POST" })).json()); }
async function devQuery()  { showDevResult(await (await fetch("/api/dev/query")).json()); }

/* ── S3 file browser (prod only) ── */
let selectedS3 = new Set();

async function loadS3Files() {
  const listEl = document.getElementById("s3-file-list");
  if (!listEl) return;
  listEl.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:12px 0;text-align:center;">Loading…</div>';
  selectedS3.clear();
  try {
    const res  = await fetch("/api/s3/files");
    const data = await res.json();
    if (data.error) {
      listEl.innerHTML = `<div style="font-size:12px;color:var(--red);padding:8px 0;">${escHtml(data.error)}</div>`;
      return;
    }
    if (!data.files.length) {
      listEl.innerHTML = '<div style="font-size:12px;color:var(--text3);padding:12px 0;text-align:center;">No SQL files on S3</div>';
      return;
    }
    listEl.innerHTML = data.files.map(f => `
      <div class="ver-chip" onclick="toggleS3Select(event, '${escHtml(f.filename)}')" style="cursor:pointer;user-select:none">
        <input type="checkbox" class="s3-file-cb" value="${escHtml(f.filename)}"
               onchange="onS3CbChange(this)" style="margin-right:8px;accent-color:var(--blue)">
        <span class="chip-v" style="color:var(--blue)">${escHtml(f.parsed ? f.parsed.version : f.filename)}</span>
        <span class="chip-d">${escHtml(f.parsed ? f.parsed.description : "")}</span>
        <span style="margin-left:auto;font-size:10px;color:var(--text3);font-family:var(--mono)">${(f.size/1024).toFixed(1)}KB</span>
      </div>`).join("");
  } catch (e) {
    listEl.innerHTML = `<div style="font-size:12px;color:var(--red);padding:8px 0;">${escHtml(e.message)}</div>`;
  }
}

function toggleS3Select(event, filename) {
  const cb = event.currentTarget.querySelector('.s3-file-cb');
  if (event.target !== cb) {
    cb.checked = !cb.checked;
    onS3CbChange(cb);
  }
}

function onS3CbChange(cb) {
  if (cb.checked) selectedS3.add(cb.value);
  else selectedS3.delete(cb.value);
}

async function doS3Download(mode) {
  const statusEl = document.getElementById("s3-download-status");
  statusEl.textContent = "Downloading…";
  statusEl.style.color = "var(--amber)";

  let files = null;
  if (mode === "selected") {
    if (!selectedS3.size) { statusEl.textContent = "Chưa chọn file nào."; statusEl.style.color = "var(--red)"; return; }
    files = [...selectedS3];
  }

  try {
    const res  = await fetch("/api/s3/download", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files }),
    });
    const data = await res.json();
    if (data.success) {
      statusEl.textContent = `✓ Downloaded ${data.downloaded.length} file(s) to volume`;
      statusEl.style.color = "var(--accent)";
      loadVersionList();
    } else {
      statusEl.textContent = "❌ " + (data.message || "Download failed");
      statusEl.style.color = "var(--red)";
    }
  } catch (e) {
    statusEl.textContent = "❌ " + e.message;
    statusEl.style.color = "var(--red)";
  }
}

/* ── Init ── */
loadVersionList();
if (document.getElementById("s3-file-list")) loadS3Files();
