// Device tracking for the admin panel.
// Stores only: a random device id, a device name, platform/browser, and APPROXIMATE
// location (city/region/country from Cloudflare). It never stores the IP address.

const ID_RE = /^[A-Za-z0-9-]{16,64}$/;
const MAX_DEVICES = 500;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

function safeEqual(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

function clean(v, max) {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, max);
}

// The table is created automatically the first time it is needed, so no manual database step is required.
let ready = false;
async function ensureTable(db) {
  if (ready) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, custom_name TEXT, platform TEXT, browser TEXT, installed INTEGER NOT NULL DEFAULT 0, country TEXT, region TEXT, city TEXT, timezone TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, opens INTEGER NOT NULL DEFAULT 1)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_devices_last_seen ON devices(last_seen)")
  ]);
  ready = true;
}

// Called by every device that opens the app (already protected by the normal app token).
export async function registerDevice(request, env) {
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: "Invalid JSON." }, 400); }
  const id = b && b.id;
  if (typeof id !== "string" || !ID_RE.test(id)) return json({ error: "Invalid device id." }, 400);
  const cf = request.cf || {};
  const now = new Date().toISOString();
  await ensureTable(env.DB);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO devices (id, name, platform, browser, installed, country, region, city, timezone, first_seen, last_seen, opens)"
      + " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10, 1)"
      + " ON CONFLICT(id) DO UPDATE SET name = excluded.name, platform = excluded.platform, browser = excluded.browser,"
      + " installed = excluded.installed, country = COALESCE(excluded.country, devices.country),"
      + " region = COALESCE(excluded.region, devices.region), city = COALESCE(excluded.city, devices.city),"
      + " timezone = COALESCE(excluded.timezone, devices.timezone), last_seen = excluded.last_seen, opens = devices.opens + 1"
    ).bind(
      id,
      clean(b.name, 60) || "Unknown device",
      clean(b.platform, 30) || null,
      clean(b.browser, 30) || null,
      b.installed === true ? 1 : 0,
      clean(cf.country, 2) || null,
      clean(cf.region, 60) || null,
      clean(cf.city, 60) || null,
      clean(cf.timezone, 60) || null,
      now
    ),
    // Safety cap so the table can never grow without limit.
    env.DB.prepare("DELETE FROM devices WHERE id NOT IN (SELECT id FROM devices ORDER BY last_seen DESC LIMIT " + MAX_DEVICES + ")")
  ]);
  return json({ ok: true });
}

async function listDevices(env) {
  await ensureTable(env.DB);
  const { results } = await env.DB.prepare(
    "SELECT id, name, custom_name, platform, browser, installed, country, region, city, timezone, first_seen, last_seen, opens FROM devices ORDER BY last_seen DESC LIMIT " + MAX_DEVICES
  ).all();
  const now = Date.now();
  let live = 0, day = 0, week = 0;
  for (const d of results) {
    const age = now - Date.parse(d.last_seen);
    if (age <= 5 * 60000) live++;
    if (age <= 24 * 3600000) day++;
    if (age <= 7 * 24 * 3600000) week++;
  }
  return { total: results.length, active_now: live, active_24h: day, active_7d: week, devices: results };
}

// Admin panel API. Uses its own password (PANEL_PASSWORD secret) and falls back to ADMIN_TOKEN if that is not set.
export async function handleAdmin(request, env, path) {
  if (!env.DB) return json({ error: "Database binding DB is missing." }, 500);
  const secret = env.PANEL_PASSWORD || env.ADMIN_TOKEN;
  if (!secret) return json({ error: "Server is missing secret: ADMIN_TOKEN" }, 500);
  const given = request.headers.get("x-panel-token") || "";
  if (!safeEqual(given, secret)) {
    await new Promise((r) => setTimeout(r, 800)); // slows down password guessing
    return json({ error: "Wrong admin password." }, 401);
  }

  if (path === "/api/admin/devices" && request.method === "GET") return json(await listDevices(env));

  const m = /^\/api\/admin\/devices\/([A-Za-z0-9-]{16,64})$/.exec(path);
  if (m && request.method === "PATCH") {
    let b;
    try { b = await request.json(); } catch (e) { return json({ error: "Invalid JSON." }, 400); }
    const name = clean(b && b.name, 60);
    await ensureTable(env.DB);
    await env.DB.prepare("UPDATE devices SET custom_name = ?1 WHERE id = ?2").bind(name || null, m[1]).run();
    return json({ ok: true });
  }
  if (m && request.method === "DELETE") {
    await ensureTable(env.DB);
    await env.DB.prepare("DELETE FROM devices WHERE id = ?1").bind(m[1]).run();
    return json({ ok: true });
  }
  return json({ error: "Not found" }, 404);
}
