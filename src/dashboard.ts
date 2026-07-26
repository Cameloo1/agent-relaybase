import type { AppStatusView, HealthStatus, RuntimeStatus } from "./types.ts";

export interface DashboardAppView {
  id: string;
  name: string;
  status: RuntimeStatus;
  health: HealthStatus;
  routeAvailable: boolean;
  backendPort?: number;
  configuredPort?: number;
  backendPortKind: "fixed" | "ephemeral" | "none";
  needsAttention: boolean;
}

export function dashboardInventory(apps: AppStatusView[]): DashboardAppView[] {
  return apps.map((app) => {
    const runtimeActive = app.runtime.status === "running" || app.runtime.status === "starting";
    const assignedPort = runtimeActive ? numericPort(app.runtime.assignedPort) : undefined;
    const configuredPort = numericPort(app.upstreamPort);

    return {
      id: app.id,
      name: app.name,
      status: app.runtime.status,
      health: app.runtime.health,
      routeAvailable: app.runtime.canOpen === true,
      ...(assignedPort === undefined ? {} : { backendPort: assignedPort }),
      ...(configuredPort === undefined ? {} : { configuredPort }),
      backendPortKind: configuredPort !== undefined ? "fixed" : assignedPort !== undefined ? "ephemeral" : "none",
      needsAttention:
        app.runtime.status === "errored" ||
        app.runtime.status === "conflict" ||
        app.runtime.status === "degraded" ||
        app.runtime.health === "unhealthy"
    };
  });
}

function numericPort(value: unknown): number | undefined {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

export function dashboardHtml(options: { apps: AppStatusView[] }): string {
  const initialState = JSON.stringify({ apps: dashboardInventory(options.apps) }).replaceAll("<", "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Relaybase</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b0d10;
      --panel: #13171d;
      --panel-2: #191f27;
      --panel-3: #202833;
      --line: #2d3744;
      --line-strong: #425063;
      --text: #f4f7fb;
      --muted: #9aa8b8;
      --good: #55d69e;
      --warn: #f3c969;
      --bad: #ff8178;
      --accent: #8cc8ff;
      --accent-strong: #b8ddff;
      --shadow: 0 18px 45px rgba(0, 0, 0, 0.24);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 14% -10%, rgba(65, 126, 180, 0.18), transparent 34rem),
        var(--bg);
      color: var(--text);
      font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    button, input, select { font: inherit; }
    button, a, input, select { outline-offset: 3px; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
      padding: 20px clamp(18px, 4vw, 42px);
      border-bottom: 1px solid var(--line);
      background: rgba(13, 16, 20, 0.88);
      backdrop-filter: blur(12px);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-mark {
      width: 34px;
      height: 34px;
      display: grid;
      place-items: center;
      border: 1px solid #4d6680;
      border-radius: 10px;
      background: linear-gradient(145deg, #263a4e, #151b23);
      color: var(--accent-strong);
      font-weight: 800;
    }
    h1 { margin: 0; font-size: 17px; letter-spacing: 0.01em; }
    .eyebrow { color: var(--muted); font-size: 12px; }
    .daemon-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted);
      background: var(--panel);
    }
    .daemon-chip::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--good); }
    main { padding: 32px clamp(18px, 4vw, 42px) 48px; max-width: 1480px; margin: 0 auto; }
    .intro { display: flex; justify-content: space-between; gap: 24px; align-items: end; margin-bottom: 22px; }
    .intro h2 { margin: 0 0 5px; font-size: clamp(24px, 3vw, 34px); letter-spacing: -0.035em; }
    .intro p { margin: 0; color: var(--muted); max-width: 650px; }
    .summary {
      display: grid;
      grid-template-columns: repeat(4, minmax(110px, 1fr));
      gap: 10px;
      margin-bottom: 18px;
    }
    .metric { border: 1px solid var(--line); border-radius: 12px; background: rgba(19, 23, 29, 0.88); padding: 13px 14px; }
    .metric strong { display: block; font-size: 22px; line-height: 1.15; }
    .metric span { color: var(--muted); font-size: 12px; }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) 180px auto;
      gap: 10px;
      align-items: end;
      margin-bottom: 12px;
    }
    label { color: var(--muted); font-size: 12px; }
    input, select {
      display: block;
      width: 100%;
      margin-top: 5px;
      border: 1px solid var(--line);
      border-radius: 9px;
      background: var(--panel);
      color: var(--text);
      padding: 9px 11px;
    }
    input:focus, select:focus { border-color: var(--accent); }
    button {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel-2);
      color: var(--text);
      padding: 8px 11px;
      cursor: pointer;
    }
    button:hover { border-color: var(--accent); background: var(--panel-3); }
    button:disabled { cursor: not-allowed; opacity: 0.5; }
    button.primary { border-color: #3f6d91; background: #18344a; }
    .muted { color: var(--muted); }
    .notice { min-height: 23px; margin: 5px 0 9px; color: var(--muted); }
    .notice.error { color: var(--bad); }
    .workspace { display: grid; grid-template-columns: minmax(0, 1fr) minmax(300px, 390px); gap: 14px; align-items: start; }
    .workspace.details-closed { grid-template-columns: minmax(0, 1fr); }
    .table-shell { border: 1px solid var(--line); border-radius: 12px; overflow: auto; background: var(--panel); box-shadow: var(--shadow); }
    table { width: 100%; min-width: 820px; border-collapse: collapse; }
    th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 12px 13px; vertical-align: middle; }
    th { color: var(--muted); font-weight: 650; font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; }
    tr:last-child td { border-bottom: 0; }
    tbody tr:hover { background: #171c23; }
    code { color: var(--accent); background: #0e1217; border: 1px solid var(--line); border-radius: 5px; padding: 2px 5px; white-space: nowrap; }
    a { color: var(--accent); }
    .app-name { font-weight: 720; }
    .app-id { color: var(--muted); font-size: 12px; }
    .status { display: inline-flex; align-items: center; gap: 7px; min-width: 90px; text-transform: capitalize; }
    .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--muted); }
    .running .dot { background: var(--good); box-shadow: 0 0 0 3px rgba(85, 214, 158, 0.12); }
    .starting .dot, .stopping .dot { background: var(--warn); }
    .errored .dot, .conflict .dot { background: var(--bad); }
    .health { color: var(--muted); font-size: 12px; margin-top: 2px; }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .empty { border: 1px dashed var(--line-strong); border-radius: 12px; background: var(--panel); padding: 42px 24px; text-align: center; color: var(--muted); }
    .details { border: 1px solid var(--line); border-radius: 12px; background: var(--panel); box-shadow: var(--shadow); overflow: hidden; position: sticky; top: 88px; }
    .details[hidden] { display: none; }
    .details-header { display: flex; justify-content: space-between; gap: 12px; padding: 14px 15px; border-bottom: 1px solid var(--line); }
    .details-header h3 { margin: 0; font-size: 15px; }
    .details-body { padding: 15px; }
    .detail-grid { display: grid; grid-template-columns: 105px 1fr; gap: 8px 12px; margin: 0 0 14px; }
    .detail-grid dt { color: var(--muted); }
    .detail-grid dd { margin: 0; overflow-wrap: anywhere; }
    .details pre { max-height: 270px; overflow: auto; margin: 10px 0 0; padding: 11px; border: 1px solid var(--line); border-radius: 8px; background: #0b0f14; color: #d8e3ee; white-space: pre-wrap; font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    @media (max-width: 980px) {
      .workspace { grid-template-columns: 1fr; }
      .details { position: static; }
    }
    @media (max-width: 680px) {
      header { align-items: flex-start; }
      .eyebrow, .daemon-chip span { display: none; }
      main { padding-top: 22px; }
      .intro { align-items: start; flex-direction: column; }
      .summary { grid-template-columns: repeat(2, 1fr); }
      .toolbar { grid-template-columns: 1fr; }
      .toolbar button { width: 100%; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand"><div class="brand-mark" aria-hidden="true">R</div><div><h1>Relaybase</h1><div class="eyebrow">Local app control plane</div></div></div>
    <div class="daemon-chip"><span>127.0.0.1</span> daemon connected</div>
  </header>
  <main>
    <section class="intro"><div><h2>Registered apps</h2><p>Inspect daemon-owned application state and open routes that have passed readiness.</p></div><span id="count" class="muted"></span></section>
    <section id="summary" class="summary" aria-label="App summary"></section>
    <div class="toolbar">
      <label>Find an app<input id="search" type="search" placeholder="Search name, id, or route" autocomplete="off"></label>
      <label>Status<select id="status-filter"><option value="all">All statuses</option><option value="running">Running</option><option value="stopped">Stopped</option><option value="attention">Needs attention</option></select></label>
      <button id="refresh" class="primary" type="button">Refresh state</button>
    </div>
    <div id="notice" class="notice" role="status" aria-live="polite"></div>
    <div id="workspace" class="workspace details-closed">
      <div id="root"></div>
      <aside id="details" class="details" aria-label="App details" hidden></aside>
    </div>
  </main>
  <script>
    window.__RELAYBASE__ = ${initialState};
    const state = window.__RELAYBASE__;
    state.apps = Array.isArray(state.apps) ? state.apps : [];
    let selectedId = null;
    const root = document.querySelector("#root");
    const workspace = document.querySelector("#workspace");
    const details = document.querySelector("#details");
    const count = document.querySelector("#count");
    const summary = document.querySelector("#summary");
    const notice = document.querySelector("#notice");
    const search = document.querySelector("#search");
    const statusFilter = document.querySelector("#status-filter");

    document.querySelector("#refresh").addEventListener("click", refresh);
    search.addEventListener("input", renderList);
    statusFilter.addEventListener("change", renderList);

    function renderList() {
      renderSummary(state.apps);
      const query = search.value.trim().toLowerCase();
      const filter = statusFilter.value;
      const apps = state.apps.filter(app => {
        const haystack = [app.name, app.id, humanUrl(app)].filter(Boolean).join(" ").toLowerCase();
        return (!query || haystack.includes(query)) && statusMatches(app, filter);
      });
      count.textContent = apps.length === state.apps.length ? countLabel(apps.length) : countLabel(apps.length) + " shown of " + state.apps.length;
      if (!apps.length) {
        root.innerHTML = '<div class="empty">' + (state.apps.length ? 'No apps match the current filters.' : 'No apps are registered yet. Use Relaybase configure or the TUI to add one.') + '</div>';
        return;
      }

      root.innerHTML = '<div class="table-shell"><table><caption class="sr-only">Registered Relaybase apps</caption><thead><tr><th scope="col">App</th><th scope="col">Runtime</th><th scope="col">Route</th><th scope="col">Backend port</th><th scope="col">Actions</th></tr></thead><tbody>' +
        apps.map(app => {
          const status = app.status || 'stopped';
          const route = humanUrl(app);
          const routeHtml = app.routeAvailable === true
            ? '<a href="' + escapeHtml(route) + '"><code>' + escapeHtml(app.id) + '.localhost:' + location.port + '</code></a>'
            : '<code>' + escapeHtml(app.id) + '.localhost:' + location.port + '</code><div class="health">available after readiness</div>';
          return '<tr data-app-id="' + escapeHtml(app.id) + '">' +
            '<td><div class="app-name">' + escapeHtml(app.name || app.id) + '</div><div class="app-id">' + escapeHtml(app.id) + '</div></td>' +
            '<td><span class="status ' + escapeHtml(status) + '"><span class="dot"></span>' + escapeHtml(status) + '</span><div class="health">health ' + escapeHtml(app.health || 'unknown') + '</div></td>' +
            '<td>' + routeHtml + '</td>' +
            '<td>' + backendPortHtml(app) + '</td>' +
            '<td><div class="actions">' +
              actionButton('inspect', app.id, 'Inspect') +
            '</div></td></tr>';
        }).join('') + '</tbody></table></div>';

      root.querySelectorAll("button[data-action]").forEach(button => {
        button.addEventListener("click", () => {
          inspect(button.dataset.id);
        });
      });
    }

    function renderSummary(apps) {
      const metrics = {
        total: apps.length,
        running: apps.filter(app => app.status === 'running').length,
        stopped: apps.filter(app => app.status === 'stopped').length,
        attention: apps.filter(needsAttention).length
      };
      summary.innerHTML = metric(metrics.total, 'Registered') + metric(metrics.running, 'Running') + metric(metrics.stopped, 'Stopped') + metric(metrics.attention, 'Needs attention');
    }

    async function refresh() {
      setNotice("Refreshing daemon state…");
      try {
        const response = await fetch("/__hub/api/dashboard/apps", { credentials: "omit" });
        if (!response.ok) throw new Error(await errorText(response));
        const body = await response.json();
        state.apps = Array.isArray(body.apps) ? body.apps : [];
        renderList();
        if (selectedId && state.apps.some(app => app.id === selectedId)) inspect(selectedId, true);
        setNotice("Daemon state refreshed.");
        return true;
      } catch (error) {
        setNotice(error.message || "Refresh failed.", true);
        return false;
      }
    }

    function inspect(id, quiet = false) {
      selectedId = id;
      const app = state.apps.find(entry => entry.id === id);
      if (!app) {
        setNotice("App state is no longer available. Refresh and try again.", true);
        return;
      }
      renderDetails(app);
      if (!quiet) setNotice("Showing " + id + ".");
    }

    function renderDetails(app) {
      details.hidden = false;
      workspace.classList.remove("details-closed");
      details.innerHTML = '<div class="details-header"><div><h3>' + escapeHtml(app.name || app.id) + '</h3><div class="app-id">' + escapeHtml(app.id) + '</div></div><button id="close-details" type="button" aria-label="Close app details">Close</button></div>' +
        '<div class="details-body"><dl class="detail-grid">' +
        detail('Status', app.status || 'unknown') + detail('Health', app.health || 'unknown') +
        detail('Route', humanUrl(app)) + detail('Route state', app.routeAvailable ? 'ready' : 'waiting for readiness') +
        detail('Backend port', app.backendPort || app.configuredPort || 'none') +
        '</dl><p class="muted">Lifecycle changes and logs remain available through authenticated Relaybase clients.</p></div>';
      details.querySelector("#close-details").addEventListener("click", closeDetails);
    }

    function closeDetails() {
      selectedId = null;
      details.hidden = true;
      details.innerHTML = "";
      workspace.classList.add("details-closed");
    }

    async function errorText(response) {
      try {
        const body = await response.json();
        return body.error || body.relaybaseError && body.relaybaseError.message || JSON.stringify(body);
      } catch {
        return response.status + " " + response.statusText;
      }
    }

    function setNotice(message, isError = false) {
      notice.textContent = message;
      notice.className = isError ? "notice error" : "notice";
    }

    function statusMatches(app, filter) {
      if (filter === 'all') return true;
      if (filter === 'attention') return needsAttention(app);
      return app.status === filter;
    }

    function needsAttention(app) {
      return app.needsAttention === true;
    }

    function humanUrl(app) { return 'http://' + app.id + '.localhost:' + location.port; }
    function countLabel(value) { return value === 1 ? '1 app' : value + ' apps'; }
    function metric(value, label) { return '<div class="metric"><strong>' + value + '</strong><span>' + label + '</span></div>'; }
    function detail(label, value) { return '<dt>' + escapeHtml(label) + '</dt><dd>' + escapeHtml(value) + '</dd>'; }
    function actionButton(action, id, label) {
      return '<button data-action="' + action + '" data-id="' + escapeHtml(id) + '" type="button" aria-label="' + label + ' ' + escapeHtml(id) + '">' + label + '</button>';
    }

    function backendPortHtml(app) {
      if (app.backendPort) {
        return '<code>' + app.backendPort + '</code><div class="health">' + escapeHtml(app.backendPortKind) + '</div>';
      }
      if (app.configuredPort) return '<span class="muted">none</span><div class="health">fixed :' + app.configuredPort + ' requested</div>';
      return '<span class="muted">none</span>';
    }

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, char => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      }[char]));
    }

    renderList();
  </script>
</body>
</html>`;
}
