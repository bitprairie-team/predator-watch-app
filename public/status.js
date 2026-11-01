// Renders /api/status as a table.
import { apiFetch } from "/net.js";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// Short times ("Oct 31, 2:52 PM"; the year only when it is not this year),
// with the full date and time in a tooltip and the machine-readable value.
const when = (iso) => {
  if (!iso) return "never";
  const d = new Date(iso);
  const opts = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleString([], opts);
};
const full = (iso) => new Date(iso).toLocaleString([], { dateStyle: "full", timeStyle: "long" });
const time = (iso) => (iso ? `<time datetime="${esc(iso)}" title="${esc(full(iso))}">${esc(when(iso))}</time>` : "never");

const every = (m) => (m % 10080 === 0 ? (m === 10080 ? "weekly" : `every ${m / 10080} weeks`) : m % 1440 === 0 ? (m === 1440 ? "daily" : `every ${m / 1440} days`) : m % 60 === 0 && m > 60 ? `every ${m / 60} h` : `every ${m} min`);

function stateBadge(s) {
  if (s.failures_in_a_row > 0) return `<span class="badge err">Failing (${s.failures_in_a_row} in a row)</span>`;
  if (s.overdue) return `<span class="badge warn">Overdue</span>`;
  if (!s.last_success_at) return `<span class="badge warn">Not loaded yet</span>`;
  return `<span class="badge ok">OK</span>`;
}

const RUN_STATE = { ok: "updated", unchanged: "no change", error: "failed, kept last good", fixture: "failed, sample shown", never: "not loaded", deferred: "deferred" };
const secs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

function renderRuns(runs, names) {
  const body = document.getElementById("runs");
  if (!runs.length) {
    body.innerHTML = `<tr><td colspan="4" class="muted">No runs recorded yet.</td></tr>`;
    return;
  }
  body.innerHTML = runs.map((run) => {
    const items = Object.entries(run.sources ?? {});
    const checked = items.filter(([, x]) => x.state !== "deferred");
    const deferred = items.length - checked.length;
    const list = checked.map(([id, x]) => {
      const bad = x.state === "error" || x.state === "fixture";
      return `<li><span class="badge ${bad ? "err" : "ok"}">${esc(RUN_STATE[x.state] ?? x.state)}</span> ${esc(names.get(id) ?? id)}${x.feature_count != null ? ` <span class="muted">· ${esc(x.feature_count)} items</span>` : ""}${x.error ? `<br><span class="muted">${esc(x.error)}</span>` : ""}</li>`;
    }).join("");
    return `<tr>
      <th scope="row">${time(run.finished_at)}</th>
      <td data-label="Took">${esc(secs(run.duration_ms ?? 0))}</td>
      <td data-label="Requests">${esc(run.requests ?? 0)}</td>
      <td data-label="Sources checked">${checked.length ? `<ul class="run-list">${list}</ul>` : `<span class="muted">none due</span>`}${deferred ? `<span class="muted">${deferred} deferred to the next run</span>` : ""}</td>
    </tr>`;
  }).join("");
}

// The tables stack into cards on narrow screens (CSS display changes), which
// makes some browsers drop table semantics; explicit roles keep them.
function keepTableRoles() {
  for (const t of document.querySelectorAll(".stack-table")) {
    for (const g of t.querySelectorAll("thead, tbody")) g.setAttribute("role", "rowgroup");
    for (const tr of t.querySelectorAll("tr")) tr.setAttribute("role", "row");
    for (const th of t.querySelectorAll("thead th")) th.setAttribute("role", "columnheader");
    for (const th of t.querySelectorAll("tbody th")) th.setAttribute("role", "rowheader");
    for (const td of t.querySelectorAll("td")) td.setAttribute("role", "cell");
  }
}

async function load() {
  const summary = document.getElementById("summary");
  try {
    const res = await apiFetch("/api/status");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = await res.json();
    const allOk = r.healthy === r.total;
    // A saved copy (offline) is never shown silently: say so, with its time.
    const saved = res.headers.get("x-pw-saved-at");
    const savedNote = saved ? `<span class="badge warn">Saved copy</span> Offline. Showing the status saved on this device ${time(saved)}. ` : "";
    summary.innerHTML = savedNote + `<span class="badge ${allOk ? "ok" : "warn"}">${esc(r.healthy)} of ${esc(r.total)} healthy</span> Last scheduled run ${time(r.last_cron_run)}. <span class="muted">Page updated ${time(r.generated_at)}.</span>`;
    // data-label names each cell for the stacked layout on narrow screens.
    document.getElementById("rows").innerHTML = r.sources
      .map(
        (s) => `<tr>
          <th scope="row">${esc(s.name)}<span class="muted src-meta">${esc(s.agency)} · checked ${esc(every(s.refresh_minutes))}</span></th>
          <td data-label="State">${stateBadge(s)}</td>
          <td data-label="Last success">${time(s.last_success_at)}${s.last_change_at ? `<span class="muted cell-sub">changed ${time(s.last_change_at)}</span>` : ""}</td>
          <td data-label="Last attempt">${time(s.last_attempt_at)}</td>
          <td data-label="Items" class="num">${esc(s.feature_count ?? "–")}</td>
          <td data-label="Last error">${s.last_error ? `${time(s.last_error_at)}<span class="muted cell-sub">${esc(s.last_error)}</span>` : `<span class="muted">None</span>`}</td>
        </tr>`,
      )
      .join("");
    document.querySelector(".status-wrap")?.removeAttribute("aria-busy");
    renderRuns(r.runs ?? [], new Map(r.sources.map((s) => [s.id, s.name])));
    keepTableRoles();
  } catch (e) {
    summary.innerHTML = `<span class="badge err">Could not load</span> Status could not load (${esc(e.message)}). This page tries again every minute.`;
    document.querySelector(".status-wrap")?.removeAttribute("aria-busy");
  }
}
load();
setInterval(load, 60_000);
