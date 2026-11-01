// Renders /api/status as a table.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "never");

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
      <th scope="row">${esc(when(run.finished_at))}</th>
      <td>${esc(secs(run.duration_ms ?? 0))}</td>
      <td>${esc(run.requests ?? 0)}</td>
      <td>${checked.length ? `<ul class="run-list">${list}</ul>` : `<span class="muted">none due</span>`}${deferred ? `<span class="muted">${deferred} deferred to the next run</span>` : ""}</td>
    </tr>`;
  }).join("");
}

async function load() {
  const summary = document.getElementById("summary");
  try {
    const res = await fetch("/api/status");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = await res.json();
    summary.textContent = `${r.healthy} of ${r.total} sources healthy. Last scheduled run: ${when(r.last_cron_run)}. Generated ${when(r.generated_at)}.`;
    document.getElementById("rows").innerHTML = r.sources
      .map(
        (s) => `<tr>
          <th scope="row">${esc(s.name)}<br><span class="muted">${esc(s.agency)} · checked ${esc(every(s.refresh_minutes))}</span></th>
          <td>${stateBadge(s)}</td>
          <td>${esc(when(s.last_success_at))}${s.last_change_at ? `<br><span class="muted">changed ${esc(when(s.last_change_at))}</span>` : ""}</td>
          <td>${esc(when(s.last_attempt_at))}</td>
          <td>${esc(s.feature_count ?? "–")}</td>
          <td>${s.last_error ? `${esc(when(s.last_error_at))}<br><span class="muted">${esc(s.last_error)}</span>` : "none"}</td>
        </tr>`,
      )
      .join("");
    renderRuns(r.runs ?? [], new Map(r.sources.map((s) => [s.id, s.name])));
  } catch (e) {
    summary.textContent = `Status could not load (${e.message}). Try again in a minute.`;
  }
}
load();
setInterval(load, 60_000);
