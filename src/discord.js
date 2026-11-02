// Discord module for ClientRadar. READ-ONLY toward Discord: every request below is a GET.
// There is no code anywhere in this file that sends, replies, reacts or contacts anyone.
import { scoreDiscordMessage } from "./discord_scoring.js";
import { DEFAULT_KEYWORDS, DEFAULT_EXCLUDED, DEFAULT_MIN_SCORE } from "./scoring.js";

const API = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://clientradar.saifchandio60.workers.dev, 1.0)";
const SNOWFLAKE = /^\d{17,20}$/;
const MAX_CHANNELS_PER_SCAN = 8;
const MAX_PAGES = 2;
const FIRST_RUN_LIMIT = 50;
const INSERT_CAP = 20;
const VERIFY_PER_SCAN = 8;
const UNSAVED_DAYS = 7;
const SAVED_DAYS = 30;
const PAUSE_AFTER_FAILURES = 5;
const MAX_CHANNELS_CONFIGURED = 25;

const INSERT_SQL = "INSERT INTO posts (uri, author_handle, author_name, text, url, created_at, detected_at, intent, score, category, reasons, platform, guild_id, guild_name, channel_id, channel_name, author_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'discord', ?12, ?13, ?14, ?15, ?16) ON CONFLICT(uri) DO NOTHING";

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

function cmpId(a, b) {
  const x = BigInt(a), y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// Accepts a channel link (long-press a channel > Copy Link) or a plain channel ID.
export function parseChannelInput(raw) {
  const s = String(raw || "").trim();
  if (SNOWFLAKE.test(s)) return { channel_id: s, guild_id: null };
  const m = /^https:\/\/(?:(?:ptb|canary)\.)?(?:discord|discordapp)\.com\/channels\/(\d{17,20})\/(\d{17,20})(?:\/\d{17,20})?\/?$/i.exec(s);
  if (m) return { guild_id: m[1], channel_id: m[2] };
  return null;
}

// The only function that talks to Discord. GET only. The token is never logged or returned.
async function dget(env, path) {
  let res;
  try {
    res = await fetch(API + path, {
      method: "GET",
      headers: { "Authorization": "Bot " + env.DISCORD_BOT_TOKEN, "User-Agent": USER_AGENT }
    });
  } catch (e) {
    return { status: 0 };
  }
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data: data };
}

function diagnose(status) {
  if (status === 401) return "token_rejected: Discord rejected the bot token. Check the DISCORD_BOT_TOKEN secret.";
  if (status === 403) return "no_access: the bot cannot see this channel. Give it View Channel and Read Message History here, or ask a server admin.";
  if (status === 404) return "not_found: channel not found, or the bot is no longer in that server.";
  if (status === 429) return "rate_limited: Discord asked us to slow down. Will retry on the next scan.";
  if (status === 0) return "network: could not reach Discord.";
  return "http_" + status + ": unexpected response from Discord.";
}

function parseList(v, fallback, allowEmpty) {
  try {
    const x = JSON.parse(v);
    if (Array.isArray(x) && (allowEmpty || x.length)) return x.map(String);
  } catch (e) {}
  return fallback;
}

async function loadCfg(db) {
  const { results } = await db.prepare("SELECT key, value FROM settings").all();
  const m = {};
  for (const r of results) m[r.key] = r.value;
  const min = Number(m.min_score);
  return {
    keywords: parseList(m.keywords, DEFAULT_KEYWORDS, false),
    excluded: parseList(m.excluded, DEFAULT_EXCLUDED, true),
    minScore: m.min_score != null && Number.isFinite(min) ? min : DEFAULT_MIN_SCORE
  };
}

// Fill in channel and server names the first time we see a channel.
async function ensureMeta(env, ch) {
  if (ch.channel_name && ch.guild_id && ch.guild_name) return { ok: true };
  const r = await dget(env, "/channels/" + ch.channel_id);
  if (r.status !== 200 || !r.data) return { ok: false, status: r.status };
  if (r.data.type !== 0 && r.data.type !== 5) return { ok: false, status: -1, note: "unsupported: only text and announcement channels can be monitored." };
  ch.channel_name = r.data.name || ch.channel_name;
  ch.guild_id = r.data.guild_id || ch.guild_id;
  if (ch.guild_id && !ch.guild_name) {
    const g = await dget(env, "/guilds/" + ch.guild_id);
    if (g.status === 200 && g.data && g.data.name) ch.guild_name = g.data.name;
  }
  return { ok: true };
}

export async function runDiscordScan(env) {
  const db = env.DB;
  const started = new Date().toISOString();
  const run = await db.prepare("INSERT INTO discord_runs (started_at, status) VALUES (?1, 'running')").bind(started).run();
  const runId = run.meta.last_row_id;
  let checked = 0, seen = 0, newMatches = 0, removed = 0, okChannels = 0;
  let rateLimited = false;
  const problems = [];

  const finish = async (status, error) => {
    try {
      await db.prepare("UPDATE discord_runs SET status = ?1, finished_at = ?2, channels_checked = ?3, messages_seen = ?4, new_matches = ?5, removed = ?6, error = ?7 WHERE id = ?8")
        .bind(status, new Date().toISOString(), checked, seen, newMatches, removed, error ? String(error).slice(0, 500) : null, runId).run();
    } catch (e) {}
  };

  try {
    if (!env.DISCORD_BOT_TOKEN) throw new Error("DISCORD_BOT_TOKEN secret is missing.");
    const cfg = await loadCfg(db);
    const { results: channels } = await db.prepare("SELECT * FROM discord_channels WHERE status != 'paused' ORDER BY COALESCE(last_checked_at, '') ASC LIMIT ?1").bind(MAX_CHANNELS_PER_SCAN).all();
    const cutoffMs = Date.now() - UNSAVED_DAYS * 86400000;
    const stmts = [];
    const insertIdx = [];
    let budget = INSERT_CAP;
    let stop = false;

    const failChannel = (ch, status, note) => {
      const msg = note || diagnose(status);
      problems.push((ch.channel_name || ch.channel_id) + ": " + msg);
      stmts.push(db.prepare("UPDATE discord_channels SET last_error = ?1, fail_count = fail_count + 1, status = CASE WHEN fail_count + 1 >= ?2 THEN 'paused' ELSE 'error' END, last_checked_at = ?3 WHERE channel_id = ?4")
        .bind(msg, PAUSE_AFTER_FAILURES, new Date().toISOString(), ch.channel_id));
    };

    for (const ch of channels) {
      if (stop) break;
      checked++;

      const meta = await ensureMeta(env, ch);
      if (!meta.ok) {
        if (meta.status === 401) throw new Error(diagnose(401));
        if (meta.status === 429) { problems.push(diagnose(429)); rateLimited = true; stop = true; break; }
        failChannel(ch, meta.status, meta.note);
        continue;
      }

      let after = ch.last_message_id || null;
      const firstRun = !after;
      let lastDone = after;
      let capped = false;
      let failed = false;

      for (let page = 0; page < MAX_PAGES && !capped; page++) {
        const q = "/channels/" + ch.channel_id + "/messages?limit=" + (after ? 100 : FIRST_RUN_LIMIT) + (after ? "&after=" + after : "");
        const r = await dget(env, q);
        if (r.status !== 200 || !Array.isArray(r.data)) {
          if (r.status === 401) throw new Error(diagnose(401));
          if (r.status === 429) { problems.push(diagnose(429)); rateLimited = true; stop = true; }
          else failChannel(ch, r.status);
          failed = true;
          break;
        }
        const msgs = r.data.filter((m) => m && SNOWFLAKE.test(String(m.id))).sort((a, b) => cmpId(a.id, b.id));
        if (!msgs.length) break;

        for (const m of msgs) {
          const s = scoreDiscordMessage(m, cfg, { name: ch.channel_name });
          const made = Date.parse(m.timestamp);
          const fresh = !Number.isFinite(made) || made >= cutoffMs;
          const qualifies = fresh && !s.skip && s.qualifies;
          if (qualifies && budget <= 0) { capped = true; break; }
          if (qualifies) {
            const url = ch.guild_id ? "https://discord.com/channels/" + ch.guild_id + "/" + ch.channel_id + "/" + m.id : null;
            insertIdx.push(stmts.length);
            stmts.push(db.prepare(INSERT_SQL).bind(
              "discord:" + m.id,
              String((m.author && m.author.username) || "unknown"),
              String((m.author && m.author.global_name) || ""),
              s.text, url, m.timestamp || null, new Date().toISOString(),
              s.intent, s.score, s.category, JSON.stringify(s.reasons),
              ch.guild_id || null, ch.guild_name || null, ch.channel_id, ch.channel_name || null,
              m.author && m.author.id ? String(m.author.id) : null
            ));
            budget--;
          }
          seen++;
          lastDone = m.id;
        }
        after = lastDone;
        if (firstRun || msgs.length < 100) break;
      }

      if (!failed) {
        okChannels++;
        const nowIso = new Date().toISOString();
        stmts.push(db.prepare("UPDATE discord_channels SET last_message_id = ?1, channel_name = ?2, guild_id = ?3, guild_name = ?4, status = 'ok', last_error = NULL, fail_count = 0, last_checked_at = ?5, last_ok_at = ?5 WHERE channel_id = ?6")
          .bind(lastDone, ch.channel_name || null, ch.guild_id || null, ch.guild_name || null, nowIso, ch.channel_id));
      }
    }

    // Deleted-message check: re-fetch a few stored messages; if Discord says 404, remove ours too.
    if (!stop) {
      const { results: toCheck } = await db.prepare("SELECT id, channel_id, uri FROM posts WHERE platform = 'discord' ORDER BY COALESCE(checked_at, '') ASC LIMIT ?1").bind(VERIFY_PER_SCAN).all();
      for (const p of toCheck) {
        const mid = String(p.uri).replace(/^discord:/, "");
        if (!SNOWFLAKE.test(mid) || !SNOWFLAKE.test(String(p.channel_id))) continue;
        const r = await dget(env, "/channels/" + p.channel_id + "/messages/" + mid);
        if (r.status === 404) { stmts.push(db.prepare("DELETE FROM posts WHERE id = ?1").bind(p.id)); removed++; }
        else if (r.status === 200) stmts.push(db.prepare("UPDATE posts SET checked_at = ?1 WHERE id = ?2").bind(new Date().toISOString(), p.id));
        else if (r.status === 429) break;
      }
    }

    // Retention: unsaved messages are kept 7 days, saved ones 30 days at most.
    const now = Date.now();
    stmts.push(db.prepare("DELETE FROM posts WHERE platform = 'discord' AND is_saved = 0 AND detected_at < ?1").bind(new Date(now - UNSAVED_DAYS * 86400000).toISOString()));
    stmts.push(db.prepare("DELETE FROM posts WHERE platform = 'discord' AND is_saved = 1 AND detected_at < ?1").bind(new Date(now - SAVED_DAYS * 86400000).toISOString()));

    const res = await db.batch(stmts);
    newMatches = insertIdx.reduce((n, i) => n + (res[i].meta && res[i].meta.changes ? 1 : 0), 0);

    const allFailed = checked > 0 && okChannels === 0 && !rateLimited;
    const note = problems.length ? problems.join(" | ") : null;
    await finish(allFailed ? "error" : "ok", note);
    return { runId: runId, status: allFailed ? "error" : "ok", channelsChecked: checked, messagesSeen: seen, newlySaved: newMatches, removedDeleted: removed, problems: problems };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e).slice(0, 500);
    await finish("error", msg);
    return { runId: runId, status: "error", error: msg };
  }
}

async function channelRows(db) {
  const { results } = await db.prepare("SELECT channel_id, guild_id, guild_name, channel_name, status, last_error, fail_count, last_checked_at, last_ok_at FROM discord_channels ORDER BY created_at ASC").all();
  return results;
}

async function putChannels(env, request) {
  let b;
  try { b = await request.json(); } catch (e) { return json({ error: "Invalid JSON." }, 400); }
  if (!b || !Array.isArray(b.channels)) return json({ error: "Send { channels: [...] } with channel links or IDs." }, 400);
  if (b.channels.length > MAX_CHANNELS_CONFIGURED) return json({ error: "At most " + MAX_CHANNELS_CONFIGURED + " channels." }, 400);
  const parsed = [];
  const seen = new Set();
  for (const raw of b.channels) {
    const p = parseChannelInput(raw);
    if (!p) return json({ error: "Not a channel link or ID: " + String(raw).slice(0, 80) }, 400);
    if (!seen.has(p.channel_id)) { seen.add(p.channel_id); parsed.push(p); }
  }
  const db = env.DB;
  const now = new Date().toISOString();
  const stmts = [];
  if (parsed.length) {
    stmts.push(db.prepare("DELETE FROM discord_channels WHERE channel_id NOT IN (" + parsed.map(() => "?").join(",") + ")").bind(...parsed.map((p) => p.channel_id)));
  } else {
    stmts.push(db.prepare("DELETE FROM discord_channels"));
  }
  for (const p of parsed) {
    stmts.push(db.prepare("INSERT INTO discord_channels (channel_id, guild_id, status, created_at) VALUES (?1, ?2, 'new', ?3) ON CONFLICT(channel_id) DO UPDATE SET status = CASE WHEN status = 'paused' THEN 'new' ELSE status END, fail_count = CASE WHEN status = 'paused' THEN 0 ELSE fail_count END, guild_id = COALESCE(guild_id, excluded.guild_id)")
      .bind(p.channel_id, p.guild_id, now));
  }
  await db.batch(stmts);
  return json({ ok: true, channels: await channelRows(db) });
}

async function status(env) {
  const db = env.DB;
  const r = await db.batch([
    db.prepare("SELECT * FROM discord_runs WHERE status = 'ok' ORDER BY id DESC LIMIT 1"),
    db.prepare("SELECT * FROM discord_runs WHERE status = 'error' ORDER BY id DESC LIMIT 1"),
    db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END), 0) AS unread, COALESCE(SUM(CASE WHEN intent = 'high' THEN 1 ELSE 0 END), 0) AS high, COALESCE(SUM(is_saved), 0) AS saved FROM posts WHERE platform = 'discord'")
  ]);
  return {
    botTokenConfigured: !!env.DISCORD_BOT_TOKEN,
    channels: await channelRows(db),
    lastSuccessfulRun: r[0].results[0] || null,
    lastFailedRun: r[1].results[0] || null,
    counts: r[2].results[0]
  };
}

async function listDiscordPosts(env) {
  const { results } = await env.DB.prepare("SELECT id, uri, author_handle, author_name, author_id, text, url, created_at, detected_at, intent, score, category, reasons, is_read, is_saved, guild_name, channel_name FROM posts WHERE platform = 'discord' ORDER BY created_at DESC, id DESC LIMIT 30").all();
  return results.map((p) => {
    let reasons = [];
    try { reasons = JSON.parse(p.reasons); } catch (e) {}
    return Object.assign({}, p, { reasons: reasons });
  });
}

export async function handleDiscord(request, env, path) {
  if (!env.DB) return json({ error: "Database binding DB is missing." }, 500);
  const method = request.method;

  if (path === "/api/discord/status" && method === "GET") return json(await status(env));
  if (path === "/api/discord/channels" && method === "GET") return json({ channels: await channelRows(env.DB) });
  if (path === "/api/discord/channels" && method === "PUT") return await putChannels(env, request);
  if (path === "/api/discord/posts" && method === "GET") return json({ posts: await listDiscordPosts(env) });
  if (path === "/api/discord/scan" && method === "POST") {
    if (!env.DISCORD_BOT_TOKEN) return json({ error: "Server is missing secret: DISCORD_BOT_TOKEN" }, 500);
    return json(await runDiscordScan(env));
  }
  const m = /^\/api\/discord\/author\/(\d{17,20})$/.exec(path);
  if (m && method === "DELETE") {
    const r = await env.DB.prepare("DELETE FROM posts WHERE platform = 'discord' AND author_id = ?1").bind(m[1]).run();
    return json({ ok: true, deleted: r.meta.changes });
  }
  return json({ error: "Not found" }, 404);
}
