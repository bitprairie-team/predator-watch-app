// Display preferences, set before first paint on every page (CSP-safe, no
// inline script): Simple or Expert view, text size and high contrast.
// Saved in this browser only. Simple view is the default for a first visit;
// a link with #...&mode=expert opens Expert view without changing the saved
// choice. High contrast follows the device's "more contrast" setting until
// the visitor picks it on or off here.
(function () {
  var root = document.documentElement;
  var KEYS = { mode: "pw-mode", text: "pw-text", textScale: "pw-text-v", contrast: "pw-contrast" };
  function get(k) { try { return localStorage.getItem(KEYS[k]); } catch (e) { return null; } }
  function put(k, v) { try { if (v === null) localStorage.removeItem(KEYS[k]); else localStorage.setItem(KEYS[k], v); } catch (e) { /* private mode */ } }
  var moreContrast = window.matchMedia ? window.matchMedia("(prefers-contrast: more)") : null;
  // Map page, first visit: show the welcome hint with the first paint rather
  // than after the map library loads (app.js wires its "Got it" button).
  try { if (localStorage.getItem("pw-hint-dismissed") !== "1" && !/(?:^#|&)map=/.test(location.hash || "")) root.setAttribute("data-first-visit", ""); } catch (e) { /* private mode */ }

  function hashMode() {
    var m = /(?:^#|&)mode=(simple|expert)(?:&|$)/.exec(location.hash || "");
    return m ? m[1] : null;
  }
  function mode() { var h = hashMode(); if (h) return h; var s = get("mode"); return s === "expert" ? "expert" : "simple"; }
  // Text size, four steps: 0 small (the default), 1 medium (the size that
  // used to be the default), 2 large, 3 largest. Saves from before the
  // four-step scale (no pw-text-v) used 1 for the old default "A": that maps
  // to the new default; 2 and 3 keep the same size.
  if (get("textScale") !== "2") {
    if (get("text") === "1") put("text", null);
    put("textScale", "2");
  }
  function text() { var t = get("text"); return t === "1" || t === "2" || t === "3" ? t : "0"; }
  function contrast() {
    var c = get("contrast");
    if (c === "high" || c === "normal") return c;
    return moreContrast && moreContrast.matches ? "high" : "normal";
  }
  function apply() {
    root.setAttribute("data-mode", mode());
    root.setAttribute("data-text", text());
    root.setAttribute("data-contrast", contrast());
    sync();
  }

  var TEXT_LABELS = { "0": ["S", "Default"], "1": ["M", "Medium text"], "2": ["L", "Large text"], "3": ["XL", "Largest text"] };
  function controlsHtml(withMode) {
    var h = "";
    if (withMode) {
      h += '<div class="pref-row view-switch" role="group" aria-labelledby="pref-view-label">' +
        '<span class="pref-label" id="pref-view-label">View</span>' +
        '<button type="button" class="pref-btn" data-set-mode="simple" aria-pressed="false">Simple</button>' +
        '<button type="button" class="pref-btn" data-set-mode="expert" aria-pressed="false">Expert</button></div>';
    }
    h += '<div class="pref-row" role="group" aria-labelledby="pref-text-label"><span class="pref-label" id="pref-text-label">Text size</span>';
    for (var k in TEXT_LABELS) {
      h += '<button type="button" class="pref-btn pref-text pref-text-' + k + '" data-set-text="' + k + '" aria-pressed="false" aria-label="' + TEXT_LABELS[k][1] + '" title="' + TEXT_LABELS[k][1] + '">' + TEXT_LABELS[k][0] + "</button>";
    }
    h += '<button type="button" class="pref-btn pref-contrast" data-toggle-contrast aria-pressed="false">High contrast</button></div>';
    return h;
  }
  function sync() {
    var m = root.getAttribute("data-mode"), t = root.getAttribute("data-text"), c = root.getAttribute("data-contrast");
    var all = document.querySelectorAll("[data-set-mode],[data-set-text],[data-toggle-contrast]");
    for (var i = 0; i < all.length; i++) {
      var b = all[i];
      var on = b.hasAttribute("data-set-mode") ? b.getAttribute("data-set-mode") === m
        : b.hasAttribute("data-set-text") ? b.getAttribute("data-set-text") === t : c === "high";
      b.setAttribute("aria-pressed", String(on));
    }
  }
  function mount() {
    var spots = document.querySelectorAll("[data-display-controls]");
    for (var i = 0; i < spots.length; i++) {
      if (spots[i].childElementCount) continue;
      spots[i].innerHTML = controlsHtml(spots[i].hasAttribute("data-with-mode"));
    }
    sync();
  }
  function emit(name) {
    var ev; try { ev = new CustomEvent("pw:prefs", { detail: { changed: name } }); } catch (e) { ev = document.createEvent("CustomEvent"); ev.initCustomEvent("pw:prefs", false, false, { changed: name }); }
    document.dispatchEvent(ev);
  }
  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("[data-set-mode],[data-set-text],[data-toggle-contrast]") : null;
    if (!b) return;
    if (b.hasAttribute("data-set-mode")) {
      put("mode", b.getAttribute("data-set-mode"));
      // A shared link's mode=... gives way to the visitor's own choice.
      if (hashMode()) history.replaceState(null, "", location.hash.replace(/&?mode=(simple|expert)/, "") || location.pathname);
      apply(); emit("mode");
    } else if (b.hasAttribute("data-set-text")) {
      var t = b.getAttribute("data-set-text");
      put("text", t === "0" ? null : t); put("textScale", "2"); apply(); emit("text");
    } else {
      put("contrast", contrast() === "high" ? "normal" : "high"); apply(); emit("contrast");
    }
  });
  window.addEventListener("hashchange", function () { var before = root.getAttribute("data-mode"); apply(); if (root.getAttribute("data-mode") !== before) emit("mode"); });
  window.addEventListener("storage", function (e) { if (e.key && e.key.indexOf("pw-") === 0) { apply(); emit("storage"); } });
  if (moreContrast && moreContrast.addEventListener) moreContrast.addEventListener("change", function () { apply(); emit("contrast"); });
  apply();
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
  window.pwPrefs = { mode: mode, text: text, contrast: contrast, mount: mount, textLabels: TEXT_LABELS };
})();
