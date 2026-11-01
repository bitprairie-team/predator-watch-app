// Light or dark theme, from bitprairie.com's theme.js (same "bp-theme" key and
// data-theme attribute). One change for the map: with no saved choice it
// follows the device setting instead of always starting light.
// Loaded in <head> before the stylesheet, so the theme is set before first paint (CSP-safe: no inline script).
(function(){
  var KEY = "bp-theme", root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function saved(){ var t = null; try { t = localStorage.getItem(KEY); } catch (e) {} return t === "dark" || t === "light" ? t : null; }
  function read(){ return saved() || (mq && mq.matches ? "dark" : "light"); }
  function meta(theme){
    var m = document.querySelector('meta[name="theme-color"]'); if (!m) return;
    if (!m.hasAttribute("data-light")) m.setAttribute("data-light", m.getAttribute("content") || "");
    m.setAttribute("content", theme === "dark" ? (m.getAttribute("data-dark") || "#161310") : m.getAttribute("data-light"));
  }
  // Toggle buttons are named "Dark mode"; aria-pressed and the tooltip say whether it is on.
  function sync(theme){
    var btns = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < btns.length; i++) { btns[i].setAttribute("aria-pressed", String(theme === "dark")); btns[i].title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode"; }
  }
  function paint(theme){ root.setAttribute("data-theme", theme); meta(theme); sync(theme); }
  paint(read());
  document.addEventListener("DOMContentLoaded", function(){ paint(read()); });
  window.addEventListener("pageshow", function(e){ if (e.persisted) paint(read()); });
  // Pages without the map (about, status) also get the toggle and live updates.
  document.addEventListener("click", function(e){
    var btn = e.target && e.target.closest ? e.target.closest("[data-theme-toggle]") : null;
    if (!btn) return;
    var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    try { localStorage.setItem(KEY, next); } catch (err) {}
    paint(next);
  });
  window.addEventListener("storage", function(e){ if (e.key === KEY) paint(read()); });
  if (mq && mq.addEventListener) mq.addEventListener("change", function(){ if (!saved()) paint(read()); });
  window.pwTheme = { read: read, saved: saved, paint: paint, KEY: KEY };
})();
