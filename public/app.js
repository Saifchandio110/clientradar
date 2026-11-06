const CATS = ["All categories", "Character art", "Illustration", "Logo and branding", "Book cover", "Graphic design", "Other"];
const $ = (s) => document.querySelector(s);
let current = "dashboard";

function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) e.append(k);
  return e;
}
function msg(t) { $("#msg").textContent = t || ""; }
function ago(iso) {
  const m = (Date.now() - Date.parse(iso)) / 60000;
  if (!Number.isFinite(m)) return "unknown";
  if (m < 1) return "just now";
  if (m < 60) return Math.round(m) + "m ago";
  if (m < 1440) return Math.round(m / 60) + "h ago";
  return Math.floor(m / 1440) + "d ago";
}

async function api(path, opts) {
  const o = opts || {};
  const t = localStorage.getItem("cr_token") || "";
  if (!t) throw new Error("Open Settings and save your admin token first.");
  const headers = { "x-admin-token": t };
  if (o.body) headers["content-type"] = "application/json";
  const res = await fetch(path, { method: o.method || "GET", headers: headers, body: o.body ? JSON.stringify(o.body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error((data && data.error) || "HTTP " + res.status);
  return data;
}

// Reload whatever screen is open, plus the dashboard numbers.
async function reload() {
  await LOADERS[current]();
  if (current !== "dashboard") await loadDashboard();
}

/* ---------- Dashboard ---------- */
async function loadDashboard() {
  try {
    const d = await api("/api/stats");
    const ok = d.lastSuccessfulScan, bad = d.lastFailedScan;
    const failedLast = bad && (!ok || bad.id > ok.id);
    const tiles = [
      ["Total detected", d.counts.total], ["New", d.counts.unread],
      ["High intent", d.counts.high], ["Saved", d.counts.saved],
      ["Last successful scan", ok ? ago(ok.finished_at) : "Never"],
      ["Scanner", failedLast ? "Last scan failed" : (ok ? "Healthy" : "No scans yet")]
    ];
    $("#stats").replaceChildren(...tiles.map((t) => h("div", { class: "stat" }, h("b", {}, String(t[1])), h("span", {}, t[0]))));
    $("#scanner").textContent = failedLast
      ? "Last failure: " + (bad.error || "unknown")
      : (ok ? "Last scan checked " + ok.posts_seen + " posts and saved " + ok.new_matches + " new matches." : "No scans yet. Tap Scan now.");
    msg("");
  } catch (e) { msg(e.message); }
}

/* ---------- Feed ---------- */
async function patch(id, body) {
  try {
    await api("/api/posts/" + id, { method: "PATCH", body: body });
    await reload();
  } catch (e) { msg(e.message); }
}

async function removePost(id) {
  try {
    await api("/api/posts/" + id, { method: "DELETE" });
    await reload();
  } catch (e) { msg(e.message); }
}

function card(p) {
  return h("div", { class: "card i-" + p.intent + (p.is_read ? "" : " unread") },
    h("div", { class: "row" }, h("strong", {}, p.author_name || p.author_handle), h("span", { class: "handle" }, "@" + p.author_handle)),
    h("div", { class: "row" },
      h("span", { class: "badge " + p.intent }, p.intent.toUpperCase() + " " + p.score),
      h("span", { class: "badge cat" }, p.category || "Other"),
      h("span", { class: "handle" }, "Detected " + ago(p.detected_at))),
    h("p", { class: "text" }, p.text),
    h("div", { class: "reasons" }, "Why: " + p.reasons.join(", ")),
    h("div", { class: "actions" },
      p.url ? h("a", { href: p.url, target: "_blank", rel: "noopener noreferrer" }, "Open original post") : "",
      h("button", { class: "alt", onclick: () => patch(p.id, { is_saved: !p.is_saved }) }, p.is_saved ? "Unsave" : "Save"),
      h("button", { class: "alt", onclick: () => patch(p.id, { is_read: !p.is_read }) }, p.is_read ? "Mark unread" : "Mark read"),
      h("button", { class: "alt danger", onclick: () => removePost(p.id) }, "Delete")));
}

async function loadFeed() {
  const q = new URLSearchParams();
  if ($("#f-intent").value !== "all") q.set("intent", $("#f-intent").value);
  if ($("#f-cat").value !== CATS[0]) q.set("category", $("#f-cat").value);
  if ($("#f-status").value !== "all") q.set("status", $("#f-status").value);
  if ($("#f-date").value !== "all") q.set("hours", $("#f-date").value);
  try {
    const d = await api("/api/posts?" + q.toString());
    const box = $("#cards");
    if (!d.posts.length) box.replaceChildren(h("p", { class: "muted" }, "No posts match these filters yet."));
    else box.replaceChildren(...d.posts.map(card));
    msg("");
  } catch (e) { msg(e.message); }
}

/* ---------- Settings and Activity ---------- */
async function loadSettings() {
  try {
    const s = await api("/api/settings");
    $("#kw").value = s.keywords.join("\n");
    $("#ex").value = s.excluded.join("\n");
    $("#min").value = s.min_score;
    msg("");
  } catch (e) { msg(e.message); }
}

async function loadActivity() {
  try {
    const d = await api("/api/activity");
    if (!d.runs.length) { $("#runs").replaceChildren(h("p", { class: "muted" }, "No scans yet.")); return; }
    $("#runs").replaceChildren(...d.runs.map((r) =>
      h("div", { class: "card" },
        h("div", { class: "row" },
          h("span", { class: "badge " + (r.status === "ok" ? "high" : r.status === "error" ? "low" : "medium") }, r.status.toUpperCase()),
          h("span", { class: "handle" }, ago(r.started_at))),
        h("div", {}, "Searches: " + r.queries_run + " | Posts processed: " + r.posts_seen + " | New matches: " + r.new_matches),
        r.error ? h("div", { class: "reasons" }, "Error: " + r.error) : "")));
    msg("");
  } catch (e) { msg(e.message); }
}

/* ---------- Navigation and buttons ---------- */
const LOADERS = { dashboard: loadDashboard, feed: loadFeed, settings: loadSettings, activity: loadActivity };
function show(view) {
  current = view;
  document.querySelectorAll("nav button, .view").forEach((e) => e.classList.remove("active"));
  document.querySelector('nav button[data-view="' + view + '"]').classList.add("active");
  $("#" + view).classList.add("active");
  LOADERS[view]();
}

$("#f-cat").replaceChildren(...CATS.map((c) => h("option", { value: c }, c)));
for (const id of ["#f-intent", "#f-cat", "#f-status", "#f-date"]) $(id).addEventListener("change", loadFeed);
document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));
$("#tok").value = localStorage.getItem("cr_token") || "";
$("#perm").textContent = "Notification" in window ? Notification.permission : "not supported in this browser";

$("#save-token").addEventListener("click", () => {
  localStorage.setItem("cr_token", $("#tok").value.trim());
  msg("Token saved on this phone.");
  loadSettings();
});
$("#save-settings").addEventListener("click", async () => {
  const lines = (id) => $(id).value.split("\n").map((x) => x.trim()).filter(Boolean);
  try {
    await api("/api/settings", { method: "PUT", body: { keywords: lines("#kw"), excluded: lines("#ex"), min_score: Number($("#min").value) } });
    msg("Settings saved. They apply from the next scan.");
  } catch (e) { msg(e.message); }
});
$("#scan-now").addEventListener("click", async () => {
  msg("Scanning... this can take several seconds.");
  try {
    const r = await api("/api/scan", { method: "POST" });
    await loadDashboard();
    msg(r.status === "ok" ? "Scan finished: " + r.newlySaved + " new matches." : "Scan failed: " + r.error);
  } catch (e) { msg(e.message); }
});
$("#mark-all").addEventListener("click", async () => {
  try {
    await api("/api/posts/mark-all-read", { method: "POST" });
    await loadFeed();
    loadDashboard();
  } catch (e) { msg(e.message); }
});

/* ---------- Push notifications ---------- */
function pmsg(t) { $("#push-msg").textContent = t; }
function keyToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

$("#enable-push").addEventListener("click", async () => {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) { pmsg("This browser does not support push notifications."); return; }
    const perm = await Notification.requestPermission();
    $("#perm").textContent = perm;
    if (perm !== "granted") { pmsg("Permission not granted. Allow notifications for this site in Chrome's site settings."); return; }
    const reg = await navigator.serviceWorker.register("sw.js");
    await navigator.serviceWorker.ready;
    const k = await api("/api/push/key");
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(k.key) });
    await api("/api/push/subscribe", { method: "POST", body: sub.toJSON() });
    pmsg("Notifications enabled on this device. Now tap a test button.");
  } catch (e) { pmsg("Could not enable: " + e.message); }
});

async function testPush(delay) {
  try {
    const r = await api("/api/push/test" + (delay ? "?delay=" + delay : ""), { method: "POST" });
    if (delay) pmsg("Scheduled. Close Chrome or lock your phone now. A notification should arrive in about " + delay + " seconds.");
    else if (!r.devices) pmsg("No device is subscribed yet. Tap Enable notifications first.");
    else pmsg("Sent to " + r.sent + " of " + r.devices + " device(s). Push service replies: " + r.statuses.join(", ") + (r.detail ? " (" + r.detail + ")" : ""));
  } catch (e) { pmsg(e.message); }
}
$("#test-push").addEventListener("click", () => testPush(0));
$("#test-push-delay").addEventListener("click", () => testPush(15));

if (localStorage.getItem("cr_token")) loadDashboard();
else show("settings");
