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
          <td>${esc(s.feature_count ?? "–")}</td>
          <td>${s.last_error ? `${esc(when(s.last_error_at))}<br><span class="muted">${esc(s.last_error)}</span>` : "none"}</td>
        </tr>`,
      )
      .join("");
  } catch (e) {
    summary.textContent = `Status could not load (${e.message}). Try again in a minute.`;
  }
}
load();
setInterval(load, 60_000);
