const $ = (s) => document.querySelector(s);
let timer = null;

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
function countryName(code) {
  if (!code) return "";
  try { return new Intl.DisplayNames(["en"], { type: "region" }).of(code) || code; } catch (e) { return code; }
}
function place(d) {
  const parts = [d.city, d.region, countryName(d.country)].filter(Boolean);
  return parts.length ? parts.join(", ") : "Location unknown";
}

async function api(path, opts) {
  const o = opts || {};
  const pw = sessionStorage.getItem("cr_panel_pw") || "";
  const headers = { "x-panel-token": pw };
  if (o.body) headers["content-type"] = "application/json";
  const res = await fetch(path, { method: o.method || "GET", headers: headers, body: o.body ? JSON.stringify(o.body) : undefined });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error((data && data.error) || "HTTP " + res.status);
  return data;
}

function tile(value, label, hero) {
  return h("div", { class: "tile" + (hero ? " hero" : "") }, h("b", {}, String(value)), h("span", {}, label));
}

function deviceCard(d) {
  const online = Date.now() - Date.parse(d.last_seen) <= 5 * 60000;
  const title = d.custom_name || d.name;
  return h("div", { class: "card" },
    h("div", { class: "row" },
      h("span", { class: "dot" + (online ? " on" : "") }),
      h("strong", {}, title),
      d.custom_name ? h("span", { class: "handle" }, "(" + d.name + ")") : ""),
    h("div", { class: "line" }, h("strong", {}, "Location: "), place(d)),
    h("div", { class: "line" }, h("strong", {}, "Device: "), [d.platform, d.browser, d.installed ? "installed app" : "in browser"].filter(Boolean).join(" · ")),
    d.timezone ? h("div", { class: "line" }, h("strong", {}, "Time zone: "), d.timezone) : "",
    h("div", { class: "line" }, h("strong", {}, "Last active: "), online ? "now" : ago(d.last_seen)),
    h("div", { class: "line" }, h("strong", {}, "First seen: "), ago(d.first_seen) + " · opened " + d.opens + " time(s)"),
    h("div", { class: "actions" },
      h("button", { class: "alt", onclick: () => rename(d) }, "Rename"),
      h("button", { class: "alt danger", onclick: () => remove(d) }, "Remove")));
}

async function load() {
  try {
    const d = await api("/api/admin/devices");
    $("#login").classList.add("hidden");
    $("#panel").classList.remove("hidden");
    $("#tiles").replaceChildren(
      tile(d.total, "Devices using ClientRadar", true),
      tile(d.active_now, "Active now"),
      tile(d.active_24h, "Active last 24h"),
      tile(d.active_7d, "Active last 7 days"));
    $("#list").replaceChildren(...(d.devices.length ? d.devices.map(deviceCard) : [h("p", { class: "muted" }, "No devices yet. A device appears here the first time it opens ClientRadar after this update.")]));
    msg("");
    if (!timer) timer = setInterval(load, 30000);
  } catch (e) {
    msg(e.message);
    if (/password/i.test(e.message)) logout(true);
  }
}

async function rename(d) {
  const v = prompt("Name for this device (leave empty to use its own name):", d.custom_name || d.name);
  if (v === null) return;
  try { await api("/api/admin/devices/" + d.id, { method: "PATCH", body: { name: v } }); await load(); } catch (e) { msg(e.message); }
}

async function remove(d) {
  if (!confirm("Remove this device from the list? It will show up again if it opens ClientRadar again.")) return;
  try { await api("/api/admin/devices/" + d.id, { method: "DELETE" }); await load(); } catch (e) { msg(e.message); }
}

function logout(keepMsg) {
  sessionStorage.removeItem("cr_panel_pw");
  if (timer) { clearInterval(timer); timer = null; }
  $("#panel").classList.add("hidden");
  $("#login").classList.remove("hidden");
  $("#pw").value = "";
  if (keepMsg !== true) msg("");
}

$("#login-btn").addEventListener("click", () => {
  const pw = $("#pw").value.trim();
  if (!pw) { msg("Type the admin password first."); return; }
  sessionStorage.setItem("cr_panel_pw", pw);
  msg("Checking...");
  load();
});
$("#pw").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#login-btn").click(); });
$("#refresh").addEventListener("click", load);
$("#logout").addEventListener("click", () => logout());

if (sessionStorage.getItem("cr_panel_pw")) load();
