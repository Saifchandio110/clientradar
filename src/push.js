const enc = new TextEncoder();
const ALLOWED_HOSTS = ["fcm.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"];
const B64U = /^[A-Za-z0-9_-]+$/;

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}

function b64uToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64u(b) {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function configured(env) {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

function validEndpoint(e) {
  if (typeof e !== "string" || e.length > 1000) return false;
  let u;
  try { u = new URL(e); } catch (x) { return false; }
  if (u.protocol !== "https:") return false;
  return ALLOWED_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h));
}

async function vapidHeader(env, endpoint) {
  const pub = b64uToBytes(env.VAPID_PUBLIC_KEY);
  const jwk = {
    kty: "EC", crv: "P-256",
    x: bytesToB64u(pub.slice(1, 33)),
    y: bytesToB64u(pub.slice(33, 65)),
    d: env.VAPID_PRIVATE_KEY,
    ext: true
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = bytesToB64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToB64u(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT
  })));
  const data = header + "." + claims;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(data)));
  return "vapid t=" + data + "." + bytesToB64u(sig) + ", k=" + env.VAPID_PUBLIC_KEY;
}

async function hkdf(salt, ikm, info, bytes) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt, info: info }, k, bytes * 8));
}

// RFC 8291 (aes128gcm) payload encryption.
async function encrypt(sub, payload) {
  const uaPub = b64uToBytes(sub.p256dh);
  const auth = b64uToBytes(sub.auth);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPub, asPub);
  const ikm = await hkdf(auth, shared, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plain = concat(payload, new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, plain));
  return concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([65]), asPub, ct);
}

async function sendPush(env, sub, payload) {
  try {
    const body = await encrypt(sub, enc.encode(JSON.stringify(payload)));
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        "Authorization": await vapidHeader(env, sub.endpoint),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": "86400",
        "Urgency": "high"
      },
      body: body
    });
    const ok = res.status >= 200 && res.status < 300;
    let detail = "";
    if (!ok) { try { detail = (await res.text()).slice(0, 120); } catch (e) {} }
    return { ok: ok, status: res.status, detail: detail };
  } catch (e) {
    return { ok: false, status: 0, detail: String(e && e.message ? e.message : e).slice(0, 120) };
  }
}

export async function pushToAll(env, payload) {
  const { results } = await env.DB.prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions ORDER BY id DESC LIMIT 5").all();
  const out = { devices: results.length, sent: 0, removed: 0, failed: 0, statuses: [], detail: "" };
  for (const s of results) {
    const r = await sendPush(env, s, payload);
    out.statuses.push(r.status);
    if (r.ok) out.sent++;
    else if (r.status === 404 || r.status === 410) {
      await env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ?1").bind(s.id).run();
      out.removed++;
    } else { out.failed++; if (!out.detail) out.detail = r.detail; }
  }
  return out;
}

function platformLabel() {
  return "Bluesky";
}

// Builds the notification text for one or more new leads.
export function buildLeadPayload(items) {
  const first = items[0];
  const p = first.p;
  const one = items.length === 1;
  const plat = platformLabel(p);
  const platforms = new Set(items.map((x) => platformLabel(x.p)));
  const who = p.author_name || p.author_handle;
   const where = "";
  const text = String(p.text).replace(/\s+/g, " ").slice(0, 110);
  return {
    title: one
      ? first.s.intent.toUpperCase() + " lead on " + plat + ": " + first.s.category
      : items.length + " new client leads" + (platforms.size === 1 ? " on " + plat : ""),
    body: (one ? "" : "Latest: ") + who + where + ": " + text,
    url: one && p.url ? p.url : "/"
  };
}

// ---------- ntfy (phone notifications through the ntfy app) ----------
// Set the secret NTFY_TOPIC (a long random name). Optional: NTFY_SERVER (default https://ntfy.sh) and NTFY_TOKEN.
function ntfyConfigured(env) {
  return !!(env.NTFY_TOPIC && /^[A-Za-z0-9_-]{8,64}$/.test(env.NTFY_TOPIC));
}

async function ntfyPublish(env, msg) {
  const base = String(env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
  if (!/^https:\/\//.test(base)) return { ok: false, status: 0 };
  const headers = { "content-type": "application/json" };
  if (env.NTFY_TOKEN) headers.authorization = "Bearer " + env.NTFY_TOKEN;
  try {
    const res = await fetch(base, { method: "POST", headers: headers, body: JSON.stringify(Object.assign({ topic: env.NTFY_TOPIC }, msg)) });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, status: 0 };
  }
}

// One notification per lead (up to 5), plus one summary if there are more. Returns how many were delivered.
async function ntfyLeads(env, items) {
  let sent = 0;
  for (const it of items.slice(0, 5)) {
    const p = it.p;
    const high = it.s.intent === "high";
    const r = await ntfyPublish(env, {
      title: it.s.intent.toUpperCase() + " lead: " + it.s.category,
      message: (p.author_name || p.author_handle) + ": " + String(p.text).replace(/\s+/g, " ").slice(0, 300),
      priority: high ? 4 : 3,
      tags: [high ? "fire" : "mag"],
      click: p.url || undefined
    });
    if (r.ok) sent++;
  }
  if (items.length > 5) {
    const r = await ntfyPublish(env, { title: (items.length - 5) + " more new leads", message: "Open ClientRadar to see them.", priority: 3 });
    if (r.ok) sent++;
  }
  return sent;
}

// Called by the scanners with the items that were newly saved in this scan. Never throws.
// ntfy is used first when it is set up. Browser push is the fallback if ntfy is off or did not deliver.
export async function notifyNew(env, items) {
  try {
    if (!items || !items.length) return;
    let delivered = 0;
    if (ntfyConfigured(env)) delivered += await ntfyLeads(env, items);
    if (!delivered && configured(env)) {
      const r = await pushToAll(env, buildLeadPayload(items));
      delivered += r.sent;
    }
    if (delivered > 0) {
      const uris = items.map((x) => x.p.uri);
      await env.DB.prepare("UPDATE posts SET notified = 1 WHERE uri IN (" + uris.map(() => "?").join(",") + ")").bind(...uris).run();
    }
  } catch (e) {}
}

export async function handlePush(request, env, ctx, path) {
  if (path === "/api/push/key" && request.method === "GET") {
    if (!configured(env)) return json({ error: "Push is not configured. Add VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT as secrets." }, 500);
    return json({ key: env.VAPID_PUBLIC_KEY });
  }

  if (path === "/api/push/subscribe" && request.method === "POST") {
    let b;
    try { b = await request.json(); } catch (e) { return json({ error: "Invalid JSON." }, 400); }
    const endpoint = b && b.endpoint;
    const p256dh = b && b.keys && b.keys.p256dh;
    const auth = b && b.keys && b.keys.auth;
    if (!validEndpoint(endpoint)) return json({ error: "Unsupported push endpoint." }, 400);
    if (typeof p256dh !== "string" || !B64U.test(p256dh) || p256dh.length < 80 || p256dh.length > 100) return json({ error: "Invalid p256dh key." }, 400);
    if (typeof auth !== "string" || !B64U.test(auth) || auth.length < 16 || auth.length > 30) return json({ error: "Invalid auth key." }, 400);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth").bind(endpoint, p256dh, auth, new Date().toISOString()),
      env.DB.prepare("DELETE FROM push_subscriptions WHERE id NOT IN (SELECT id FROM push_subscriptions ORDER BY id DESC LIMIT 5)")
    ]);
    return json({ ok: true });
  }

  if (path === "/api/push/test" && request.method === "POST") {
    const ntfyOn = ntfyConfigured(env);
    if (!configured(env) && !ntfyOn) return json({ error: "Notifications are not configured. Add NTFY_TOPIC (or the VAPID secrets)." }, 500);
    const delay = Math.min(Math.max(parseInt(new URL(request.url).searchParams.get("delay") || "0", 10) || 0, 0), 20);
    if (ntfyOn) {
      const msg = { title: "ClientRadar test", message: "If you can read this, ntfy notifications work.", priority: 4, tags: ["white_check_mark"] };
      if (delay > 0) {
        ctx.waitUntil((async () => {
          await new Promise((r) => setTimeout(r, delay * 1000));
          await ntfyPublish(env, msg);
        })());
        return json({ ok: true, ntfy: true, scheduledInSeconds: delay });
      }
      const r = await ntfyPublish(env, msg);
      return json({ ok: r.ok, ntfy: true, status: r.status });
    }
    const payload = { title: "ClientRadar test", body: "If you can read this, push notifications work.", url: "/" };
    if (delay > 0) {
      ctx.waitUntil((async () => {
        await new Promise((r) => setTimeout(r, delay * 1000));
        await pushToAll(env, payload);
      })());
      return json({ ok: true, scheduledInSeconds: delay });
    }
    return json(Object.assign({ ok: true }, await pushToAll(env, payload)));
  }

  return json({ error: "Not found" }, 404);
}
