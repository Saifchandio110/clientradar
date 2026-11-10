import { normalizePost } from "../public/bluesky.js";
import { scorePost, DEFAULT_KEYWORDS, DEFAULT_EXCLUDED, DEFAULT_MIN_SCORE } from "./scoring.js";
import { notifyNew } from "./push.js";

const PDS = "https://bsky.social/xrpc";
const PHRASES_PER_SCAN = 8;
const MAX_PAGES = 2;
const INSERT_CAP = 30;
const BLOCKED_AUTHORS = ["intentpond.bsky.social"];
const MAX_AGE_MS = 7 * 24 * 3600000;
const UPSERT = "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value";
const INSERT_POST = "INSERT INTO posts (uri, author_handle, author_name, text, url, created_at, detected_at, intent, score, category, reasons) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) ON CONFLICT(uri) DO NOTHING";

export async function login(env) {
  let res;
  try {
    res = await fetch(PDS + "/com.atproto.server.createSession", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: env.BSKY_IDENTIFIER, password: env.BSKY_APP_PASSWORD })
    });
  } catch (e) {
    return { error: "Could not reach Bluesky to log in." };
  }
  if (res.status === 401 || res.status === 400) return { error: "Bluesky login failed. Check BSKY_IDENTIFIER and BSKY_APP_PASSWORD." };
  if (res.status === 429) return { error: "Bluesky login rate limited." };
  if (!res.ok) return { error: "Bluesky login returned HTTP " + res.status + "." };
  const data = await res.json().catch(() => null);
  if (!data || !data.accessJwt) return { error: "Bluesky login response was unexpected." };
  return { jwt: data.accessJwt };
}

// Re-use the Bluesky login for up to ~2 hours instead of logging in on every scan.
// Bluesky only allows about 300 logins per day, and a scan every 2 minutes would go over that.
async function getSession(env, db) {
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'bsky_jwt'").first();
    if (row && row.value) {
      const jwt = row.value;
      const part = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const exp = JSON.parse(atob(part + "=".repeat((4 - part.length % 4) % 4))).exp * 1000;
      if (Number.isFinite(exp) && exp - Date.now() > 10 * 60000) return { jwt: jwt };
    }
  } catch (e) {}
  const fresh = await login(env);
  if (fresh.jwt) {
    try { await db.prepare(UPSERT).bind("bsky_jwt", fresh.jwt).run(); } catch (e) {}
  }
  return fresh;
}

function parseList(v, fallback, allowEmpty) {
  try {
    const x = JSON.parse(v);
    if (Array.isArray(x) && (allowEmpty || x.length)) return x.map(String);
  } catch (e) {}
  return fallback;
}

async function loadSettings(db) {
  const { results } = await db.prepare("SELECT key, value FROM settings").all();
  const m = {};
  for (const r of results) m[r.key] = r.value;
  const min = Number(m.min_score);
  let last = {};
  try { last = JSON.parse(m.phrase_last_run || "{}") || {}; } catch (e) {}
  return {
    keywords: parseList(m.keywords, DEFAULT_KEYWORDS, false),
    excluded: parseList(m.excluded, DEFAULT_EXCLUDED, true),
    // Never go below the default: scores under 4 are the 'Low' junk leads.
    minScore: Math.max(DEFAULT_MIN_SCORE, m.min_score != null && Number.isFinite(min) ? min : DEFAULT_MIN_SCORE),
    offset: Number(m.rotate_offset) || 0,
    phraseLastRun: last,
    deleted: (() => { try { const d = JSON.parse(m.deleted_uris || "[]"); return new Set(Array.isArray(d) ? d : []); } catch (e) { return new Set(); } })()
  };
}

// One-time clean-up: when the scoring rules change, re-check posts already saved (except ones you saved yourself)
// so old junk leads disappear. Raise SCORING_VERSION whenever scoring.js changes in a big way.
const SCORING_VERSION = "2";
async function rescoreOnce(db, cfg) {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'scoring_version'").first();
  if (row && row.value === SCORING_VERSION) return;
  const { results } = await db.prepare("SELECT id, text, author_name FROM posts WHERE is_saved = 0 LIMIT 1000").all();
  const stmts = [];
  for (const r of results) {
    const s = scorePost(r.text, cfg, { author_name: r.author_name });
    if (s.skip || s.score <= 0 || s.score < cfg.minScore) stmts.push(db.prepare("DELETE FROM posts WHERE id = ?1").bind(r.id));
    else stmts.push(db.prepare("UPDATE posts SET intent = ?1, score = ?2, category = ?3, reasons = ?4 WHERE id = ?5").bind(s.intent, s.score, s.category, JSON.stringify(s.reasons), r.id));
  }
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
  await db.prepare(UPSERT).bind("scoring_version", SCORING_VERSION).run();
}

async function searchPage(jwt, phrase, cursor, since) {
  const u = new URL(PDS + "/app.bsky.feed.searchPosts");
   if (phrase.startsWith("#")) {
    const tag = phrase.slice(1).replace(/[^A-Za-z0-9_]/g, "").slice(0, 60);
    if (!tag) return { error: "bad", message: "empty hashtag" };
    u.searchParams.set("q", "#" + tag);
    u.searchParams.set("tag", tag);
  } else {
    u.searchParams.set("q", '"' + phrase + '"');
  }
  u.searchParams.set("sort", "latest");
  u.searchParams.set("limit", "25");
  u.searchParams.set("lang", "en");
  u.searchParams.set("since", since);
  if (cursor) u.searchParams.set("cursor", cursor);
  let res;
  try {
    res = await fetch(u.toString(), { headers: { authorization: "Bearer " + jwt } });
  } catch (e) {
    return { error: "network", message: "network error" };
  }
  if (res.status === 429) return { error: "rate_limit", message: "rate limited" };
  if (res.status === 401 || res.status === 400) return { error: "auth", message: "HTTP " + res.status };
  if (!res.ok) return { error: "http", message: "HTTP " + res.status };
  const data = await res.json().catch(() => null);
  if (!data) return { error: "parse", message: "invalid JSON" };
  const posts = (Array.isArray(data.posts) ? data.posts : []).map(normalizePost).filter(Boolean);
  return { posts: posts, cursor: data.cursor || null };
}

// Remove posts that are already saved in the database, so we never show them twice.
async function onlyNew(db, items) {
  const have = new Set();
  const uris = items.map((x) => x.p.uri);
  for (let i = 0; i < uris.length; i += 90) {
    const chunk = uris.slice(i, i + 90);
    const { results } = await db.prepare("SELECT uri FROM posts WHERE uri IN (" + chunk.map(() => "?").join(",") + ")").bind(...chunk).all();
    for (const r of results) have.add(r.uri);
  }
  return items.filter((x) => !have.has(x.p.uri));
}

export async function runScan(env) {
  const db = env.DB;
  const started = new Date().toISOString();
  const run = await db.prepare("INSERT INTO scan_runs (started_at, status) VALUES (?1, 'running')").bind(started).run();
  const runId = run.meta.last_row_id;
  let seen = 0, queriesRun = 0, newMatches = 0, candidates = 0, freshCount = 0;
  const errors = [];
  const cutoffMs = Date.now() - MAX_AGE_MS;
  const cutoffIso = new Date(cutoffMs).toISOString();

  try {
    const cfg = await loadSettings(db);
    try { await rescoreOnce(db, cfg); } catch (e) { errors.push("cleanup: " + String(e && e.message ? e.message : e).slice(0, 100)); }
    const session = await getSession(env, db);
    if (session.error) throw new Error(session.error);

    const n = cfg.keywords.length;
    const picks = [];
    for (let i = 0; i < Math.min(PHRASES_PER_SCAN, n); i++) picks.push(cfg.keywords[(cfg.offset + i) % n]);

    const found = new Map();
    const okPhrases = [];
    outer:
    for (const phrase of picks) {
      const t = Date.parse(cfg.phraseLastRun[phrase]);
      const base = Number.isFinite(t) ? Math.max(t - 15 * 60000, cutoffMs) : cutoffMs;
      const since = new Date(base).toISOString();
      let cursor = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const r = await searchPage(session.jwt, phrase, cursor, since);
        queriesRun++;
        if (r.error) {
          errors.push(phrase + ": " + r.message);
          if (r.error === "rate_limit") break outer;
          if (r.error === "auth") {
            try { await db.prepare("DELETE FROM settings WHERE key = 'bsky_jwt'").run(); } catch (e) {}
            break outer;
          }
          break;
        }
        if (page === 0) okPhrases.push(phrase);
        for (const p of r.posts) { seen++; if (!found.has(p.uri)) found.set(p.uri, p); }
        cursor = r.cursor;
        if (!cursor || r.posts.length < 25) break;
      }
    }
    if (okPhrases.length === 0) throw new Error("All searches failed: " + errors.join("; "));

    candidates = found.size;
    const keep = [];
    for (const p of found.values()) {
            if (BLOCKED_AUTHORS.includes(String(p.author_handle).toLowerCase())) continue;
      if (cfg.deleted.has(p.uri)) continue;
      const made = Date.parse(p.created_at);
      if (Number.isFinite(made) && made < cutoffMs) continue; // older than 7 days
      const s = scorePost(p.text, cfg, p);
      if (!s.skip && s.score > 0 && s.score >= cfg.minScore) keep.push({ p: p, s: s });
    }
        keep.sort((a, b) => (Date.parse(b.p.created_at) || 0) - (Date.parse(a.p.created_at) || 0));

    const fresh = keep.length ? await onlyNew(db, keep) : [];
    freshCount = fresh.length;
    const toInsert = fresh.slice(0, INSERT_CAP);
    const now = new Date().toISOString();
    if (toInsert.length) {
      const stmts = toInsert.map((x) => db.prepare(INSERT_POST).bind(
        x.p.uri, x.p.author_handle, x.p.author_name, x.p.text, x.p.url,
        x.p.created_at, now, x.s.intent, x.s.score, x.s.category, JSON.stringify(x.s.reasons)
      ));
      const res = await db.batch(stmts);
      newMatches = res.reduce((sum, r) => sum + (r.meta && r.meta.changes ? 1 : 0), 0);
            const inserted = toInsert.filter((x, i) => res[i].meta && res[i].meta.changes);
      await notifyNew(env, inserted);
    }

    // Only move the per-phrase clock forward when no new posts were left for the next scan.
    const complete = fresh.length <= INSERT_CAP;
    const state = cfg.phraseLastRun;
    if (complete) for (const ph of okPhrases) state[ph] = started;
    await db.batch([
      db.prepare(UPSERT).bind("rotate_offset", String((cfg.offset + PHRASES_PER_SCAN) % n)),
      db.prepare(UPSERT).bind("phrase_last_run", JSON.stringify(state))
    ]);

    // Delete unsaved posts older than 7 days. Saved posts are always kept.
    await db.prepare("DELETE FROM posts WHERE is_saved = 0 AND created_at < ?1").bind(cutoffIso).run();

    await db.prepare("UPDATE scan_runs SET status = 'ok', finished_at = ?1, queries_run = ?2, posts_seen = ?3, new_matches = ?4, error = ?5 WHERE id = ?6")
      .bind(new Date().toISOString(), queriesRun, seen, newMatches, errors.length ? errors.join("; ").slice(0, 500) : null, runId).run();

    return { runId: runId, status: "ok", searches: queriesRun, postsSeen: seen, uniquePosts: candidates, newQualifying: freshCount, newlySaved: newMatches, leftForNextScan: Math.max(0, freshCount - INSERT_CAP), errors: errors };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e).slice(0, 500);
    try {
      await db.prepare("UPDATE scan_runs SET status = 'error', finished_at = ?1, queries_run = ?2, posts_seen = ?3, error = ?4 WHERE id = ?5")
        .bind(new Date().toISOString(), queriesRun, seen, msg, runId).run();
    } catch (e2) {}
    return { runId: runId, status: "error", error: msg };
  }
}
