// Connector harness — management UI controller.
// Vanilla JS, no build. Data comes from the harness REST API:
//   GET  /api/connectors                     list + manifest (config schema, actions)
//   PUT  /api/connectors/:id                 save { enabled?, config? }
//   POST /api/connectors/:id/test            connectivity check
//   POST /api/connectors/:id/actions/:name   run one action { args }
//   POST /api/reload                          re-import connector modules
//   GET  /api/voice/tools                     merged tool surface (bridge health)
const $ = (s, r = document) => r.querySelector(s);
const api = (p, opts) => fetch(p, opts).then((r) => r.json());

let CONNECTORS = [];
let current = null;                 // connector being configured in the modal
const view = { q: "", status: "all" };

const els = {
  grid: $("#grid"), empty: $("#empty"), stats: $("#stats"),
  search: $("#search"), statusFilter: $("#statusFilter"),
  bridgeTx: $("#bridgeTx"), bridgeDot: $("#bridgeDot"), selfUrl: $("#selfUrl"),
  reloadBtn: $("#reloadBtn"),
  modal: $("#modal"), mTitle: $("#mTitle"), mBody: $("#mBody"), mMsg: $("#mMsg"),
  mClose: $("#mClose"), mTest: $("#mTest"), mSave: $("#mSave"),
};

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 3000);
}

// ── data ──────────────────────────────────────────────────────────────────
async function refresh() {
  const data = await api("/api/connectors");
  CONNECTORS = data.connectors || [];
  els.selfUrl.textContent = location.origin;
  renderStats();
  renderGrid();
  pingBridge();
}

// ── stats strip ─────────────────────────────────────────────────────────────
function renderStats() {
  const on = CONNECTORS.filter((c) => c.enabled).length;
  const cfg = CONNECTORS.filter((c) => c.status === "needs-config").length;
  const tools = CONNECTORS.filter((c) => c.enabled).reduce((n, c) => n + c.actions.length, 0);
  els.stats.innerHTML = `
    <div class="stat"><span class="n">${CONNECTORS.length}</span><span class="l">Connectors</span></div>
    <div class="stat on"><span class="n">${on}</span><span class="l">Enabled</span></div>
    <div class="stat tools"><span class="n">${tools}</span><span class="l">Live tools</span></div>
    ${cfg ? `<div class="stat cfg"><span class="n">${cfg}</span><span class="l">Needs config</span></div>` : ""}`;
}

// ── grid + filtering ─────────────────────────────────────────────────────────
function visible() {
  const q = view.q.toLowerCase();
  return CONNECTORS.filter((c) => {
    if (view.status === "enabled" && !c.enabled) return false;
    if (view.status === "disabled" && c.enabled) return false;
    if (view.status === "needs-config" && c.status !== "needs-config") return false;
    if (!q) return true;
    const hay = [c.id, c.name, c.description, ...c.actions.map((a) => a.name + " " + a.description)].join(" ").toLowerCase();
    return hay.includes(q);
  });
}

function renderGrid() {
  const list = visible();
  els.empty.hidden = list.length > 0;
  els.grid.innerHTML = "";
  for (const c of list) els.grid.appendChild(card(c));
}

function card(c) {
  const el = document.createElement("div");
  el.className = "cc" + (c.enabled ? " is-on" : "");
  el.innerHTML = `
    <div class="cc-h">
      <div class="cc-ic">${esc(c.icon || "◆")}</div>
      <div class="cc-t">
        <div class="cc-name">${esc(c.name)}<span class="cc-id">${esc(c.id)}</span></div>
        <div class="cc-desc">${esc(c.description)}</div>
      </div>
      <span class="pill ${c.status}">${c.status.replace("-", " ")}</span>
    </div>
    <div class="cc-meta">
      <span><b>${c.actions.length}</b> action${c.actions.length === 1 ? "" : "s"}</span>
      <span><b>${c.config.length}</b> setting${c.config.length === 1 ? "" : "s"}</span>
      ${c.hasTest ? `<span>✓ self-test</span>` : ""}
    </div>
    ${docs(c)}
    <div class="cc-f">
      <label class="switch" title="Enable / disable">
        <input type="checkbox" ${c.enabled ? "checked" : ""} />
        <span class="slider"></span>
      </label>
      <span class="spacer"></span>
      <button class="btn ghost sm" data-cfg>Configure</button>
    </div>`;
  el.querySelector("input").addEventListener("change", (e) => toggle(c, e.target.checked));
  el.querySelector("[data-cfg]").addEventListener("click", () => openConfig(c));
  return el;
}

// Foldable, self-documenting panel built straight from the manifest.
function docs(c) {
  const cfgRows = c.config.length
    ? c.config.map((f) => `
        <div class="cfg-row">
          <span class="k">${esc(f.key)}</span>${f.required ? ' <span class="req">required</span>' : ""}${f.secret ? ' <span class="secret">secret</span>' : ""}
          ${f.help ? `<div class="muted">${esc(f.help)}</div>` : ""}
        </div>`).join("")
    : `<div class="cfg-row muted">No configuration needed.</div>`;

  const actRows = c.actions.map((a) => {
    const props = a.parameters?.properties || {};
    const req = new Set(a.parameters?.required || []);
    const keys = Object.keys(props);
    const params = keys.length
      ? `<div class="params">${keys.map((k) => `
          <span class="param"><span class="pn">${esc(k)}</span>: <span class="pt">${esc(props[k].type || "any")}</span>${req.has(k) ? ' <span class="preq">*</span>' : ""}${props[k].description ? ` — ${esc(props[k].description)}` : ""}</span>`).join("")}</div>`
      : `<div class="params"><span class="param muted">no parameters</span></div>`;
    return `<div class="act"><span class="nm">${esc(a.name)}</span>${a.description ? `<div class="dc">${esc(a.description)}</div>` : ""}${params}</div>`;
  }).join("");

  return `
    <details class="cc-docs">
      <summary><span class="chev">▾</span> What it does &amp; how to use it</summary>
      <div class="docs-b">
        <div class="docs-sec"><h5>Configuration</h5>${cfgRows}</div>
        <div class="docs-sec"><h5>Actions (voice tools)</h5>${actRows || '<div class="cfg-row muted">No actions.</div>'}</div>
      </div>
    </details>`;
}

async function toggle(c, enabled) {
  await api(`/api/connectors/${c.id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  toast(`${c.name} ${enabled ? "enabled" : "disabled"}`);
  refresh();
}

// ── config modal ─────────────────────────────────────────────────────────────
function openConfig(c) {
  current = c;
  els.mTitle.textContent = `${c.icon || "◆"} ${c.name}`;
  els.mMsg.textContent = ""; els.mMsg.className = "msg";
  els.mTest.hidden = !c.hasTest;
  els.mBody.innerHTML = "";

  for (const f of c.config) {
    const v = c.savedConfig?.[f.key] ?? f.default ?? "";
    const fld = document.createElement("div");
    fld.className = "fld";
    const input = f.type === "textarea"
      ? `<textarea data-k="${esc(f.key)}" placeholder="${esc(f.placeholder || "")}">${esc(v)}</textarea>`
      : `<input data-k="${esc(f.key)}" type="${f.secret ? "password" : f.type === "number" ? "number" : "text"}" value="${esc(v)}" placeholder="${esc(f.placeholder || "")}" />`;
    fld.innerHTML = `<label>${esc(f.label)}${f.required ? " *" : ""}</label>${input}${f.help ? `<span class="help">${esc(f.help)}</span>` : ""}`;
    els.mBody.appendChild(fld);
  }
  if (!c.config.length) els.mBody.innerHTML = `<p class="help">No configuration needed for this connector.</p>`;

  if (c.actions.length) {
    const wrap = document.createElement("div");
    wrap.className = "act-tester";
    wrap.innerHTML = `<h4>Test actions</h4>`;
    for (const a of c.actions) {
      const hasArgs = a.parameters && a.parameters.properties && Object.keys(a.parameters.properties).length;
      const row = document.createElement("div");
      row.className = "act-row";
      row.innerHTML = `
        <div class="top">
          <span class="nm">${esc(a.name)}</span><span class="spacer"></span>
          <button class="btn primary sm" data-run>Run</button>
        </div>
        <div class="dc">${esc(a.description || "")}</div>
        ${hasArgs ? `<input data-args placeholder='args JSON e.g. {"name":"office"}' />` : ""}
        <div class="act-out" data-out hidden></div>`;
      row.querySelector("[data-run]").addEventListener("click", () => runAction(c, a, row));
      wrap.appendChild(row);
    }
    els.mBody.appendChild(wrap);
  }
  els.modal.hidden = false;
}

const readForm = () => {
  const cfg = {};
  els.mBody.querySelectorAll("[data-k]").forEach((el) => { cfg[el.dataset.k] = el.value; });
  return cfg;
};
const saveCfg = (id) => api(`/api/connectors/${id}`, {
  method: "PUT", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ config: readForm() }),
});

async function save() {
  if (!current) return;
  els.mSave.disabled = true;
  await saveCfg(current.id);
  els.mSave.disabled = false;
  toast(`${current.name} configuration saved`);
  els.modal.hidden = true;
  refresh();
}

async function test() {
  if (!current) return;
  await saveCfg(current.id); // test against the latest values
  els.mMsg.textContent = "Testing…"; els.mMsg.className = "msg";
  const r = await api(`/api/connectors/${current.id}/test`, { method: "POST" });
  els.mMsg.textContent = r.message || (r.ok ? "OK" : "failed");
  els.mMsg.className = "msg " + (r.ok ? "ok" : "bad");
}

async function runAction(c, a, row) {
  const out = row.querySelector("[data-out]");
  const argsEl = row.querySelector("[data-args]");
  let args = {};
  if (argsEl && argsEl.value.trim()) {
    try { args = JSON.parse(argsEl.value); }
    catch { out.hidden = false; out.className = "act-out bad"; out.textContent = "invalid args JSON"; return; }
  }
  await saveCfg(c.id); // use fresh config
  out.hidden = false; out.className = "act-out"; out.textContent = "running…";
  const r = await api(`/api/connectors/${c.id}/actions/${a.name}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ args }),
  });
  if (r.error) { out.className = "act-out bad"; out.textContent = "✕ " + r.error; }
  else { out.className = "act-out ok"; out.textContent = "✔ " + (typeof r.result === "string" ? r.result : JSON.stringify(r.result)); }
}

// ── bridge health ────────────────────────────────────────────────────────────
async function pingBridge() {
  try {
    const d = await api("/api/voice/tools");
    const n = (d.tools || []).length;
    els.bridgeTx.textContent = `${n} live tool${n === 1 ? "" : "s"}`;
    els.bridgeDot.className = "dot " + (n ? "ok" : "bad");
  } catch {
    els.bridgeTx.textContent = "bridge offline"; els.bridgeDot.className = "dot bad";
  }
}

// ── events ───────────────────────────────────────────────────────────────────
els.search.addEventListener("input", (e) => { view.q = e.target.value; renderGrid(); });
els.statusFilter.addEventListener("click", (e) => {
  const b = e.target.closest("[data-f]"); if (!b) return;
  view.status = b.dataset.f;
  els.statusFilter.querySelectorAll(".seg-b").forEach((x) => x.classList.toggle("is-on", x === b));
  renderGrid();
});
els.mClose.addEventListener("click", () => (els.modal.hidden = true));
els.modal.addEventListener("click", (e) => { if (e.target === els.modal) els.modal.hidden = true; });
els.mSave.addEventListener("click", save);
els.mTest.addEventListener("click", test);
els.reloadBtn.addEventListener("click", async () => { await api("/api/reload", { method: "POST" }); toast("connectors reloaded"); refresh(); });

refresh();
setInterval(pingBridge, 5000);
