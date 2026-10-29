import { runScan } from "./scan.js";

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
  return {
    counts: r[0].results[0],
    lastSuccessfulScan: r[1].results[0] || null,
    lastFailedScan: r[2].results[0] || null
  };
}

async function listPosts(env, url) {
  let limit = parseInt(url.searchParams.get("limit") || "20", 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 20;
  if (limit > 50) limit = 50;
  const { results } = await env.DB.prepare(
    "SELECT id, uri, author_handle, author_name, text, url, created_at, detected_at, intent, score, category, reasons, is_read, is_saved FROM posts ORDER BY detected_at DESC, id DESC LIMIT ?1"
  ).bind(limit).all();
  return results.map((p) => {
    let reasons = [];
    try { reasons = JSON.parse(p.reasons); } catch (e) {}
    return Object.assign({}, p, { reasons: reasons });
  });
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
      return json({ error: "Not found" }, 404);
    } catch (e) {
      return json({ error: "Unexpected server error." }, 500);
    }
  }
};
