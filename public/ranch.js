// Ranch tools (private rancher plan). Settings to turn each automated job on
// or off, the activity log with a "what I did" record for every answer and
// run, the outbox, and every agent job done by hand. Nothing here needs the
// assistant: it works with the assistant and every agent turned off.
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const safeUrl = (u) => (/^https:\/\//i.test(String(u ?? "")) ? String(u) : null);
const KEY_STORE = "pw-rancher-key";
const main = $("#main");
let me = null;
let settings = null;

const key = () => sessionStorage.getItem(KEY_STORE);

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message ?? `Request failed (${status}).`);
    this.status = status;
    this.body = body;
  }
}

async function api(path, { method = "GET", body, raw = false } = {}) {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${key()}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) {
    sessionStorage.removeItem(KEY_STORE);
    me = null;
    route();
    throw new ApiError(401, { message: "Sign in again." });
  }
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => ({})));
  return raw ? res : res.json();
}

// Downloads go through fetch so the key stays in a header, then save as a file.
async function download(path, opts) {
  const res = await api(path, { ...opts, raw: true });
  const name = (res.headers.get("content-disposition") || "").match(/filename="([^"]+)"/)?.[1] ?? "download.txt";
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return name;
}

const when = (iso) => {
  if (!iso) return "not published";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? esc(iso) : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : "");

function sourcesHtml(list) {
  if (!list?.length) return `<p class="empty">No sources were used.</p>`;
  return `<ol class="sources">${list
    .map((c) => {
      const url = safeUrl(c.url);
      const title = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(c.title)}</a>` : esc(c.title);
      return `<li>[${esc(c.cite)}] ${title}, ${esc(c.publisher)}. Observed ${when(c.observed_at)}; received ${when(c.received_at)}.</li>`;
    })
    .join("")}</ol>`;
}

function setStatus(el, text, err = false) {
  el.textContent = text;
  el.classList.toggle("err", err);
}

const agentTitle = (id) => settings?.agents.find((a) => a.id === id)?.title ?? id.replace(/_/g, " ");
const who = (actor) => (actor === "you" ? "You" : actor === "assistant" ? "Assistant" : actor?.startsWith("agent:") ? agentTitle(actor.slice(6)) : esc(actor));
const KIND_LABELS = {
  "": "Everything",
  answer: "Answers",
  decline: "Declined questions",
  agent_run: "Agent runs",
  manual: "Jobs you did by hand",
  setting: "Settings changes",
  override: "Your corrections",
  outbox: "Outbox",
};

function areaOptions() {
  return (me?.ranches ?? []).flatMap((r) => [{ id: r.id, name: `${r.name} (ranch and its allotments)` }, ...r.allotments.map((a) => ({ id: a.id, name: `${a.name} (allotment)` }))]);
}

// ------------------------------------------------------------ routing
const NAV = ["activity", "settings", "outbox", "by-hand"];
function route() {
  const [screen = "activity", arg] = location.hash.replace(/^#/, "").split("/");
  document.querySelectorAll("#nav a[data-screen]").forEach((a) => (a.getAttribute("data-screen") === screen ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  if (!key() || !me) return showSignIn();
  $("#nav").hidden = false;
  const s = NAV.includes(screen) ? screen : "activity";
  const run = { activity: arg ? () => showRecord(arg) : showActivity, settings: arg ? () => showAgent(arg) : showSettings, outbox: arg ? () => showOutboxItem(arg) : showOutbox, "by-hand": arg ? () => showJob(arg) : showByHand }[s];
  run().catch((e) => {
    if (e.status === 401) return;
    main.innerHTML = `<h1>Something went wrong</h1><p class="status err">${esc(e.message)}</p>`;
  });
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

async function start() {
  if (!key()) return route();
  try {
    me = await api("/api/ranch/me");
    if (!me.entitled) {
      me = null;
      sessionStorage.removeItem(KEY_STORE);
      return showSignIn("This account is not on the rancher plan, or billing is not active.");
    }
    settings = await api("/api/ranch/settings");
  } catch (e) {
    me = null;
    if (e.status === 503) return showSignIn("The rancher plan is not set up on this server yet.");
    if (e.status !== 401) return showSignIn(e.message);
    return showSignIn("That key didn't work.");
  }
  const ranches = me.ranches.map((r) => r.name).join(", ") || "no ranch on file yet";
  $("#who").textContent = `${me.tenant.name ?? "Your account"}: ${ranches}.${me.mock ? " Offline demo mode." : ""}`;
  route();
}

$("#signout").addEventListener("click", () => {
  sessionStorage.removeItem(KEY_STORE);
  me = null;
  settings = null;
  $("#who").textContent = "";
  location.hash = "";
  showSignIn();
});

function showSignIn(message = "") {
  $("#nav").hidden = true;
  main.innerHTML = `
    <h1>Ranch tools</h1>
    <p class="lede">Your settings, the activity log, and every job the agents do, by hand. Everything automated is off until you turn it on.</p>
    <form id="signin">
      <label for="k">Rancher access key</label>
      <input id="k" type="password" autocomplete="off" spellcheck="false" required>
      <p class="hint">Keys come with the rancher plan. Account sign-in is Planned.</p>
      <div class="actions"><button class="main-action" type="submit">Sign in</button></div>
      <p class="status${message ? " err" : ""}" role="status" aria-live="polite">${esc(message)}</p>
    </form>`;
  $("#signin").addEventListener("submit", (e) => {
    e.preventDefault();
    sessionStorage.setItem(KEY_STORE, $("#k").value.trim());
    start();
  });
}

// ------------------------------------------------------------ activity log
async function showActivity() {
  const kind = new URLSearchParams(location.search).get("kind") ?? sessionStorage.getItem("pw-activity-kind") ?? "";
  const { records } = await api(`/api/ranch/activity?limit=100${kind ? `&kind=${encodeURIComponent(kind)}` : ""}`);
  main.innerHTML = `
    <h1>Activity log</h1>
    <p class="lede">Every answer, agent run, by-hand job, and change, with what was read, which rules applied, and what was left out and why.</p>
    <label for="kind">Show</label>
    <select id="kind">${Object.entries(KIND_LABELS).map(([k, v]) => `<option value="${k}"${k === kind ? " selected" : ""}>${v}</option>`).join("")}</select>
    ${
      records.length
        ? `<ol class="rows">${records
            .map(
              (r) => `<li>
          <div class="row-head"><span class="row-title"><a href="#activity/${esc(r.id)}">${esc(r.title)}</a></span><span class="row-meta">${when(r.at)}</span></div>
          <p class="row-body">${esc(r.outcome)}</p>
          <p class="hint">${who(r.actor)}${r.read.length ? `. Read ${r.read.length} ${r.read.length === 1 ? "source of data" : "sources of data"}` : ""}${r.skipped.length ? `. Left out ${r.skipped.length}` : ""}.</p>
        </li>`,
            )
            .join("")}</ol>`
        : `<p class="note">Nothing here yet. Turn on an agent in <a href="#settings">Settings</a>, or do a job <a href="#by-hand">by hand</a>.</p>`
    }
    <div class="actions"><button class="main-action" id="export">Export activity log</button></div>
    <p class="status" id="st" role="status" aria-live="polite"></p>`;
  $("#kind").addEventListener("change", (e) => {
    sessionStorage.setItem("pw-activity-kind", e.target.value);
    showActivity();
  });
  $("#export").addEventListener("click", async () => {
    try {
      setStatus($("#st"), `Saved ${await download("/api/ranch/export/activity.csv")}.`);
    } catch (e) {
      setStatus($("#st"), e.message, true);
    }
  });
}

const STATUS_WORDS = { shown: "", corrected: "You corrected this.", dismiss: "You dismissed this.", wrong: "You marked this wrong.", snooze: "You snoozed this." };

async function showRecord(id) {
  const { record: r } = await api(`/api/ranch/activity/${encodeURIComponent(id)}`);
  const canEdit = me.can_change_settings && r.ref?.agent && r.items?.length;
  const list = (arr, f) => (arr.length ? `<ul>${arr.map((x) => `<li>${f(x)}</li>`).join("")}</ul>` : `<p class="empty">None.</p>`);
  // Answers, runs, and by-hand jobs always show all four parts, even when empty. Changes you made show only what applies.
  const lookups = ["answer", "decline", "agent_run", "manual"].includes(r.kind);
  const section = (heading, arr, body) => (lookups || arr.length ? `<h3>${heading}</h3>${body()}` : "");
  main.innerHTML = `
    <p><a href="#activity">Activity log</a></p>
    <article class="record">
      <h1>${esc(r.title)}</h1>
      <p class="who">${who(r.actor)}, ${when(r.at)}</p>
      <p class="outcome">${esc(r.outcome)}</p>
      <h2>What I did</h2>
      ${section("Data read", r.read, () => list(r.read, (x) => `${esc(x.title)}${x.detail ? `: ${esc(x.detail)}` : ""}`))}
      ${section("Sources and times", r.sources, () => sourcesHtml(r.sources))}
      ${section(lookups ? "Rules applied" : "Details", r.rules, () => list(r.rules, esc))}
      ${section("Skipped or declined, and why", r.skipped, () => list(r.skipped, (x) => `${esc(x.what)}. ${esc(x.why)}`))}
      ${
        r.items?.length
          ? `<h2>Items</h2>
        <p class="hint">${canEdit ? "Mark an item and later runs will respect it." : me.can_change_settings ? "" : "Your access key can't change items."}</p>
        <ol class="rows" id="items">${r.items.map((it) => itemHtml(it, canEdit)).join("")}</ol>`
          : ""
      }
      ${r.ref?.outbox_id ? `<p><a href="#outbox/${esc(r.ref.outbox_id)}">Open the outbox item</a></p>` : ""}
    </article>
    <p class="status" id="st" role="status" aria-live="polite"></p>`;
  if (!canEdit) return;
  $("#items").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const li = b.closest("li");
    const item = li.getAttribute("data-item");
    const act = b.getAttribute("data-act");
    if (act === "correct" && !li.querySelector("form")) {
      li.insertAdjacentHTML(
        "beforeend",
        `<form class="inline-form"><label class="sr-only" for="n-${item}">Your correction</label><input id="n-${item}" type="text" maxlength="300" required placeholder="What is right"><button class="quiet" type="submit">Save correction</button></form>`,
      );
      const f = li.querySelector("form");
      f.querySelector("input").focus();
      f.addEventListener("submit", (ev) => {
        ev.preventDefault();
        mark(r, item, "correct", { note: f.querySelector("input").value.trim() });
      });
      return;
    }
    if (act !== "correct") mark(r, item, act, act === "snooze" ? { days: 7 } : {});
  });
}

function itemHtml(it, canEdit) {
  const hidden = it.status !== "shown";
  return `<li data-item="${esc(it.id)}">
    <div>${esc(String(it.text).replace(/^- /, ""))}</div>
    ${it.status !== "shown" ? `<p class="item-status">${STATUS_WORDS[it.status] ?? ""}${it.note ? ` Your note: ${esc(it.note)}` : ""}</p>` : ""}
    ${
      canEdit
        ? `<div class="item-actions">${
            hidden
              ? `<button class="quiet" data-act="restore">Show again</button>`
              : `<button class="quiet" data-act="dismiss">Dismiss</button><button class="quiet" data-act="wrong">Mark wrong</button><button class="quiet" data-act="correct">Correct</button><button class="quiet" data-act="snooze">Snooze 7 days</button>`
          }</div>`
        : ""
    }
  </li>`;
}

async function mark(r, itemId, action, extra) {
  try {
    await api(`/api/ranch/items/${encodeURIComponent(r.ref.agent)}/${encodeURIComponent(itemId)}`, { method: "POST", body: { activity_id: r.id, action, ...extra } });
    await showRecord(r.id);
    setStatus($("#st"), action === "restore" ? "It will show again on later runs." : "Saved. Later runs will respect this.");
  } catch (e) {
    setStatus($("#st"), e.message, true);
  }
}

// ------------------------------------------------------------ settings
function stateWords(a) {
  if (a.stopped) return `<span class="state-stopped">Stopped by the account owner</span>`;
  if (!a.on) return `<span class="state-off">Off</span>`;
  if (a.snooze_until) return `<span class="state-off">On, snoozed until ${day(a.snooze_until)}</span>`;
  return `<span class="state-on">On</span>`;
}

async function showSettings() {
  settings = await api("/api/ranch/settings");
  const can = settings.can_change;
  const a = settings.assistant;
  main.innerHTML = `
    <h1>Settings</h1>
    <p class="lede">${esc(settings.off_by_default)}</p>
    ${can ? "" : `<p class="note">Your access key can't change settings. Ask the account owner for a key with settings access.</p>`}
    <ol class="rows">
      <li>
        <div class="row-head">
          <span class="row-title">Assistant</span>
          <label class="switch"><input type="checkbox" data-toggle="assistant"${a.on ? " checked" : ""}${can ? "" : " disabled"}><span>${a.on ? "On" : "Off"}</span></label>
        </div>
        <p class="row-body">Answers typed or spoken questions from your records and published agency layers, with sources. Every lookup it makes also works by hand.</p>
        <p class="hint">${a.stopped ? `<span class="state-stopped">Stopped by the account owner.</span> ` : ""}${a.changed_at ? `Changed ${when(a.changed_at)}.` : "You have not turned it on."}</p>
      </li>
      ${settings.agents
        .map(
          (g) => `<li>
        <div class="row-head">
          <span class="row-title"><a href="#settings/${esc(g.id)}">${esc(g.title)}</a></span>
          <label class="switch"><input type="checkbox" data-toggle="${esc(g.id)}"${g.on ? " checked" : ""}${can ? "" : " disabled"}><span>${g.on ? "On" : "Off"}</span></label>
        </div>
        <p class="row-body">${esc(g.description)}</p>
        <p class="hint">${stateWords(g)}. <a href="#settings/${esc(g.id)}">Change settings</a></p>
      </li>`,
        )
        .join("")}
    </ol>
    <p class="status" id="st" role="status" aria-live="polite"></p>`;
  main.querySelectorAll("input[data-toggle]").forEach((box) =>
    box.addEventListener("change", async () => {
      const id = box.getAttribute("data-toggle");
      box.disabled = true;
      try {
        if (id === "assistant") await api("/api/ranch/settings/assistant", { method: "PUT", body: { on: box.checked } });
        else await api(`/api/ranch/settings/agents/${encodeURIComponent(id)}`, { method: "PUT", body: { on: box.checked } });
        await showSettings();
        setStatus($("#st"), `${id === "assistant" ? "Assistant" : agentTitle(id)} is ${box.checked ? "on" : "off"}. This change is in the activity log.`);
      } catch (e) {
        box.checked = !box.checked;
        box.disabled = false;
        setStatus($("#st"), e.message, true);
      }
    }),
  );
}

const JOB_FOR_AGENT = { morning_digest: "digest", new_report_alert: "alert-check", meeting_prep: "packet" };

function fieldHtml(k, rule, value, prefix = "s") {
  const id = `${prefix}-${k}`;
  const unit = rule.unit ? ` (${rule.unit})` : "";
  switch (k) {
    case "areas": {
      const chosen = new Set(value ?? []);
      return `<fieldset><legend>${esc(rule.label)}</legend>${areaOptions()
        .map((o) => `<label class="check"><input type="checkbox" name="${id}" value="${esc(o.id)}"${chosen.has(o.id) ? " checked" : ""}> ${esc(o.name)}</label>`)
        .join("")}<p class="hint">Leave all unchecked to cover every ranch and allotment.</p></fieldset>`;
    }
    case "deliver_to":
      return `<label for="${id}">${esc(rule.label)}</label>
        <select id="${id}-channel"><option value="">Nobody else</option><option value="email"${value?.channel === "email" ? " selected" : ""}>Email</option><option value="sms"${value?.channel === "sms" ? " selected" : ""}>Text message</option></select>
        <input id="${id}" type="text" maxlength="200" value="${esc(value?.to ?? "")}" placeholder="Email address or phone number">`;
    case "meeting_at": {
      const v = value ? new Date(value) : null;
      const local = v ? new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
      return `<label for="${id}">${esc(rule.label)}</label><input id="${id}" type="datetime-local" value="${local}"><p class="hint">The packet is written the day before.</p>`;
    }
    case "contact_index":
      return `<label for="${id}">${esc(rule.label)}</label><select id="${id}">${(me.contacts.length ? me.contacts : [{ index: 0, name: "No contact on file", organization: "" }])
        .map((c) => `<option value="${c.index}"${Number(value ?? 0) === c.index ? " selected" : ""}>${esc(c.name)}${c.organization ? `, ${esc(c.organization)}` : ""}</option>`)
        .join("")}</select>`;
    case "topics":
      return `<label for="${id}">${esc(rule.label)}</label><textarea id="${id}" rows="4" style="min-height:6rem" maxlength="2000">${esc((value ?? []).join("\n"))}</textarea><p class="hint">One per line. Your words are kept as you wrote them.</p>`;
    default:
      return `<label for="${id}">${esc(rule.label)}${unit}</label><input id="${id}" type="number" min="${rule.min}" max="${rule.max}" step="1" value="${esc(value ?? rule.default ?? "")}"><p class="hint">From ${rule.min} to ${rule.max}. Default ${esc(rule.default)}.</p>`;
  }
}

function readField(k, prefix = "s") {
  const id = `${prefix}-${k}`;
  switch (k) {
    case "areas":
      return [...main.querySelectorAll(`input[name="${id}"]:checked`)].map((x) => x.value);
    case "deliver_to": {
      const ch = $(`#${id}-channel`).value;
      const to = $(`#${id}`).value.trim();
      return ch && to ? { channel: ch, to } : null;
    }
    case "meeting_at": {
      const v = $(`#${id}`).value;
      return v ? new Date(v).toISOString() : null;
    }
    case "contact_index":
      return Number($(`#${id}`).value);
    case "topics": {
      const t = $(`#${id}`).value.split("\n").map((x) => x.trim()).filter(Boolean);
      return t.length ? t : null;
    }
    default: {
      const v = $(`#${id}`).value;
      return v === "" ? null : Number(v);
    }
  }
}

async function showAgent(id) {
  settings = await api("/api/ranch/settings");
  const g = settings.agents.find((a) => a.id === id);
  if (!g) return void (location.hash = "#settings");
  const can = settings.can_change;
  const rules = g.setting_rules;
  main.innerHTML = `
    <p><a href="#settings">Settings</a></p>
    <h1>${esc(g.title)}</h1>
    <p class="lede">${esc(g.description)}</p>
    <p><label class="switch"><input type="checkbox" id="on"${g.on ? " checked" : ""}${can ? "" : " disabled"}><span>${g.on ? "On" : "Off"}</span></label></p>
    <p class="hint">${stateWords(g)}.${g.changed_at ? ` Changed ${when(g.changed_at)}.` : ""}</p>
    <h2>What it reads</h2>
    <ul>${g.reads.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
    <p class="hint">Up to ${g.limits.maxToolCalls} lookups per run and ${g.limits.runsPerDay} runs a day. It never sends anything without your approval.</p>
    <form id="form">
      <h2>Your settings</h2>
      ${Object.entries(rules).map(([k, rule]) => fieldHtml(k, rule, g.settings[k])).join("")}
      <div class="actions">
        <button class="main-action" type="submit"${can ? "" : " disabled"}>Save settings</button>
        ${g.on ? `<button class="quiet" type="button" id="run">Run now</button>` : ""}
        <a href="#by-hand/${JOB_FOR_AGENT[g.id]}">Do this job by hand</a>
      </div>
    </form>
    <h2>Snooze</h2>
    <p>${g.snooze_until ? `Snoozed until ${day(g.snooze_until)}.` : "Skip scheduled runs for a while without turning it off."}</p>
    <div class="inline-form">
      <label class="sr-only" for="sd">Days</label>
      <select id="sd" style="max-width:10rem">${[1, 3, 7, 14, 30].map((d) => `<option value="${d}"${d === 7 ? " selected" : ""}>${d} ${d === 1 ? "day" : "days"}</option>`).join("")}</select>
      <button class="quiet" id="snooze"${can ? "" : " disabled"}>Snooze</button>
      ${g.snooze_until ? `<button class="quiet" id="unsnooze"${can ? "" : " disabled"}>End snooze</button>` : ""}
    </div>
    <p class="status" id="st" role="status" aria-live="polite"></p>`;
  const st = $("#st");
  const after = async (msg) => {
    await showAgent(id);
    setStatus($("#st"), msg);
  };
  $("#on").addEventListener("change", async (e) => {
    try {
      await api(`/api/ranch/settings/agents/${id}`, { method: "PUT", body: { on: e.target.checked } });
      await after(`${g.title} is ${e.target.checked ? "on" : "off"}.`);
    } catch (err) {
      e.target.checked = !e.target.checked;
      setStatus(st, err.message, true);
    }
  });
  $("#form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {};
    for (const k of Object.keys(rules)) body[k] = readField(k);
    try {
      await api(`/api/ranch/settings/agents/${id}`, { method: "PUT", body: { settings: body } });
      await after("Saved. Later runs use these settings.");
    } catch (err) {
      setStatus(st, err.message, true);
    }
  });
  $("#run")?.addEventListener("click", async () => {
    setStatus(st, "Running…");
    try {
      const { run } = await api(`/api/ranch/agents/${id}/run`, { method: "POST", body: {} });
      st.innerHTML = `${esc(run.status === "ok" ? "Done." : run.reason ?? run.status)} ${run.activity_id ? `<a href="#activity/${esc(run.activity_id)}">See what it did</a>` : ""}`;
    } catch (err) {
      setStatus(st, err.message, true);
    }
  });
  $("#snooze").addEventListener("click", async () => {
    try {
      await api(`/api/ranch/settings/agents/${id}/snooze`, { method: "POST", body: { days: Number($("#sd").value) } });
      await after("Snoozed.");
    } catch (err) {
      setStatus(st, err.message, true);
    }
  });
  $("#unsnooze")?.addEventListener("click", async () => {
    try {
      await api(`/api/ranch/settings/agents/${id}/snooze`, { method: "POST", body: { days: 0 } });
      await after("Snooze ended.");
    } catch (err) {
      setStatus(st, err.message, true);
    }
  });
}

// ------------------------------------------------------------ outbox
const OUTBOX_STATUS = { pending_approval: "Waiting for your approval", approved: "Approved", rejected: "Rejected", expired: "Expired" };

async function showOutbox() {
  const { items } = await api("/api/ranch/outbox");
  main.innerHTML = `
    <h1>Outbox</h1>
    <p class="lede">Write-ups an agent or you prepared to send. Nothing goes out without your approval. Sending is Planned: approving records your OK, and nothing is sent yet.</p>
    ${
      items.length
        ? `<ol class="rows">${items
            .map(
              (i) => `<li><div class="row-head"><span class="row-title"><a href="#outbox/${esc(i.id)}">${esc(i.title)}</a></span><span class="row-meta">${when(i.created_at)}</span></div>
        <p class="hint">${OUTBOX_STATUS[i.status] ?? esc(i.status)}. To ${esc(i.delivery.label)}.${i.edits?.length ? " You edited it." : ""}</p></li>`,
            )
            .join("")}</ol>`
        : `<p class="note">Nothing waiting. A meeting packet can be saved here from <a href="#by-hand/packet">By hand</a>.</p>`
    }`;
}

async function showOutboxItem(id) {
  const { items } = await api("/api/ranch/outbox");
  const i = items.find((x) => x.id === id);
  if (!i) return void (location.hash = "#outbox");
  const open = i.status === "pending_approval";
  const ro = open ? "" : " readonly";
  main.innerHTML = `
    <p><a href="#outbox">Outbox</a></p>
    <h1>${open ? "Read, edit, then approve" : esc(OUTBOX_STATUS[i.status])}</h1>
    <p class="hint">From ${esc(agentTitle(i.agent))}, ${when(i.created_at)}. ${open ? `Waits until ${day(i.expires_at)}.` : ""}</p>
    <form id="ob">
      <label for="to">To (${i.delivery.channel === "sms" ? "phone number" : "email address"})</label>
      <input id="to" type="text" maxlength="200" value="${esc(i.delivery.to)}"${ro}>
      <p class="hint">${esc(i.delivery.label)}</p>
      <label for="title">Subject</label>
      <input id="title" type="text" maxlength="200" value="${esc(i.title)}"${ro}>
      <label for="body">Message</label>
      <textarea id="body" maxlength="8000"${ro}>${esc(i.body)}</textarea>
      <h2>Sources and times</h2>
      ${sourcesHtml(i.citations)}
      ${i.original ? `<details class="whatidid"><summary>Show the agent's original text</summary><p><strong>${esc(i.original.title)}</strong></p><p class="writeup">${esc(i.original.body)}</p></details>` : ""}
      ${
        open
          ? `<label class="check"><input type="checkbox" id="confirm"> I read this and it is ready to go when sending is built.</label>
      <div class="actions">
        <button class="main-action" type="submit" id="approve" disabled>Approve</button>
        <button class="quiet" type="button" id="save">Save changes</button>
        <button class="quiet danger" type="button" id="reject">Reject</button>
        <button class="quiet" type="button" id="dl">Download as text</button>
      </div>`
          : `<div class="actions"><button class="quiet" type="button" id="dl">Download as text</button></div>`
      }
    </form>
    <p class="status" id="st" role="status" aria-live="polite"></p>`;
  const st = $("#st");
  const dirty = () => $("#to").value.trim() !== i.delivery.to || $("#title").value !== i.title || $("#body").value !== i.body;
  const save = async () => {
    if (!dirty()) return;
    const patch = {};
    if ($("#to").value.trim() !== i.delivery.to) patch.to = $("#to").value.trim();
    if ($("#title").value !== i.title) patch.title = $("#title").value;
    if ($("#body").value !== i.body) patch.body = $("#body").value;
    await api(`/api/ranch/outbox/${id}`, { method: "PATCH", body: patch });
  };
  $("#dl").addEventListener("click", async () => {
    try {
      setStatus(st, `Saved ${await download(`/api/ranch/export/outbox/${id}.txt`)}.`);
    } catch (e) {
      setStatus(st, e.message, true);
    }
  });
  if (!open) return;
  $("#confirm").addEventListener("change", (e) => ($("#approve").disabled = !e.target.checked));
  $("#save").addEventListener("click", async () => {
    try {
      await save();
      await showOutboxItem(id);
      setStatus($("#st"), "Saved. It still waits for your approval.");
    } catch (e) {
      setStatus(st, e.message, true);
    }
  });
  $("#reject").addEventListener("click", async () => {
    try {
      await api(`/api/ranch/outbox/${id}/reject`, { method: "POST", body: {} });
      await showOutboxItem(id);
    } catch (e) {
      setStatus(st, e.message, true);
    }
  });
  $("#ob").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await save();
      await api(`/api/ranch/outbox/${id}/approve`, { method: "POST", body: { confirm: true } });
      await showOutboxItem(id);
      setStatus($("#st"), "Approved. Sending is Planned, so nothing was sent.");
    } catch (err) {
      setStatus(st, err.message, true);
    }
  });
}

// ------------------------------------------------------------ by hand
const ranchSelect = (id) => `<label for="${id}">Ranch</label><select id="${id}">${me.ranches.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("")}</select>`;
const allotSelect = (id) =>
  `<label for="${id}">Allotment</label><select id="${id}">${me.ranches.flatMap((r) => r.allotments.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}, ${esc(r.name)}</option>`)).join("")}</select>`;
const num = (id, label, min, max, value, unit = "") =>
  `<label for="${id}">${label}${unit ? ` (${unit})` : ""}</label><input id="${id}" type="number" min="${min}" max="${max}" step="1" value="${value}"><p class="hint">From ${min} to ${max}.</p>`;
const val = (id) => $(`#${id}`)?.value;
const n = (id) => Number(val(id));
const agentRules = (id) => settings.agents.find((a) => a.id === id)?.setting_rules ?? {};
const agentSettings = (id) => settings.agents.find((a) => a.id === id)?.settings ?? {};

function manual(agent, query = "") {
  return `/api/ranch/manual/${agent}${query}`;
}

const JOBS = [
  {
    id: "digest",
    title: "Today's digest",
    same: "morning_digest",
    intro: "The same write-up the morning digest agent makes: new agency layer items, your own records, and fire and weather alerts, with sources.",
    fields: () => num("days", "Days to cover", 1, 7, agentSettings("morning_digest").days ?? 1, "days") + fieldHtml("areas", agentRules("morning_digest").areas, agentSettings("morning_digest").areas, "j"),
    main: { label: "Build digest", run: () => job("morning_digest", { days: n("days"), areas: readField("areas", "j") }) },
  },
  {
    id: "alert-check",
    title: "Check for new reports",
    same: "new_report_alert",
    intro: "Looks for wolf activity near your ranches, like the new report alert does. Checking by hand does not change what the agent has already told you.",
    fields: () => {
      const s = agentSettings("new_report_alert");
      return num("radius", "Alert distance from each ranch", 1, 50, s.radius_miles ?? 10, "miles") + num("days", "Look back", 1, 14, s.days ?? 3, "days") + fieldHtml("areas", agentRules("new_report_alert").areas, s.areas, "j");
    },
    main: { label: "Check now", run: () => job("new_report_alert", { radius_miles: n("radius"), days: n("days"), areas: readField("areas", "j") }) },
    more: [
      {
        label: "Save alert areas",
        run: async (st) => {
          await api("/api/ranch/settings/agents/new_report_alert", { method: "PUT", body: { settings: { radius_miles: n("radius"), days: n("days"), areas: readField("areas", "j") } } });
          settings = await api("/api/ranch/settings");
          setStatus(st, "Saved. The new report alert uses this distance and these areas when it is on.");
        },
      },
    ],
  },
  {
    id: "nearby",
    title: "Reports near a ranch",
    intro: "Agency layer items, your own records, and shared report cells near one ranch, with distances and when each was observed and received.",
    fields: () => ranchSelect("ranch") + num("radius", "Distance", 1, 100, 25, "miles") + num("days", "Look back", 1, 90, 14, "days"),
    main: { label: "Show nearby reports", run: () => lookup("recent_predator_activity", { ranch_id: val("ranch"), radius_miles: n("radius"), days: n("days"), include_shared: true }) },
    more: [{ label: "Export nearby reports", run: (st) => save(st, `/api/ranch/export/nearby-activity.csv?ranch_id=${encodeURIComponent(val("ranch"))}&radius_miles=${n("radius")}&days=${n("days")}`) }],
  },
  {
    id: "allotment",
    title: "Allotment activity",
    intro: "Wolf activity inside or touching one of your grazing allotments, using the boundary on file.",
    fields: () => allotSelect("allot") + num("days", "Look back", 1, 90, 30, "days"),
    main: { label: "Show allotment activity", run: () => lookup("allotment_wolf_activity", { allotment_id: val("allot"), days: n("days") }) },
    more: [{ label: "Export allotment activity", run: (st) => save(st, `/api/ranch/export/allotment-activity.csv?allotment_id=${encodeURIComponent(val("allot"))}&days=${n("days")}`) }],
  },
  {
    id: "packet",
    title: "Meeting prep packet",
    same: "meeting_prep",
    intro: "A packet for a meeting with an agency contact: recent activity, your own records, how to report, and the topics you want to raise.",
    fields: () => {
      const s = agentSettings("meeting_prep");
      const r = agentRules("meeting_prep");
      return fieldHtml("contact_index", r.contact_index, s.contact_index, "j") + num("days", "Days to cover", 7, 90, s.days ?? 30, "days") + fieldHtml("topics", r.topics, s.topics, "j") + fieldHtml("areas", r.areas, s.areas, "j");
    },
    main: { label: "Build packet", run: () => job("meeting_prep", packetSettings()) },
    more: [
      { label: "Download packet", run: (st) => save(st, manual("meeting_prep", "?format=txt"), { method: "POST", body: { settings: packetSettings() } }) },
      {
        label: "Save to outbox",
        run: async (st) => {
          const r = await api(manual("meeting_prep"), { method: "POST", body: { settings: packetSettings(), save_to_outbox: true } });
          st.innerHTML = r.outbox_id ? `Saved to the outbox. <a href="#outbox/${esc(r.outbox_id)}">Read and edit it</a>` : esc(r.run.reason ?? "Nothing to save.");
        },
      },
    ],
  },
  {
    id: "alerts",
    title: "Fire and weather alerts",
    intro: "Current fire and weather alerts near one ranch, from published agency feeds.",
    fields: () => ranchSelect("ranch") + num("radius", "Distance", 1, 200, 50, "miles"),
    main: { label: "Show alerts", run: () => lookup("fire_weather_alerts", { ranch_id: val("ranch"), radius_miles: n("radius") }) },
  },
  {
    id: "contacts",
    title: "Agency contacts and reporting",
    intro: "The agency contacts and reporting steps on file for your account, with who published them.",
    fields: () => `<label for="topic">Topic</label><select id="topic"><option value="depredation">Livestock loss</option><option value="sighting">Sighting</option><option value="general">General</option></select>`,
    main: { label: "Show contacts", run: () => lookup("agency_contacts_and_reporting", { topic: val("topic") }) },
  },
  {
    id: "freshness",
    title: "Data freshness",
    intro: "When each data layer was last observed and last received, and how exact each kind of location is.",
    fields: () => "",
    main: { label: "Show data freshness", run: () => lookup("data_freshness", {}) },
  },
  {
    id: "guides",
    title: "Nonlethal guides",
    intro: "Published guides on nonlethal ways to protect livestock, from the documents on file.",
    fields: () => `<label for="q">What you want to know</label><input id="q" type="text" maxlength="200" placeholder="For example: fladry">`,
    main: { label: "Find guides", run: () => lookup("nonlethal_deterrents", val("q") ? { query: val("q") } : {}) },
  },
  {
    id: "weekly",
    title: "Weekly summary",
    intro: "Seven days for one ranch: activity nearby, alerts, your records by type, and data gaps.",
    fields: () => ranchSelect("ranch"),
    main: { label: "Show weekly summary", run: () => lookup("weekly_summary", { ranch_id: val("ranch") }) },
  },
  {
    id: "access",
    title: "Access log",
    intro: "Who looked up what in your account, and when: the assistant, agents, and you.",
    fields: () => num("limit", "How many", 1, 100, 20),
    main: { label: "Show access log", run: () => lookup("my_audit_log", { limit: n("limit") }) },
  },
  {
    id: "exports",
    title: "Exports",
    intro: "Download your own records and the activity log as spreadsheets.",
    fields: () => "",
    main: { label: "Export your records", run: (st) => save(st, "/api/ranch/export/records.csv") },
    more: [{ label: "Export activity log", run: (st) => save(st, "/api/ranch/export/activity.csv") }],
  },
];

function packetSettings() {
  return { contact_index: readField("contact_index", "j"), days: n("days"), topics: readField("topics", "j"), areas: readField("areas", "j") };
}

async function save(st, path, opts) {
  setStatus(st, `Saved ${await download(path, opts)}.`);
}

async function showByHand() {
  if (!settings) settings = await api("/api/ranch/settings");
  main.innerHTML = `
    <h1>By hand</h1>
    <p class="lede">Every job the agents and the assistant do, you can do yourself here. None of these need anything turned on.</p>
    <ol class="rows">${JOBS.map(
      (j) => `<li><div class="row-head"><span class="row-title"><a href="#by-hand/${j.id}">${esc(j.title)}</a></span>${j.same ? `<span class="row-meta">Same job as ${esc(agentTitle(j.same).toLowerCase())}</span>` : ""}</div><p class="row-body">${esc(j.intro)}</p></li>`,
    ).join("")}</ol>`;
}

async function showJob(id) {
  if (!settings) settings = await api("/api/ranch/settings");
  const j = JOBS.find((x) => x.id === id);
  if (!j) return void (location.hash = "#by-hand");
  main.innerHTML = `
    <p><a href="#by-hand">By hand</a></p>
    <h1>${esc(j.title)}</h1>
    <p class="lede">${esc(j.intro)}</p>
    <form id="job">
      ${j.fields()}
      <div class="actions">
        <button class="main-action" type="submit">${esc(j.main.label)}</button>
        ${(j.more ?? []).map((m, i) => `<button class="quiet" type="button" data-more="${i}">${esc(m.label)}</button>`).join("")}
      </div>
    </form>
    <p class="status" id="st" role="status" aria-live="polite"></p>
    <div id="out"></div>`;
  const st = $("#st");
  const go = async (fn) => {
    setStatus(st, "Working…");
    $("#out").innerHTML = "";
    try {
      const html = await fn(st);
      if (typeof html === "string") {
        $("#out").innerHTML = html;
        if (st.textContent === "Working…") setStatus(st, "");
      }
    } catch (e) {
      setStatus(st, e.message, true);
    }
  };
  $("#job").addEventListener("submit", (e) => {
    e.preventDefault();
    go(j.main.run);
  });
  main.querySelectorAll("[data-more]").forEach((b) => b.addEventListener("click", () => go(j.more[Number(b.getAttribute("data-more"))].run)));
}

async function job(agent, s) {
  const clean = Object.fromEntries(Object.entries(s).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && !v.length) && !Number.isNaN(v)));
  const { run } = await api(manual(agent), { method: "POST", body: { settings: clean } });
  if (run.status !== "ok") return `<p class="note">${esc(run.reason ?? "Nothing to show.")}</p>${whatLink(run)}`;
  return `<h2>${esc(run.title)}</h2><div class="writeup">${esc(run.body)}</div><h2>Sources and times</h2>${sourcesHtml(run.citations)}${whatLink(run)}`;
}
const whatLink = (run) => (run.activity_id ? `<p><a href="#activity/${esc(run.activity_id)}">What I did</a></p>` : "");

const HEAD = (k) => {
  const w = k.replace(/_/g, " ");
  return w.charAt(0).toUpperCase() + w.slice(1);
};
const SKIP = new Set(["lat", "lon", "center", "geometry", "source", "id", "tenant_id", "key_id", "user_id"]);
function cell(v) {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return esc(v.map((x) => (typeof x === "object" ? JSON.stringify(x) : x)).join(", "));
  if (typeof v === "object") return esc(Object.values(v).filter((x) => typeof x !== "object").join(", "));
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return when(v);
  const u = safeUrl(v);
  return u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(v)}</a>` : esc(v);
}
function table(rows) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => !SKIP.has(k))))].slice(0, 7);
  return `<table><thead><tr>${cols.map((c) => `<th>${esc(HEAD(c))}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${cell(r[c])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
function dataHtml(data) {
  let html = "";
  for (const [k, v] of Object.entries(data ?? {})) {
    if (Array.isArray(v)) {
      html += `<h2>${esc(HEAD(k))}</h2>`;
      if (!v.length) html += `<p class="empty">None.</p>`;
      else if (v.every((x) => typeof x !== "object")) html += `<ul>${v.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
      else html += table(v);
    } else if (v && typeof v === "object") {
      const name = v.name ?? v.label;
      if (name) html += `<p class="who">For ${esc(name)}</p>`;
      else html += `<h2>${esc(HEAD(k))}</h2>${dataHtml(v)}`;
    } else if (v !== null && v !== undefined) html += `<p><strong>${esc(HEAD(k))}:</strong> ${cell(v)}</p>`;
  }
  return html;
}

async function lookup(tool, args) {
  const r = await api(`/api/ranch/data/${tool}`, { method: "POST", body: { arguments: args } });
  return `${r.unknown ? `<p class="note">${esc(r.unknown)}</p>` : ""}${r.planned ? `<p class="note">Planned: ${esc(r.planned)}</p>` : ""}${dataHtml(r.data)}<h2>Sources and times</h2>${sourcesHtml(r.citations)}`;
}

start();
