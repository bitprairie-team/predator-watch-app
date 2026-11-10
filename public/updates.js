// Official updates page: reads /api/updates and renders the agency titles
// and counts exactly as cached. No numbers are added here.
(function () {
  const factsEl = document.getElementById("updates-facts");
  const listEl = document.getElementById("updates-list");
  const checkedEl = document.getElementById("updates-checked");
  if (!listEl) return;

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function fmtDate(iso) {
    if (!iso) return "";
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return esc(iso);
    const months = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const d = Number(m[3]);
    const label = d === 1 && String(iso).length <= 10 ? `${months[Number(m[2]) - 1]} ${m[1]}` : `${months[Number(m[2]) - 1]} ${d}, ${m[1]}`;
    return label;
  }

  function render(data) {
    if (checkedEl) {
      const when = data.checked_at ? fmtDate(data.checked_at.slice(0, 10)) : "not yet";
      checkedEl.textContent = `Last checked ${when}. Each item is as reported by the agency named on the line.`;
    }
    if (factsEl) {
      const facts = data.facts || [];
      factsEl.innerHTML = facts.length
        ? facts.map((f) => `<li><strong>${esc(f.value)}</strong> (${esc(f.label)}), ${esc(f.attribution)}. <a href="${esc(f.url)}">Source</a></li>`).join("")
        : `<li class="muted">No official counts are cached yet.</li>`;
    }
    const items = data.items || [];
    listEl.innerHTML = items.length
      ? items.map((i) => `<li><time datetime="${esc(i.date)}">${esc(fmtDate(i.date))}</time> <a href="${esc(i.url)}">${esc(i.title)}</a> <span class="muted">as reported by ${esc(i.agency)}</span></li>`).join("")
      : `<li class="muted">No official updates are cached yet.</li>`;
  }

  fetch("/api/updates")
    .then((r) => { if (!r.ok) throw new Error("unavailable"); return r.json(); })
    .then(render)
    .catch(() => {
      if (checkedEl) checkedEl.textContent = "Official updates could not be loaded. Try again later, or open an agency page from Sources.";
      if (factsEl) factsEl.innerHTML = "";
      listEl.innerHTML = `<li class="muted">Unavailable right now.</li>`;
    });
})();
