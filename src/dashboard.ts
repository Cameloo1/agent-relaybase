import type { AppStatusView } from "./types.ts";

export function dashboardHtml(options: { token: string; apps: AppStatusView[] }): string {
  const initialState = JSON.stringify({ token: options.token, apps: options.apps }).replaceAll("<", "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Relaybase</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101114;
      --panel: #191b20;
      --panel-2: #20242b;
      --line: #323842;
      --text: #eef1f6;
      --muted: #9aa4b2;
      --good: #5ad69a;
      --warn: #f6c95f;
      --bad: #ff7b72;
      --accent: #8cc8ff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 18px 22px;
      border-bottom: 1px solid var(--line);
      background: #15171b;
    }
    h1 { margin: 0; font-size: 18px; letter-spacing: 0; }
    main { padding: 20px; max-width: 1180px; margin: 0 auto; }
    .toolbar {
      display: flex;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 14px;
    }
    .muted { color: var(--muted); }
    button {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel-2);
      color: var(--text);
      padding: 8px 10px;
      cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      overflow: hidden;
    }
    th, td {
      text-align: left;
      border-bottom: 1px solid var(--line);
      padding: 10px 12px;
      vertical-align: middle;
    }
    th {
      color: var(--muted);
      font-weight: 600;
      font-size: 12px;
      text-transform: uppercase;
    }
    tr:last-child td { border-bottom: 0; }
    code {
      color: var(--accent);
      background: #111419;
      border: 1px solid var(--line);
      border-radius: 5px;
      padding: 2px 5px;
      white-space: nowrap;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 82px;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--muted);
    }
    .running .dot { background: var(--good); }
    .starting .dot { background: var(--warn); }
    .errored .dot, .conflict .dot { background: var(--bad); }
    .actions { display: flex; gap: 8px; }
    .empty {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 30px;
      text-align: center;
      color: var(--muted);
    }
    .notice {
      min-height: 20px;
      margin-bottom: 10px;
      color: var(--muted);
    }
    .notice.error { color: var(--bad); }
    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    @media (max-width: 760px) {
      table, thead, tbody, tr, th, td { display: block; }
      thead { display: none; }
      tr { border-bottom: 1px solid var(--line); padding: 10px 0; }
      td { border-bottom: 0; padding: 6px 12px; }
      .actions { flex-wrap: wrap; }
    }
  </style>
</head>
<body>
  <header>
    <h1>Relaybase</h1>
    <span class="muted">127.0.0.1</span>
  </header>
  <main>
    <div class="toolbar">
      <span id="count" class="muted"></span>
      <button id="refresh" type="button">Refresh</button>
    </div>
    <div id="notice" class="notice" role="status" aria-live="polite"></div>
    <div id="root"></div>
  </main>
  <script>
    window.__RELAYBASE__ = ${initialState};
    const state = window.__RELAYBASE__;
    const root = document.querySelector("#root");
    const count = document.querySelector("#count");
    const notice = document.querySelector("#notice");

    document.querySelector("#refresh").addEventListener("click", refresh);

    function render(apps) {
      count.textContent = apps.length === 1 ? "1 app" : apps.length + " apps";
      if (!apps.length) {
        root.innerHTML = '<div class="empty">No apps registered.</div>';
        return;
      }

      root.innerHTML = '<table><caption class="sr-only">Registered Relaybase apps</caption><thead><tr><th scope="col">App</th><th scope="col">Status</th><th scope="col">Route</th><th scope="col">Backend port</th><th scope="col">Actions</th></tr></thead><tbody>' +
        apps.map(app => {
          const status = app.runtime.status;
          const href = 'http://' + app.id + '.localhost:' + location.port;
          const backendPort = backendPortHtml(app);
          const startDisabled = app.runtime && app.runtime.canStart === false ? ' disabled aria-disabled="true"' : '';
          const stopDisabled = app.runtime && app.runtime.canStop === false ? ' disabled aria-disabled="true"' : '';
          const appLabel = escapeHtml(app.name || app.id);
          return '<tr>' +
            '<td><strong>' + escapeHtml(app.name) + '</strong><br><span class="muted">' + escapeHtml(app.id) + '</span></td>' +
            '<td><span class="status ' + status + '"><span class="dot"></span>' + status + '</span></td>' +
            '<td><a href="' + href + '"><code>' + escapeHtml(app.id) + '.localhost:' + location.port + '</code></a></td>' +
            '<td>' + backendPort + '</td>' +
            '<td><div class="actions"><button data-action="start" data-id="' + escapeHtml(app.id) + '" aria-label="Start ' + appLabel + '"' + startDisabled + '>Start</button><button data-action="stop" data-id="' + escapeHtml(app.id) + '" aria-label="Stop ' + appLabel + '"' + stopDisabled + '>Stop</button></div></td>' +
          '</tr>';
        }).join('') + '</tbody></table>';

      root.querySelectorAll("button[data-action]").forEach(button => {
        button.addEventListener("click", () => mutate(button.dataset.action, button.dataset.id));
      });
    }

    async function refresh() {
      try {
        const response = await fetch("/__hub/api/apps");
        if (!response.ok) {
          throw new Error(await errorText(response));
        }
        const body = await response.json();
        render(body.apps || []);
        setNotice("App list refreshed.");
      } catch (error) {
        setNotice(error.message || "Refresh failed.", true);
      }
    }

    async function mutate(action, id) {
      const buttons = Array.from(root.querySelectorAll("button[data-action]")).filter(button => button.dataset.id === id);
      buttons.forEach(button => { button.disabled = true; });
      const present = action === "start" ? "Starting" : action === "stop" ? "Stopping" : action + "ing";
      const past = action === "start" ? "Start" : action === "stop" ? "Stop" : action;
      setNotice(present + " " + id + "...");
      try {
        const response = await fetch("/__hub/api/apps/" + encodeURIComponent(id) + "/" + action, {
          method: "POST",
          headers: { "X-Relaybase-Token": state.token }
        });
        if (!response.ok) {
          throw new Error(await errorText(response));
        }
        await refresh();
        setNotice(past + " completed for " + id + ".");
      } catch (error) {
        setNotice(error.message || action + " failed.", true);
        buttons.forEach(button => { button.disabled = false; });
      }
    }

    async function errorText(response) {
      try {
        const body = await response.json();
        return body.error || JSON.stringify(body);
      } catch {
        return response.status + " " + response.statusText;
      }
    }

    function setNotice(message, isError = false) {
      notice.textContent = message;
      notice.className = isError ? "notice error" : "notice";
    }

    function backendPortHtml(app) {
      const runtimeActive = app.runtime && (app.runtime.status === 'running' || app.runtime.status === 'starting');
      const runtimePort = runtimeActive ? numericPort(app.runtime && app.runtime.assignedPort) : null;
      const fixedPort = numericPort(app.upstreamPort);
      if (runtimePort) {
        const detail = fixedPort ? 'fixed :' + fixedPort : 'ephemeral';
        return '<code>' + runtimePort + '</code><br><span class="muted">' + detail + '</span>';
      }
      if (fixedPort) {
        return '<span class="muted">none</span><br><span class="muted">fixed :' + fixedPort + ' requested</span>';
      }
      return '<span class="muted">none</span>';
    }

    function numericPort(value) {
      const port = Number(value);
      return Number.isInteger(port) && port > 0 ? port : null;
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }

    render(state.apps);
  </script>
</body>
</html>`;
}
