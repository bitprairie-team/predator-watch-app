// Rancher assistant panel (private rancher plan): text chat over Server-Sent
// Events and a voice session that talks to the realtime voice service with a
// short-lived credential. Tool calls made during voice run on our server, so
// they get the same tenant checks, location tiers, and audit log as text.
// Voice transcripts go through the same scope policy as text: each question is
// checked by /api/assistant/voice/guard before tools run, and each spoken
// answer's transcript is checked after.
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const safeUrl = (u) => (/^https:\/\//i.test(String(u ?? "")) ? String(u) : null);
const KEY_STORE = "pw-rancher-key";

const panel = $("#rancher");
const openBtn = $("#rancher-open");
const log = $("#rancher-log");
let history = [];

function key() { return sessionStorage.getItem(KEY_STORE); }
function authHeaders(extra = {}) { return { authorization: `Bearer ${key()}`, ...extra }; }

function fmt(iso) {
  if (!iso) return "not published";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? esc(iso) : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function sourcesHtml(citations) {
  if (!citations?.length) return "";
  return `<ol class="sources">${citations
    .map((c) => {
      const url = safeUrl(c.url);
      const title = url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(c.title)}</a>` : esc(c.title);
      return `<li value="${esc(String(c.cite).slice(1))}">[${esc(c.cite)}] ${title}, ${esc(c.publisher)}. Observed ${fmt(c.observed_at)}; received ${fmt(c.received_at)}.</li>`;
    })
    .join("")}</ol>`;
}

function addMsg(cls, html) {
  const li = document.createElement("li");
  li.className = cls;
  li.innerHTML = html;
  log.append(li);
  li.scrollIntoView({ block: "end" });
  return li;
}

function show(open) {
  panel.hidden = !open;
  openBtn.setAttribute("aria-expanded", String(open));
  if (open) refresh();
}
openBtn.addEventListener("click", () => show(panel.hidden));
$("#rancher-close").addEventListener("click", () => show(false));

async function refresh() {
  const signin = $("#rancher-signin"), app = $("#rancher-app"), msg = $("#rancher-signin-msg");
  if (!key()) { signin.hidden = false; app.hidden = true; return; }
  const r = await fetch("/api/assistant/me", { headers: authHeaders() });
  if (r.status === 503) { msg.textContent = "The rancher plan is not set up on this server yet."; signin.hidden = false; app.hidden = true; return; }
  if (r.status === 401) { sessionStorage.removeItem(KEY_STORE); msg.textContent = "That key didn't work."; signin.hidden = false; app.hidden = true; return; }
  const me = await r.json();
  if (!me.entitled) { msg.textContent = "This account is not on the rancher plan, or billing is not active."; signin.hidden = false; app.hidden = true; return; }
  signin.hidden = true; app.hidden = false;
  const ranches = me.ranches.map((x) => x.name).join(", ") || "no ranch on file yet";
  $("#rancher-who").textContent = `${me.tenant.name ?? "Your account"}: ${ranches}.${me.chat_available ? "" : " Chat is not set up on this server yet."}`;
  $("#rancher-mic").disabled = !me.voice_available;
  if (me.disclaimer) $("#rancher-disclaimer").textContent = `${me.disclaimer} It won't help locate individual animals or dens, or identify other ranchers. In an emergency, call 911 or the agency contact on file.`;
  if (me.mock) $("#rancher-who").textContent += " Offline demo mode: answers come from a local test model.";
}

$("#rancher-key-form").addEventListener("submit", (e) => {
  e.preventDefault();
  sessionStorage.setItem(KEY_STORE, $("#rancher-key").value.trim());
  $("#rancher-key").value = "";
  refresh();
});
$("#rancher-signout").addEventListener("click", () => { stopVoice(); sessionStorage.removeItem(KEY_STORE); history = []; log.innerHTML = ""; refresh(); });

// ---------------------------------------------------------------- text chat
$("#rancher-chat").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#rancher-q").value.trim();
  if (!q) return;
  $("#rancher-q").value = "";
  addMsg("me", esc(q));
  history.push({ role: "user", content: q });
  const bot = addMsg("bot", "Checking the data…");
  try {
    const res = await fetch("/api/assistant/chat", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ messages: history.slice(-12) }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      bot.className = "err";
      bot.textContent = err.message ?? `Request failed (${res.status}).`;
      return;
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "", text = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = block.match(/^event: (.+)$/m)?.[1];
        const data = JSON.parse(block.match(/^data: (.+)$/m)?.[1] ?? "null");
        if (ev === "tool_call") addMsg("tool", `Looking up: ${esc(data.name.replace(/_/g, " "))}`);
        else if (ev === "delta") { text += data.text; bot.textContent = text; }
        else if (ev === "citations") bot.insertAdjacentHTML("beforeend", sourcesHtml(data.citations));
        else if (ev === "guard") bot.classList.add("declined");
        else if (ev === "done") {
          if (data.refused) {
            // Keep declined topics out of the running conversation.
            bot.classList.add("declined");
            history.pop();
          } else history.push({ role: "assistant", content: data.text });
        }
        else if (ev === "error") { bot.className = "err"; bot.textContent = data.message; }
      }
    }
  } catch {
    bot.className = "err";
    bot.textContent = "Connection lost. Try again.";
  }
});

// ---------------------------------------------------------------- voice
let voice = null;

function b64FromPcm16(float32) {
  const buf = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function playPcm16(ctx, b64, state) {
  const bin = atob(b64);
  const n = bin.length / 2;
  const audio = ctx.createBuffer(1, n, 24000);
  const ch = audio.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
    ch[i] = (v >= 0x8000 ? v - 0x10000 : v) / 0x8000;
  }
  const src = ctx.createBufferSource();
  src.buffer = audio;
  src.connect(ctx.destination);
  state.playAt = Math.max(state.playAt, ctx.currentTime);
  src.start(state.playAt);
  state.playAt += audio.duration;
  state.sources.push(src);
}

async function guard(stage, text) {
  try {
    const r = await fetch("/api/assistant/voice/guard", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ stage, text }),
    });
    // Fail closed: if the check can't run, treat the turn as declined.
    if (!r.ok) return { action: "decline", say: (await r.json().catch(() => ({}))).message ?? "I can't answer that right now." };
    return await r.json();
  } catch {
    return { action: "decline", say: "I can't answer that right now." };
  }
}

function stopPlayback(state) {
  state.sources.forEach((x) => { try { x.stop(); } catch {} });
  state.sources = []; state.playAt = 0;
}

async function runVoiceTool(state, ev) {
  let output;
  // Wait for the policy check on this turn's question before running any tool.
  const verdict = await (state.inputGuard ?? Promise.resolve({ action: "allow" }));
  if (verdict.action !== "allow") {
    if (state.ws.readyState === 1)
      state.ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: ev.call_id, output: JSON.stringify({ error: "policy_declined", message: verdict.say }) } }));
    return;
  }
  try {
    const t = await fetch(`/api/assistant/tools/${encodeURIComponent(ev.name)}`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ arguments: JSON.parse(ev.arguments || "{}") }),
    });
    const body = await t.json();
    // Number sources across the whole spoken turn so markers stay unique.
    const cites = t.ok ? body.citations.map((c, i) => ({ ...c, cite: `S${state.citations.length + i + 1}` })) : [];
    state.citations.push(...cites);
    output = t.ok ? { data: body.data, unknown: body.unknown, planned: body.planned, sources: cites } : { error: body.error, message: body.message };
  } catch {
    output = { error: "unavailable", message: "The tool could not be reached." };
  }
  if (state.ws.readyState === 1)
    state.ws.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: ev.call_id, output: JSON.stringify(output) } }));
}

async function startVoice() {
  const status = $("#rancher-voice-status");
  status.textContent = "Starting voice…";
  const r = await fetch("/api/assistant/voice/session", { method: "POST", headers: authHeaders() });
  if (!r.ok) { status.textContent = (await r.json().catch(() => ({}))).message ?? "Voice is not available."; return; }
  const s = await r.json();
  if (s.mock) {
    // The offline mock mints a fake credential; there is no live audio service to connect to.
    status.textContent = "Voice session setup works in offline demo mode, but live audio needs the realtime service. Use text chat to try the assistant.";
    return;
  }
  const ctx = new AudioContext({ sampleRate: 24000 });
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const ws = new WebSocket(s.url, s.protocols);
  const state = { ws, ctx, mic, playAt: 0, sources: [], pending: [], transcript: null, citations: [], inputGuard: null, declined: false };
  voice = state;
  $("#rancher-mic").setAttribute("aria-pressed", "true");
  $("#rancher-mic").textContent = "Stop";

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "session.update", session: s.session }));
    const input = ctx.createMediaStreamSource(mic);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (ev) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64FromPcm16(ev.inputBuffer.getChannelData(0)) }));
    };
    input.connect(proc);
    proc.connect(ctx.destination);
    state.proc = proc;
    status.textContent = "Listening. Ask your question.";
  };
  ws.onmessage = async (m) => {
    const ev = JSON.parse(m.data);
    switch (ev.type) {
      case "input_audio_buffer.speech_started":
        // Barge-in: stop playback when the rancher starts talking.
        state.sources.forEach((x) => { try { x.stop(); } catch {} });
        state.sources = []; state.playAt = 0;
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (ev.transcript) {
          addMsg("me", esc(ev.transcript));
          state.declined = false;
          state.inputGuard = guard("input", ev.transcript);
          const verdict = await state.inputGuard;
          if (verdict.action !== "allow") {
            // Stop whatever the model started, show the decline, and have it say only the decline.
            state.declined = true;
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: "response.cancel" }));
            stopPlayback(state);
            state.transcript?.remove();
            state.transcript = null;
            state.citations = [];
            addMsg("bot declined", esc(verdict.say));
            if (ws.readyState === 1)
              ws.send(JSON.stringify({ type: "response.create", response: { instructions: `Say only this, word for word, then stop: ${verdict.say}`, tool_choice: "none" } }));
          }
        }
        break;
      case "response.output_audio.delta":
        playPcm16(ctx, ev.delta, state);
        break;
      case "response.output_audio_transcript.delta":
        if (state.declined) break; // the decline is already on screen
        state.transcript ??= addMsg("bot", "");
        state.transcript.textContent += ev.delta;
        break;
      case "response.output_audio_transcript.done":
        if (ev.transcript && !state.declined) {
          const verdict = await guard("output", ev.transcript);
          if (verdict.action === "block") {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: "response.cancel" }));
            stopPlayback(state);
          }
          if ((verdict.action === "block" || verdict.action === "redact") && state.transcript) state.transcript.textContent = verdict.text;
        }
        break;
      case "response.function_call_arguments.done":
        addMsg("tool", `Looking up: ${esc(ev.name.replace(/_/g, " "))}`);
        state.pending.push(runVoiceTool(state, ev));
        break;
      case "response.done":
        if (state.pending.length > 0) {
          // Wait for every function result from this turn, then ask for the spoken answer.
          const p = state.pending;
          state.pending = [];
          await Promise.all(p);
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: "response.create" }));
        } else if (state.declined) {
          state.transcript = null;
          state.citations = [];
        } else if (state.transcript) {
          // Sources are always shown on screen for spoken answers.
          if (state.citations.length) state.transcript.insertAdjacentHTML("beforeend", sourcesHtml(state.citations));
          else state.transcript.insertAdjacentHTML("beforeend", `<p class="sources">No sources were used for this reply.</p>`);
          state.transcript = null;
          state.citations = [];
        }
        break;
      case "error":
        status.textContent = ev.error?.message ?? "Voice error.";
        break;
    }
  };
  ws.onclose = () => { if (voice === state) stopVoice(); };
}

function stopVoice() {
  if (!voice) return;
  const v = voice;
  voice = null;
  try { v.proc?.disconnect(); } catch {}
  v.mic?.getTracks().forEach((t) => t.stop());
  try { v.ws.close(); } catch {}
  v.ctx?.close();
  $("#rancher-mic").setAttribute("aria-pressed", "false");
  $("#rancher-mic").textContent = "Talk";
  $("#rancher-voice-status").textContent = "";
}

$("#rancher-mic").addEventListener("click", () => {
  if (voice) stopVoice();
  else startVoice().catch((e) => { $("#rancher-voice-status").textContent = `Voice could not start: ${e.message}`; stopVoice(); });
});
