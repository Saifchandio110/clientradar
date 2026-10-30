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

function configured(env) {
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

async function pushToAll(env, payload) {
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

// Called by the scanner with the posts that were newly saved in this scan. Never throws.
export async function notifyNew(env, items) {
  try {
    if (!items || !items.length || !configured(env)) return;
    const first = items[0];
    const p = first.p;
    const who = p.author_name || p.author_handle;
    const one = items.length === 1;
    const payload = {
      title: one ? first.s.intent.toUpperCase() + " lead: " + first.s.category : items.length + " new client leads",
      body: (one ? "" : "Latest: ") + who + ": " + String(p.text).replace(/\s+/g, " ").slice(0, 110),
      url: one && p.url ? p.url : "/"
    };
    const r = await pushToAll(env, payload);
    if (r.sent > 0) {
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
    if (!configured(env)) return json({ error: "Push is not configured. Add the VAPID secrets." }, 500);
    const delay = Math.min(Math.max(parseInt(new URL(request.url).searchParams.get("delay") || "0", 10) || 0, 0), 20);
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
