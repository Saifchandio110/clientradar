// DEMO DATA ONLY: fictional posts for previewing the layout. Replaced by real data in Phase 3/4.
const DEMO = [
  { id: 1, author: "Demo Person A", handle: "demo-a.example", category: "Character art", intent: "high", score: 9, hours: 1, read: false, saved: false,
    text: "DEMO: Looking to commission a digital artist to draw my OC. Budget is flexible!",
    reasons: ["looking to commission (+5)", "digital artist (+2)", "budget mentioned (+2)"] },
  { id: 2, author: "Demo Person B", handle: "demo-b.example", category: "Logo and branding", intent: "high", score: 8, hours: 5, read: false, saved: true,
    text: "DEMO: Need someone to design a logo for my new bakery. Paid work.",
    reasons: ["need someone to design (+4)", "logo (+2)", "paid work (+2)"] },
  { id: 3, author: "Demo Person C", handle: "demo-c.example", category: "Illustration", intent: "medium", score: 5, hours: 30, read: true, saved: false,
    text: "DEMO: Can anyone recommend an illustrator for a children's book?",
    reasons: ["asking for recommendations (+3)", "illustrator (+2)"] },
  { id: 4, author: "Demo Person D", handle: "demo-d.example", category: "Book cover", intent: "medium", score: 4, hours: 52, read: false, saved: false,
    text: "DEMO: Thinking about getting a cover made for my novel. Any ideas?",
    reasons: ["specific need (+3)", "cover (+1)"] },
  { id: 5, author: "Demo Person E", handle: "demo-e.example", category: "Illustration", intent: "low", score: 2, hours: 100, read: false, saved: false,
    text: "DEMO: I love commissioning artists, so many talented people here.",
    reasons: ["mentions commissions (+2)", "no clear request (0)"] },
  { id: 6, author: "Demo Person F", handle: "demo-f.example", category: "Graphic design", intent: "high", score: 7, hours: 200, read: true, saved: false,
    text: "DEMO: Looking for a graphic designer for my business, please share portfolios.",
    reasons: ["looking for a graphic designer (+5)", "business (+2)"] }
];
const CATS = ["All categories", "Character art", "Illustration", "Logo and branding", "Book cover", "Graphic design"];
const KEYWORDS = ["looking to commission", "need an artist", "looking for an illustrator", "can anyone recommend an artist", "need someone to design", "looking for a graphic designer", "need a book cover illustrator"];
const EXCLUDED = ["commissions open", "open for commissions", "dm me for prices", "tutorial"];

const $ = (s) => document.querySelector(s);
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
function ago(hours) {
  if (hours < 1) return "just now";
  if (hours < 24) return Math.round(hours) + "h ago";
  return Math.floor(hours / 24) + "d ago";
}

function renderStats() {
  const stats = [
    ["Total detected", DEMO.length],
    ["New", DEMO.filter((p) => !p.read).length],
    ["High intent", DEMO.filter((p) => p.intent === "high").length],
    ["Saved", DEMO.filter((p) => p.saved).length],
    ["Last scan", "Never"],
    ["Scanner", "Not running"]
  ];
  const box = $("#stats");
  box.replaceChildren(...stats.map(([label, value]) =>
    h("div", { class: "stat" }, h("b", {}, String(value)), h("span", {}, label))));
}

function visible(p) {
  const intent = $("#f-intent").value, cat = $("#f-cat").value, st = $("#f-status").value, d = $("#f-date").value;
  if (intent !== "all" && p.intent !== intent) return false;
  if (cat !== CATS[0] && p.category !== cat) return false;
  if (st === "new" && p.read) return false;
  if (st === "read" && !p.read) return false;
  if (st === "saved" && !p.saved) return false;
  if (d !== "all" && p.hours > Number(d)) return false;
  return true;
}

function renderFeed() {
  const list = DEMO.filter(visible);
  const box = $("#cards");
  if (!list.length) { box.replaceChildren(h("p", { class: "muted" }, "No posts match these filters.")); return; }
  box.replaceChildren(...list.map((p) =>
    h("div", { class: "card" + (p.read ? "" : " unread") },
      h("div", { class: "row" },
        h("strong", {}, p.author), h("span", { class: "handle" }, "@" + p.handle)),
      h("div", { class: "row" },
        h("span", { class: "badge " + p.intent }, p.intent.toUpperCase() + " " + p.score),
        h("span", { class: "badge cat" }, p.category),
        h("span", { class: "handle" }, "Detected " + ago(p.hours))),
      h("p", { class: "text" }, p.text),
      h("div", { class: "reasons" }, "Why: " + p.reasons.join(", ")),
      h("div", { class: "actions" },
        h("a", { href: "https://bsky.app", target: "_blank", rel: "noopener noreferrer" }, "Open original (demo link)"),
        h("button", { class: "alt", onclick: () => { p.saved = !p.saved; renderAll(); } }, p.saved ? "Unsave" : "Save"),
        h("button", { class: "alt", onclick: () => { p.read = !p.read; renderAll(); } }, p.read ? "Mark unread" : "Mark read")))));
}

function renderAll() { renderStats(); renderFeed(); }

// Setup
$("#f-cat").replaceChildren(...CATS.map((c) => h("option", { value: c }, c)));
for (const id of ["#f-intent", "#f-cat", "#f-status", "#f-date"]) $(id).addEventListener("change", renderFeed);
$("#kw").value = KEYWORDS.join("\n");
$("#ex").value = EXCLUDED.join("\n");
$("#save-settings").addEventListener("click", () => {
  $("#settings-msg").textContent = "Demo only: settings are not saved yet. Saving to the database comes in Phase 4.";
});
$("#perm").textContent = "Notification" in window ? Notification.permission : "not supported in this browser";
document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("nav button, .view").forEach((e) => e.classList.remove("active"));
  b.classList.add("active");
  $("#" + b.dataset.view).classList.add("active");
}));
renderAll();
