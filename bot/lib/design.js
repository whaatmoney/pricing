import { escapeHtml } from "./render.js";

// The shared design system for the decision pages and the pricing board:
// tokens, components, icons and the small script behind copy buttons, the
// before-you-send checklist and the section tabs.

export const ICON = {
  copy: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5"/><path d="M10.5 5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5H5"/></svg>',
  check: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>',
  alert: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 5.5v3.5M8 11.5v.01"/><path d="M7.1 2.6L1.7 12a1 1 0 0 0 .9 1.5h10.8a1 1 0 0 0 .9-1.5L8.9 2.6a1 1 0 0 0-1.8 0z"/></svg>',
  chevron: '<svg class="icon chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4"/></svg>',
};

export const copyButton = (text, label, variant = "ghost") => `<button type="button" class="btn ${variant}" data-copy="${escapeHtml(text)}" data-label="${escapeHtml(label)}">${ICON.copy}<span>${escapeHtml(label)}</span></button>`;

// Design tokens: one sans-serif family, a 4-point spacing scale, color only
// where it means state (green done, amber waiting, red problem), depth in
// dark mode from lighter surfaces instead of shadows, and shadows in light
// mode faint enough not to be noticed.
export const STYLE = `
:root {
  --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:20px; --s6:24px; --s8:32px; --s10:40px; --s12:48px;
  --radius:12px; --radius-sm:8px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --bg:#f5f6f8; --surface:#ffffff; --surface-2:#f0f2f5; --surface-3:#e8ebf0;
  --ink:#14171c; --ink-2:#434a57; --ink-3:#6b7280; --line:#e3e6eb; --line-2:#d3d8df;
  --ok:#15803d; --ok-bg:#e9f6ee; --warn:#9a5b00; --warn-bg:#fdf3e0; --alert:#b42318; --alert-bg:#fdecea;
  --focus:#2563eb; --link:#1d4ed8;
  --shadow:0 1px 2px rgba(16,24,40,.04), 0 2px 6px rgba(16,24,40,.04);
  --shadow-hover:0 2px 4px rgba(16,24,40,.06), 0 6px 16px rgba(16,24,40,.06);
  --topbar:rgba(245,246,248,.78);
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg:#0e1014; --surface:#161920; --surface-2:#1c2028; --surface-3:#232833;
  --ink:#eceef2; --ink-2:#b4bac6; --ink-3:#8a92a0; --line:#252a33; --line-2:#313744;
  --ok:#5cc98a; --ok-bg:#15261c; --warn:#e3b05c; --warn-bg:#2a2214; --alert:#f08a80; --alert-bg:#2c1816;
  --focus:#7aa2ff; --link:#9ab8ff; --shadow:none; --shadow-hover:none; --topbar:rgba(14,16,20,.72);
} }
:root[data-theme="dark"] {
  --bg:#0e1014; --surface:#161920; --surface-2:#1c2028; --surface-3:#232833;
  --ink:#eceef2; --ink-2:#b4bac6; --ink-3:#8a92a0; --line:#252a33; --line-2:#313744;
  --ok:#5cc98a; --ok-bg:#15261c; --warn:#e3b05c; --warn-bg:#2a2214; --alert:#f08a80; --alert-bg:#2c1816;
  --focus:#7aa2ff; --link:#9ab8ff; --shadow:none; --shadow-hover:none; --topbar:rgba(14,16,20,.72);
}
* { box-sizing:border-box; }
html { scroll-behavior:smooth; scroll-padding-top:112px; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 var(--font); -webkit-font-smoothing:antialiased; }
main { max-width:880px; margin:0 auto; padding:var(--s8) var(--s4) var(--s12); display:grid; grid-template-columns:minmax(0,1fr); gap:var(--s6); }
main > *, .hero > *, .panel > *, .fold > *, .case > * { min-width:0; }
h1, h2, h3, h4 { margin:0; letter-spacing:-.011em; line-height:1.25; }
h1 { font-size:28px; font-weight:700; letter-spacing:-.02em; }
h2 { font-size:20px; font-weight:650; }
h3 { font-size:15px; font-weight:650; }
h4 { font-size:13px; font-weight:650; color:var(--ink-2); margin-top:var(--s4); }
p { margin:0; }
a { color:var(--link); text-underline-offset:2px; }
code { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12.5px; }
.icon { width:16px; height:16px; flex:none; fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; vertical-align:-3px; }
.eyebrow { font-size:12px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-3); }
.muted { color:var(--ink-3); } .small { font-size:13px; } .strong { font-weight:650; }
.num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }

/* Top bar: stays in reach; the blur keeps text under it readable, the
   gradient fades content as it slides beneath. */
.topbar { position:sticky; top:0; z-index:10; background:var(--topbar); -webkit-backdrop-filter:saturate(1.4) blur(14px); backdrop-filter:saturate(1.4) blur(14px); border-bottom:1px solid var(--line); }
.topbar::after { content:""; position:absolute; left:0; right:0; top:100%; height:var(--s4); background:linear-gradient(var(--bg), transparent); opacity:.6; pointer-events:none; }
.topbar-inner, .tabs { max-width:880px; margin:0 auto; padding:0 var(--s4); }
.topbar-inner { display:flex; align-items:center; justify-content:space-between; gap:var(--s3); padding-top:var(--s3); }
.who { display:flex; gap:var(--s2); align-items:baseline; min-width:0; font-size:14px; color:var(--ink-2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.who .customer { font-weight:650; color:var(--ink); overflow:hidden; text-overflow:ellipsis; }
.sep { color:var(--ink-3); }
.tabs { display:flex; gap:var(--s1); padding-top:var(--s2); padding-bottom:var(--s2); overflow-x:auto; }
.tabs a { white-space:nowrap; font-size:13px; font-weight:550; color:var(--ink-3); text-decoration:none; padding:var(--s1) var(--s3); border-radius:999px; transition:background .15s, color .15s; }
.tabs a:hover { background:var(--surface-2); color:var(--ink); }
.tabs a.active { background:var(--surface-3); color:var(--ink); }

.pill { display:inline-flex; align-items:center; gap:var(--s1); padding:var(--s1) var(--s3); border-radius:999px; font-size:12px; font-weight:650; white-space:nowrap; }
.pill::before { content:""; width:6px; height:6px; border-radius:50%; background:currentColor; }
.pill.ok { color:var(--ok); background:var(--ok-bg); } .pill.warn { color:var(--warn); background:var(--warn-bg); } .pill.alert { color:var(--alert); background:var(--alert-bg); }

.intro { display:grid; gap:var(--s2); }
.subtitle { font-size:16px; color:var(--ink-2); }
.meta { list-style:none; margin:var(--s1) 0 0; padding:0; display:flex; flex-wrap:wrap; gap:var(--s2); }
.meta li { font-size:13px; color:var(--ink-2); background:var(--surface-2); border-radius:999px; padding:2px var(--s3); }
.meta li.late { color:var(--warn); background:var(--warn-bg); font-weight:600; }
.status { font-size:13px; color:var(--ink-2); margin-top:var(--s2); padding-left:var(--s3); border-left:2px solid var(--line-2); }
.status.ok { border-left-color:var(--ok); } .status.warn { border-left-color:var(--warn); } .status.alert { border-left-color:var(--alert); color:var(--alert); }

.hero, .panel { background:var(--surface); border:1px solid var(--line); border-radius:var(--radius); box-shadow:var(--shadow); padding:var(--s6); display:grid; gap:var(--s5); }
.hero { border-top:3px solid var(--warn); } .hero.approved { border-top-color:var(--ok); }
.hero-head { display:flex; align-items:flex-end; justify-content:space-between; gap:var(--s4); }
.hero-head h2 { font-size:24px; margin-top:2px; }
.confidence { display:grid; gap:var(--s2); padding:var(--s3) var(--s4); border-radius:var(--radius-sm); background:var(--surface-2); }
.confidence ul { margin:0; padding-left:var(--s5); display:grid; gap:2px; font-size:13.5px; color:var(--ink-2); }
.confidence .chip { justify-self:start; }
.hint { display:flex; gap:var(--s2); align-items:flex-start; font-size:13px; color:var(--warn); }
.quote-part { display:grid; gap:var(--s4); }
.facts { margin:0; display:grid; gap:var(--s3); }
.facts > div { display:grid; grid-template-columns:120px minmax(0,1fr); gap:var(--s4); }
.facts dt { font-size:12px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-3); padding-top:2px; }
.facts dd { margin:0; min-width:0; overflow-wrap:anywhere; }
.facts .source { display:block; font-size:12.5px; color:var(--ink-3); margin-top:2px; }
.card.facts { background:var(--surface-2); border-radius:var(--radius-sm); padding:var(--s4); margin-top:var(--s3); }

table { border-collapse:collapse; width:100%; font-size:14px; }
th, td { text-align:left; padding:var(--s2) var(--s3); border-bottom:1px solid var(--line); vertical-align:top; }
th { font-size:12px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--ink-3); }
.tiers td { padding-top:var(--s3); padding-bottom:var(--s3); font-size:15px; }
.tiers td.strong { font-weight:700; }
.unit { color:var(--ink-3); font-size:13px; }
.state-inline { display:none; }
.note { display:block; font-size:12px; font-weight:500; color:var(--ink-3); }
.scroll { overflow-x:auto; }
tr.different td, tr.excluded td { color:var(--ink-3); }
tr.alert td { background:var(--alert-bg); }
tr.pick td { font-weight:600; }
.why-not { font-size:12px; color:var(--ink-3); margin-top:2px; }

.chip { display:inline-flex; align-items:center; gap:var(--s1); border-radius:999px; padding:1px var(--s2); font-size:12px; font-weight:600; white-space:nowrap; }
.chip .icon { width:12px; height:12px; vertical-align:0; }
.chip.ok { background:var(--ok-bg); color:var(--ok); } .chip.warn { background:var(--warn-bg); color:var(--warn); } .chip.alert { background:var(--alert-bg); color:var(--alert); } .chip.muted { background:var(--surface-2); color:var(--ink-3); }

/* Buttons: one filled primary action per area; everything else is a ghost. */
.btn { display:inline-flex; align-items:center; gap:var(--s2); font:600 13px/20px var(--font); border-radius:var(--radius-sm); padding:var(--s2) var(--s3); cursor:pointer; border:1px solid transparent; transition:background .15s, border-color .15s, color .15s, box-shadow .15s, transform .08s; white-space:nowrap; }
.btn:active { transform:scale(.97); }
.btn:focus-visible, .tabs a:focus-visible, summary:focus-visible, .check input:focus-visible + .box { outline:2px solid var(--focus); outline-offset:2px; }
.btn.primary { background:var(--ink); color:var(--surface); box-shadow:var(--shadow); }
.btn.primary:hover { box-shadow:var(--shadow-hover); opacity:.92; }
.btn.ghost { background:transparent; color:var(--ink-2); border-color:var(--line-2); }
.btn.ghost:hover { background:var(--surface-2); color:var(--ink); }
.btn.done { background:var(--ok-bg); color:var(--ok); border-color:transparent; }
.btn:disabled { opacity:.45; cursor:not-allowed; }

/* Mise en place: the checks to do before sending, ticked off in place. */
.checklist { border-top:1px solid var(--line); padding-top:var(--s5); display:grid; gap:var(--s2); }
.checklist-head { display:flex; align-items:baseline; justify-content:space-between; gap:var(--s3); margin-bottom:var(--s1); }
.progress { font-size:12px; font-weight:600; color:var(--ink-3); }
.progress.complete { color:var(--ok); }
.check { display:flex; gap:var(--s3); align-items:flex-start; padding:var(--s2) var(--s3); margin:0 calc(-1 * var(--s3)); border-radius:var(--radius-sm); cursor:pointer; transition:background .15s; }
.check:hover { background:var(--surface-2); }
.check input { position:absolute; opacity:0; pointer-events:none; }
.box { width:20px; height:20px; flex:none; border:1.5px solid var(--line-2); border-radius:6px; display:grid; place-items:center; margin-top:1px; transition:background .15s, border-color .15s; }
.box .icon { width:14px; height:14px; stroke-width:2.2; color:var(--surface); opacity:0; transform:scale(.6); transition:opacity .15s, transform .15s; }
.check input:checked + .box { background:var(--ok); border-color:var(--ok); }
.check input:checked + .box .icon { opacity:1; transform:scale(1); }
.check input:checked ~ .check-text { color:var(--ink-3); }
.check-text { display:grid; gap:2px; font-size:14px; color:var(--ink-2); transition:color .15s; } .check-text b { color:var(--ink); font-weight:650; } .check input:checked ~ .check-text b { color:var(--ink-3); text-decoration:line-through; text-decoration-color:var(--line-2); }

.story { list-style:none; margin:0; padding:0; display:grid; gap:var(--s3); counter-reset:step; }
.story li { display:grid; grid-template-columns:88px minmax(0,1fr); gap:var(--s3); align-items:baseline; }
.tag { font-size:12px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; color:var(--ink-3); }
.result { display:block; font-weight:650; } .result + .result { margin-top:var(--s1); }
.why-group { display:grid; gap:var(--s4); }
.callout { display:flex; gap:var(--s2); padding:var(--s3) var(--s4); border-radius:var(--radius-sm); font-size:14px; }
.callout.warn { background:var(--warn-bg); color:var(--warn); } .callout ul { margin:var(--s1) 0 0; padding-left:var(--s4); }
.math { margin:var(--s2) 0 0; padding-left:var(--s5); font-size:13.5px; color:var(--ink-2); display:grid; gap:var(--s1); }

.fold { border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface); transition:border-color .15s; }
.fold + .fold { margin-top:var(--s2); }
.fold[open] { border-color:var(--line-2); }
.fold > summary { list-style:none; cursor:pointer; padding:var(--s3) var(--s4); display:flex; align-items:center; gap:var(--s2); font-weight:600; font-size:14px; border-radius:var(--radius-sm); transition:background .15s; }
.fold > summary::-webkit-details-marker { display:none; }
.fold > summary:hover { background:var(--surface-2); }
.fold > summary .chevron { color:var(--ink-3); transition:transform .15s; }
.fold[open] > summary .chevron { transform:rotate(90deg); }
.fold > :not(summary) { margin-left:var(--s4); margin-right:var(--s4); }
.fold > :last-child { margin-bottom:var(--s4); }
.count { white-space:nowrap; margin-left:auto; font-size:12px; font-weight:600; color:var(--ink-3); background:var(--surface-2); border-radius:999px; padding:0 var(--s2); }
.trace { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; color:var(--ink-2); padding-left:var(--s5); }
.calc-title { margin-top:var(--s4); font-weight:600; font-size:14px; }
.plain { padding-left:var(--s5); margin:var(--s2) 0 0; display:grid; gap:var(--s1); font-size:14px; }

.decision-row { display:grid; grid-template-columns:88px minmax(0,1fr); gap:var(--s4); padding-top:var(--s4); border-top:1px solid var(--line); }
.decision-line { display:grid; gap:2px; align-content:start; font-size:13px; color:var(--ink-3); } .line-id { font-weight:700; color:var(--ink); font-size:14px; }
.decision-body { display:grid; gap:var(--s3); min-width:0; }
.ask { font-weight:550; }
.recorded { display:flex; gap:var(--s2); align-items:flex-start; padding:var(--s3) var(--s4); border-radius:var(--radius-sm); font-size:14px; }
.recorded.ok { background:var(--ok-bg); color:var(--ok); } .recorded.alert { background:var(--alert-bg); color:var(--alert); }
.review { display:flex; gap:var(--s2); align-items:flex-start; font-size:13px; } .review.ok { color:var(--ok); } .review.wrong { color:var(--alert); }
.earlier { font-size:13px; color:var(--ink-3); }
.answers { display:grid; gap:var(--s2); }
.fold .answers { margin-top:var(--s1); }
.reply { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:2px var(--s3); align-items:center; padding:var(--s2) var(--s3); border:1px solid var(--line); border-radius:var(--radius-sm); background:var(--surface-2); transition:border-color .15s; }
.reply:hover { border-color:var(--line-2); }
.reply .btn { grid-row:span 2; }
.reply-label { font-size:12px; color:var(--ink-3); }
.reply code { overflow-wrap:anywhere; color:var(--ink); }
.reply.all { background:var(--surface); }

/* Confirmation chip after a copy. */
.toast { position:fixed; left:50%; bottom:var(--s6); transform:translate(-50%, var(--s4)); display:flex; gap:var(--s2); align-items:center; background:var(--ink); color:var(--surface); padding:var(--s2) var(--s4); border-radius:999px; font-size:13px; font-weight:600; opacity:0; pointer-events:none; transition:opacity .18s, transform .18s; box-shadow:var(--shadow-hover); }
.toast.show { opacity:1; transform:translate(-50%, 0); }

@media (max-width:640px) {
  main { padding-top:var(--s6); gap:var(--s4); }
  h1 { font-size:22px; } .hero-head h2 { font-size:20px; }
  .hero, .panel { padding:var(--s4); }
  .facts > div, .story li, .decision-row { grid-template-columns:minmax(0,1fr); gap:var(--s1); }
  .hero-head { align-items:flex-start; flex-direction:column; }
  .col-state { display:none; }
  .state-inline { display:block; margin-top:var(--s1); }
  th, td { padding-left:var(--s2); padding-right:var(--s2); }
}
@media (prefers-reduced-motion: reduce) { * { transition:none !important; scroll-behavior:auto !important; } }
@media print { .topbar, .btn, .toast, .answers, .fold > summary .chevron { display:none !important; } .fold { border:0; } body { background:#fff; } }
`;

export const SCRIPT = `
(() => {
  const toast = document.querySelector(".toast");
  let toastTimer;
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-copy]");
    if (!button) return;
    const text = button.dataset.copy;
    try { await navigator.clipboard.writeText(text); }
    catch {
      const area = document.createElement("textarea");
      area.value = text; document.body.append(area); area.select(); document.execCommand("copy"); area.remove();
    }
    const label = button.querySelector("span");
    button.classList.add("done"); label.textContent = "Copied";
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 1600);
    setTimeout(() => { button.classList.remove("done"); label.textContent = button.dataset.label; }, 1600);
  });

  // Checklist ticks are a per-viewer convenience; the page works without them.
  const list = document.querySelector(".checklist");
  if (list) {
    const key = "qpc-send-checks:" + list.dataset.key;
    const boxes = [...list.querySelectorAll("input[type=checkbox]")];
    const progress = list.querySelector(".progress");
    const update = () => {
      const done = boxes.filter((box) => box.checked).length;
      progress.querySelector("[data-done]").textContent = done;
      progress.classList.toggle("complete", done === boxes.length);
      try { localStorage.setItem(key, JSON.stringify(boxes.map((box) => box.checked))); } catch {}
    };
    try { (JSON.parse(localStorage.getItem(key) || "[]")).forEach((checked, index) => { if (boxes[index]) boxes[index].checked = checked; }); } catch {}
    boxes.forEach((box) => box.addEventListener("change", update));
    update();
  }

  // Highlight the section in view in the top bar.
  const links = [...document.querySelectorAll(".tabs a")];
  const sections = links.map((link) => document.querySelector(link.getAttribute("href"))).filter(Boolean);
  if ("IntersectionObserver" in window && sections.length) {
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        links.forEach((link) => link.classList.toggle("active", link.getAttribute("href") === "#" + entry.target.id));
      }
    }, { rootMargin: "-40% 0px -55% 0px" });
    sections.forEach((section) => observer.observe(section));
  }
})();
`;
