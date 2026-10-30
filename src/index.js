import { runScan } from "./scan.js";
import { DEFAULT_KEYWORDS, DEFAULT_EXCLUDED, DEFAULT_MIN_SCORE } from "./scoring.js";

const UPSERT = "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value";

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

function checkAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return json({ error: "Server is missing secret: ADMIN_TOKEN" }, 500);
  if (!env.DB) return json({ error: "Database binding DB is missing." }, 500);
  const token = request.headers.get("x-admin-token") || "";
  if (!safeEqual(token, env.ADMIN_TOKEN)) return json({ error: "Wrong admin token." }, 401);
  return null;
}

async function stats(env) {
  const db = env.DB;
  const r = await db.batch([
    db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END), 0) AS unread, COALESCE(SUM(CASE WHEN intent = 'high' THEN 1 ELSE 0 END), 0) AS high, COALESCE(SUM(is_saved), 0) AS saved FROM posts"),
    db.prepare("SELECT * FROM scan_runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1"),
    db.prepare("SELECT * FROM scan_runs WHERE status = 'error' ORDER BY id DESC LIMIT 1")
  ]);
  return { counts: r[0].results[0], lastSuccessfulScan: r[1].results[0] || null, lastFailedScan: r[2].results[0] || null };
}

async function listPosts(env, url) {
  const where = [];
  const args = [];
    where.push("(created_at >= ? OR is_saved = 1)");
  args.push(new Date(Date.now() - 7 * 24 * 3600000).toISOString());
  const intent = url.searchParams.get("intent");
  if (intent === "high" || intent === "medium" || intent === "low") { where.push("intent = ?"); args.push(intent); }
  const cat = url.searchParams.get("category");
  if (cat && cat.length <= 40) { where.push("category = ?"); args.push(cat); }
  const status = url.searchParams.get("status");
  if (status === "new") where.push("is_read = 0");
  else if (status === "read") where.push("is_read = 1");
  else if (status === "saved") where.push("is_saved = 1");
  const hours = parseInt(url.searchParams.get("hours") || "0", 10);
  if (hours > 0 && hours <= 8760) { where.push("detected_at >= ?"); args.push(new Date(Date.now() - hours * 3600000).toISOString()); }
  const sql = "SELECT id, uri, author_handle, author_name, text, url, created_at, detected_at, intent, score, category, reasons, is_read, is_saved FROM posts"
    + (where.length ? " WHERE " + where.join(" AND ") : "")
       + " ORDER BY created_at DESC, id DESC LIMIT 50";
  const { results } = await env.DB.prepare(sql).bind(...args).all();
  return results.map((p) => {
    let reasons = [];
    try { reasons = JSON.parse(p.reasons); } catch (e) {}
    return Object.assign({}, p, { reasons: reasons });
  });
}

async function patchPost(env, request, id) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "Invalid JSON." }, 400); }
  const sets = [];
  const args = [];
  if (typeof body.is_read === "boolean") { sets.push("is_read = ?"); args.push(body.is_read ? 1 : 0); }
  if (typeof body.is_saved === "boolean") { sets.push("is_saved = ?"); args.push(body.is_saved ? 1 : 0); }
  if (!sets.length) return json({ error: "Nothing to update." }, 400);
  args.push(id);
  const r = await env.DB.prepare("UPDATE posts SET " + sets.join(", ") + " WHERE id = ?").bind(...args).run();
  return json({ ok: true, changed: r.meta.changes });
}

function parseList(v, fallback, allowEmpty) {
  try {
    const x = JSON.parse(v);
    if (Array.isArray(x) && (allowEmpty || x.length)) return x.map(String);
  } catch (e) {}
  return fallback;
}

async function getSettings(env) {
  const { results } = await env.DB.prepare("SELECT key, value FROM settings").all();
  const m = {};
  for (const r of results) m[r.key] = r.value;
  const min = Number(m.min_score);
  return {
    keywords: parseList(m.keywords, DEFAULT_KEYWORDS, false),
    excluded: parseList(m.excluded, DEFAULT_EXCLUDED, true),
    min_score: m.min_score != null && Number.isFinite(min) ? min : DEFAULT_MIN_SCORE
  };
}

function cleanList(v, max) {
  if (!Array.isArray(v) || v.length > max) return null;
  const out = [];
  for (const x of v) {
    if (typeof x !== "string") return null;
    const s = x.trim();
    if (s.length < 2 || s.length > 80) return null;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

async function putSettings(env, request) {
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: "Invalid JSON." }, 400); }
  const keywords = cleanList(b.keywords, 40);
  const excluded = cleanList(b.excluded, 40);
  const min = Number(b.min_score);
  if (!keywords || !keywords.length) return json({ error: "Keywords: 1 to 40 lines, each 2 to 80 characters." }, 400);
  if (!excluded) return json({ error: "Excluded phrases: up to 40 lines, each 2 to 80 characters." }, 400);
  if (!Number.isInteger(min) || min < 0 || min > 20) return json({ error: "Minimum score must be a whole number from 0 to 20." }, 400);
  await env.DB.batch([
    env.DB.prepare(UPSERT).bind("keywords", JSON.stringify(keywords)),
    env.DB.prepare(UPSERT).bind("excluded", JSON.stringify(excluded)),
    env.DB.prepare(UPSERT).bind("min_score", String(min))
  ]);
  return json({ ok: true });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);

      const denied = checkAdmin(request, env);
      if (denied) return denied;

      if (path === "/api/scan") {
        if (request.method !== "POST") return json({ error: "Use POST." }, 405);
        const missing = ["BSKY_IDENTIFIER", "BSKY_APP_PASSWORD"].filter((k) => !env[k]);
        if (missing.length) return json({ error: "Server is missing secret(s): " + missing.join(", ") }, 500);
        return json(await runScan(env));
      }
      if (path === "/api/stats" && request.method === "GET") return json(await stats(env));
      if (path === "/api/posts" && request.method === "GET") return json({ posts: await listPosts(env, url) });
      const m = /^\/api\/posts\/(\d+)$/.exec(path);
      if (m && request.method === "PATCH") return await patchPost(env, request, Number(m[1]));
            if (path === "/api/posts/mark-all-read" && request.method === "POST") {
        const r = await env.DB.prepare("UPDATE posts SET is_read = 1 WHERE is_read = 0").run();
        return json({ ok: true, changed: r.meta.changes });
      }
      if (path === "/api/settings" && request.method === "GET") return json(await getSettings(env));
      if (path === "/api/settings" && request.method === "PUT") return await putSettings(env, request);
      if (path === "/api/activity" && request.method === "GET") {
        const { results } = await env.DB.prepare("SELECT id, started_at, finished_at, status, queries_run, posts_seen, new_matches, error FROM scan_runs ORDER BY id DESC LIMIT 15").all();
        return json({ runs: results });
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: "Unexpected server error." }, 500);
    }
  },

  // Runs on the cron schedule in wrangler.jsonc.
  async scheduled(event, env, ctx) {
    if (!env.DB || !env.BSKY_IDENTIFIER || !env.BSKY_APP_PASSWORD) return;
    ctx.waitUntil(runScan(env));
  }
};
