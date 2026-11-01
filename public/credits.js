// /about: the full source list with credits, links and agency update times,
// from /api/layers (credits are defined once, in src/config/sources.ts).
import { swatchHtml } from "/layer-style.js";
import { apiFetch } from "/net.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const safeUrl = (u) => (/^https:\/\//i.test(String(u ?? "")) ? String(u) : null);
const when = (iso) => (iso ? new Date(iso).toLocaleDateString([], { dateStyle: "medium" }) : null);
const GROUPS = { "wolf-activity": "Wolf activity", "wolf-management": "Wolf management areas", bear: "Bears", context: "Context" };

async function load() {
  const tbody = document.getElementById("sources-rows");
  if (!tbody) return;
  try {
    const res = await apiFetch("/api/layers");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // A saved copy (offline) is never shown silently.
    const saved = res.headers.get("x-pw-saved-at");
    const note = document.getElementById("sources-saved");
    if (note) note.textContent = saved ? `Offline. This list is the copy saved on this device ${new Date(saved).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}; agency dates may have changed since.` : "";
    const { layers } = await res.json();
    const rows = [];
    for (const [cat, title] of Object.entries(GROUPS)) {
      const list = layers.filter((l) => l.category === cat);
      if (!list.length) continue;
      rows.push(`<tr class="group"><th scope="rowgroup" colspan="3">${esc(title)}</th></tr>`);
      for (const l of list) {
        const u = safeUrl(l.info_url);
        const updated = l.type === "raster" ? "Live map service" : when(l.status?.source_updated_at) ?? "Not published";
        rows.push(`<tr>
          <th scope="row"><span class="src-name">${swatchHtml(l)}${esc(l.name)}</span><span class="muted">${esc(l.credit_short)}</span></th>
          <td data-label="Credit">${esc(l.attribution)}${l.license ? `<br><span class="muted">${esc(l.license)}</span>` : ""}${u ? `<br><a href="${esc(u)}" rel="noopener">Source page<span class="sr-only"> for ${esc(l.name)}</span></a>` : ""}</td>
          <td data-label="Agency updated">${esc(updated)}</td>
        </tr>`);
      }
    }
    tbody.innerHTML = rows.join("");
    keepTableRoles(tbody.closest("table"));
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="3" class="muted">The source list could not load (${esc(e.message)}). The <a href="https://github.com/steelhead99x/predator-watch-app/blob/main/docs/data-sources.md">data sources list</a> has the same credits.</td></tr>`;
  }
}
// The table stacks into cards on phones (CSS display changes), which makes
// some browsers drop table semantics; explicit roles keep them.
function keepTableRoles(t) {
  if (!t) return;
  for (const g of t.querySelectorAll("thead, tbody")) g.setAttribute("role", "rowgroup");
  for (const tr of t.querySelectorAll("tr")) tr.setAttribute("role", "row");
  for (const th of t.querySelectorAll("thead th")) th.setAttribute("role", "columnheader");
  for (const th of t.querySelectorAll("tbody th")) th.setAttribute("role", "rowheader");
  for (const td of t.querySelectorAll("td")) td.setAttribute("role", "cell");
}
load();
